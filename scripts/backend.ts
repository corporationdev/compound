import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getStageKind } from '@compound/config/stage';
import { root, stageFrom, scopedEnv, requireKeys, renderEnv } from './environment';
import { convexTarget, validateProjectPreviewKey } from './convex-target';

const args = process.argv.slice(2);
const action = args[0];
if (!['sync', 'deploy', 'dev', 'preview'].includes(action ?? '')) throw new Error('Expected sync, deploy, dev, or preview');
const stage = stageFrom(args);
const backend = scopedEnv('packages/backend', stage);
requireKeys(backend, ['CONVEX_DEPLOY_KEY', 'BETTER_AUTH_SECRET', 'RESEND_API_KEY']);
if (action === 'preview') validateProjectPreviewKey(stage, backend.CONVEX_DEPLOY_KEY);
const target = action === 'preview' ? { preview: true }
  : convexTarget(stage, backend.CONVEX_DEPLOY_KEY, backend.CONVEX_URL);
if (action !== 'preview') requireKeys(backend, ['CONVEX_URL', 'SITE_URL', 'RESEND_FROM_EMAIL']);
if (backend.BETTER_AUTH_SECRET.length < 32) throw new Error('BETTER_AUTH_SECRET needs at least 32 random characters');
const run = (command: string[], quiet = false) => {
  const result = spawnSync(resolve(root, 'node_modules/.bin/convex'), command, {
    cwd: resolve(root, 'packages/backend'),
    env: { ...process.env, STAGE: stage, CONVEX_DEPLOYMENT: '', CONVEX_DEPLOY_KEY: backend.CONVEX_DEPLOY_KEY },
    stdio: quiet ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) throw new Error(`Convex ${command[0]} failed (exit ${result.status})`);
};
if (action === 'preview') {
  run(['deploy', '--yes', '--preview-name', stage, '--cmd-url-env-var-name', 'CONVEX_URL', '--cmd', 'bun ../../scripts/preview-runtime.ts']);
} else if (action === 'sync') {
  const temporary = mkdtempSync(resolve(tmpdir(), 'compound-convex-'));
  try {
    const file = resolve(temporary, 'runtime.env');
    const keys = ['SITE_URL', 'BETTER_AUTH_SECRET', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL'];
    writeFileSync(file, renderEnv(Object.fromEntries(keys.map((key) => [key, backend[key]]))), { mode: 0o600 });
    run(['env', 'set', ...(target.preview ? ['--preview-name', stage] : []), '--from-file', file, '--force'], true);
    console.log(`Synced Convex runtime environment for ${stage}.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
} else {
  if (action === 'dev' && getStageKind(stage) !== 'dev') throw new Error('Live development requires a dev stage');
  run([action!, ...(action === 'deploy' ? ['--yes', ...(target.preview ? ['--preview-name', stage] : [])] : [])]);
}
