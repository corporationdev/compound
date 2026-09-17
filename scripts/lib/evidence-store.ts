import { S3Client } from 'bun';
import { evidence } from '@compound/config/evidence';
import { readEnv } from '../environment';

/**
 * The evidence bucket, with credentials from the process environment (CI)
 * or the checkout's injected Worker env (a developer machine after setup).
 * Any tier's R2 key is account-level, so all of them can write here.
 */
export function evidenceStore() {
  const local = readEnv('apps/server/.env');
  const get = (key: string) => process.env[key]?.trim() || local[key];
  const account = get('CLOUDFLARE_ACCOUNT_ID'), accessKeyId = get('R2_ACCESS_KEY_ID'), secretAccessKey = get('R2_SECRET_ACCESS_KEY');
  if (!account || !accessKeyId || !secretAccessKey)
    throw new Error('R2 credentials are missing: run `bun run setup` here, or export CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY');
  const client = new S3Client({ endpoint: `https://${account}.r2.cloudflarestorage.com`, accessKeyId, secretAccessKey, bucket: evidence.bucket });
  return {
    /** Upload a local file under the PR's prefix; returns its public URL. */
    async put(pullRequest: number, path: string, name = path.split('/').pop()!) {
      const key = `${evidence.prefix(pullRequest)}${name}`;
      const type = contentType(name);
      await client.file(key).write(Bun.file(path), { type });
      return { key, url: evidence.url(key), size: Bun.file(path).size, type };
    },
    /** Everything the bucket holds for a PR. */
    async list(pullRequest: number) {
      const listed = await client.list({ prefix: evidence.prefix(pullRequest), maxKeys: 1000 });
      return (listed.contents ?? []).map((o) => ({ key: o.key, size: o.size, url: evidence.url(o.key) }));
    },
    /** Remove a PR's files; safe when there are none. */
    async deletePrefix(pullRequest: number) {
      const objects = await this.list(pullRequest);
      for (const object of objects) await client.delete(object.key);
      return objects.length;
    },
  };
}

export function contentType(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return { webm: 'video/webm', mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', zip: 'application/zip', dmg: 'application/x-apple-diskimage' }[ext] ?? 'application/octet-stream';
}
