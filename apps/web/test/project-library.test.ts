import { expect, test } from 'bun:test';
import { AssetLibrary } from '@compound/assets';
import { createProjectLibraryRunner } from '../src/context/dapi/project-library';
import type { ProjectFS } from '@compound/assets';

test('concurrent detached project writers reload the latest manifest, isolate projects, and recover after a failed request', async () => {
  const manifests = new Map<string, unknown>();
  const created: AssetLibrary[] = [];
  const runner = createProjectLibraryRunner({ attached: async () => null, create: dir => {
    const fs: ProjectFS = { readManifest: async () => manifests.get(dir) ?? { version: 1, folders: [], assets: [] }, writeManifest: async data => { manifests.set(dir, structuredClone(data)); }, list: async () => [], stat: async () => null, file: async () => new File([], ''), write: async () => {}, remove: async () => {} };
    const library = new AssetLibrary(fs); created.push(library); return library;
  } });
  const order: string[] = [];
  let release!: () => void;
  const first = runner('/a', async library => { order.push('first'); await new Promise<void>(done => { release = done; }); library.createFolder('first'); await library.flush(); });
  await new Promise(resolve => setTimeout(resolve, 0));
  const second = runner('/a', async library => { order.push('second'); expect(library.manifest().folders).toContain('first'); library.createFolder('second'); await library.flush(); });
  await runner('/b', async library => { expect(library.manifest().folders).toEqual([]); library.createFolder('other'); await library.flush(); });
  expect(order).toEqual(['first']); release(); await Promise.all([first, second]);
  await expect(runner('/a', async () => { throw new Error('request failed'); })).rejects.toThrow('request failed');
  await runner('/a', async library => { expect(library.manifest().folders).toEqual(['first', 'second']); });
  expect(created.every(library => library.closed)).toBe(true);
});

test('attached project uses the existing library and leaves its lifetime with the editor', async () => {
  const attached = { marker: true } as unknown as AssetLibrary;
  const runner = createProjectLibraryRunner({ attached: async dir => dir === '/a' ? attached : null, create: () => { throw new Error('must not create a second writer'); } });
  expect(await runner('/a', async library => library)).toBe(attached);
});
