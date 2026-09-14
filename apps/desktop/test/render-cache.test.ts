import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lookupRenderCache, projectRenderHash, storeRenderCache } from '../src/render-cache';

const root = await mkdtemp(join(tmpdir(), 'compound-render-cache-'));
afterAll(() => rm(root, { recursive: true, force: true }));

async function project(name: string) {
  const dir = join(root, name);
  await mkdir(join(dir, 'assets'), { recursive: true });
  await mkdir(join(dir, 'exports'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(dir, 'index.tsx'), 'export default () => <stage />;');
  await writeFile(join(dir, 'assets', 'clip.mp4'), new Uint8Array(2048));
  await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'module.exports = 1');
  await writeFile(join(dir, 'exports', 'old.mp4'), new Uint8Array(16));
  return dir;
}

test('the hash follows sources, linked media and export settings, and ignores outputs and dependencies', async () => {
  const dir = await project('a');
  const linked = join(root, 'outside.mov');
  await writeFile(linked, new Uint8Array(4096));
  await writeFile(join(dir, 'assets.yml'), `version: 1\nassets:\n  - id: x\n    path: outside.mov\n    source: ${linked}\n`);
  const base = await projectRenderHash(dir, 'settings-1');
  expect(base).toMatch(/^[a-f0-9]{64}$/);
  expect(await projectRenderHash(dir, 'settings-1')).toBe(base);
  expect(await projectRenderHash(dir, 'settings-2')).not.toBe(base);

  // Our own exports and node_modules do not count.
  await writeFile(join(dir, 'exports', 'new.mp4'), new Uint8Array(32));
  await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'module.exports = 2');
  expect(await projectRenderHash(dir, 'settings-1')).toBe(base);

  // A source edit does.
  await writeFile(join(dir, 'index.tsx'), 'export default () => <stage><text /></stage>;');
  const edited = await projectRenderHash(dir, 'settings-1');
  expect(edited).not.toBe(base);

  // So does a linked file changing under the same path.
  await utimes(linked, new Date(), new Date(Date.now() + 60_000));
  expect(await projectRenderHash(dir, 'settings-1')).not.toBe(edited);
});

test('a cached export is only returned while the hash and the file still match', async () => {
  const dir = await project('b');
  const { hash, cached } = await lookupRenderCache({ dir, name: 'main-post', extra: 's' });
  expect(cached).toBeNull();
  const path = join(dir, 'exports', 'main-post.mp4');
  await writeFile(path, new Uint8Array(100));
  await storeRenderCache(dir, 'main-post', { hash, path, size: 0, durationMs: 1000, width: 1080, height: 1920, renderedAt: 1 });
  const hit = await lookupRenderCache({ dir, name: 'main-post', extra: 's' });
  expect(hit.cached).toMatchObject({ hash, path, size: 100, durationMs: 1000 });
  // Different settings: miss. Edited source: miss. File replaced with another size: miss.
  expect((await lookupRenderCache({ dir, name: 'main-post', extra: 'other' })).cached).toBeNull();
  await writeFile(join(dir, 'index.tsx'), 'changed');
  expect((await lookupRenderCache({ dir, name: 'main-post', extra: 's' })).cached).toBeNull();
  await writeFile(join(dir, 'index.tsx'), 'export default () => <stage />;');
  await writeFile(path, new Uint8Array(101));
  expect((await lookupRenderCache({ dir, name: 'main-post', extra: 's' })).cached).toBeNull();
});
