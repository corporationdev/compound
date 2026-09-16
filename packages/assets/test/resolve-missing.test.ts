import { expect, test } from 'bun:test';
import { AssetLibrary } from '../src/library';
import type { ProjectFS } from '../src/fs';
import type { AssetFileHandle, AssetRecord } from '../src';

// An asset whose source is on another machine: the library keeps the record
// as it is (the manifest is shared) and takes its bytes from the resolver.

const record = { id: 'abcdefabcdefabcd', type: 'AUDIO', path: 'song.m4a', source: '/Users/teammate/song.m4a', mimeType: 'audio/mp4', duration: 60, createdAt: '', sampleRate: 44100, channels: 2, stat: { size: 10, mtime: 1 } };
const remote = { id: 'ffffffffffffffff', type: 'IMAGE', path: 'logo.png', source: 'https://example.com/logo.png', mimeType: 'image/png', width: 1, height: 1, createdAt: '' };

function setup(present: boolean) {
  let manifest: unknown = { version: 1, folders: [], assets: [record, remote] };
  const local = new File(['local'], 'song.m4a');
  const fs: ProjectFS = {
    readManifest: async () => structuredClone(manifest),
    writeManifest: async value => { manifest = structuredClone(value); },
    list: async () => [],
    stat: async source => present && source === record.source ? { size: 10, mtime: 1 } : null,
    file: async () => local,
    write: async () => {}, remove: async () => {},
  };
  return { fs, local };
}

test('a missing source is attached through the resolver without changing the record', async () => {
  const { fs } = setup(false);
  const cloud = new File(['cloud'], 'song.m4a');
  const asked: AssetRecord[] = [];
  const handle: AssetFileHandle = { getFile: async () => cloud };
  const library = new AssetLibrary(fs, { resolveMissing: async r => { asked.push(r); return handle; } });
  await library.load();
  const asset = library.get('song.m4a')!;
  expect(asked.map(r => r.id)).toEqual([record.id]);
  expect(asset.source).toBe(record.source);
  expect(await library.file(asset)).toBe(cloud);
  expect(library.hasLocalBytes(record.id)).toBe(false);
  expect(library.hasLocalBytes(remote.id)).toBe(false);
  expect(library.manifest().assets.find(a => a.id === record.id)).toEqual(record);
  await library.dispose();
});

test('a resolver that has nothing leaves the asset on its absent source', async () => {
  const { fs, local } = setup(false);
  const library = new AssetLibrary(fs, { resolveMissing: async () => null });
  await library.load();
  const asset = library.get('song.m4a')!;
  expect(await library.file(asset)).toBe(local);
  expect(library.hasLocalBytes(record.id)).toBe(false);
  await library.dispose();
});

test('a source found here is local and never asks the resolver; the resolver can be installed after construction', async () => {
  const { fs, local } = setup(true);
  let asked = 0;
  const library = new AssetLibrary(fs);
  library.setMissingResolver(async () => { asked++; return { getFile: async () => new File([], 'x') }; });
  await library.load();
  expect(asked).toBe(0);
  expect(library.hasLocalBytes(record.id)).toBe(true);
  expect(await library.file(library.get('song.m4a')!)).toBe(local);
  await library.dispose();
});
