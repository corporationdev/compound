import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { PUBLIC_CATALOG } from '../packages/backend/catalog_manifest';
import { catalogManifestSource, validatePublicCatalog } from '../packages/backend/convex/catalog_manifest';
import { root, scopedEnv, stageFrom } from './environment';
import { convexTarget } from './convex-target';

export const catalogRevision = () => createHash('sha256').update(JSON.stringify(PUBLIC_CATALOG)).digest('hex');
export async function publishCatalog(stage: string) {
  const env = scopedEnv('packages/backend', stage);
  const target = convexTarget(stage, env.CONVEX_DEPLOY_KEY, env.CONVEX_URL);
  validatePublicCatalog(PUBLIC_CATALOG, ['music', 'sfx']);
  const invoke = <T>(name: string, input: unknown): Promise<T> => new Promise((resolveResult, reject) => {
    const child = spawn(resolve(root, 'node_modules/.bin/convex'), ['run', ...(target.preview ? ['--preview-name', stage] : []), name, JSON.stringify(input)], {
      cwd: resolve(root, 'packages/backend'),
      env: { ...process.env, CONVEX_DEPLOYMENT: '', CONVEX_DEPLOY_KEY: env.CONVEX_DEPLOY_KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { reject(new Error(`Catalog ${name} failed: ${errors.slice(-2000)}`)); return; }
      // convex run intentionally prints nothing for null/void responses.
      try { resolveResult((output.trim() ? JSON.parse(output) : null) as T); } catch { reject(new Error(`Invalid response from ${name}`)); }
    });
  });
  const revision = catalogRevision();
  if (await invoke<string | null>('catalog:publishedRevision', {}) === revision) {
    console.log(`Catalog unchanged (${PUBLIC_CATALOG.length} items).`); return;
  }
  // Workers own durable preparation; the deploy only waits for their state.
  for (let offset = 0; offset < PUBLIC_CATALOG.length; offset += 3) {
    await Promise.all(PUBLIC_CATALOG.slice(offset, offset + 3).map(async item => {
      const sourceId = await invoke<string>('catalog:ensureForDeploy', { ...catalogManifestSource(item.sourceUrl), title: item.title });
      await invoke('catalog:prepareForDeploy', { sourceId });
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const source = await invoke<{ status: string; error?: string; errorDetail?: string }>('catalog:context', { sourceId });
        if (source.status === 'ready') { console.log(`Ready: ${item.title}`); return; }
        if (source.status === 'failed') throw new Error(`Catalog preparation failed for ${item.title}: ${source.errorDetail ?? source.error}`);
        await new Promise(resolveWait => setTimeout(resolveWait, 5000));
      }
      throw new Error(`Catalog preparation timed out for ${item.title}; the previous catalog remains published.`);
    }));
  }
  const result = await invoke<{ count: number }>('catalog_actions:reconcile', { revision, items: PUBLIC_CATALOG });
  console.log(`Published ${result.count} catalog items to ${stage}.`);
}
if (import.meta.main) await publishCatalog(stageFrom(process.argv.slice(2)));
