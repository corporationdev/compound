import { expect, test } from 'bun:test';
import { AssetLibrary } from '../src/library';
import type { ProjectFS } from '../src/fs';

function setup() {
  let manifest: unknown = { version: 1, folders: [], assets: [{ id: 'audio', type: 'AUDIO', path: 'song.m4a', source: 'assets/song.m4a', mimeType: 'audio/mp4', duration: 60, createdAt: '', sampleRate: 44100, channels: 2 }] };
  let fail = false;
  const fs: ProjectFS = {
    readManifest: async () => structuredClone(manifest),
    writeManifest: async value => { if (fail) throw new Error('Disk full'); manifest = structuredClone(value); },
    list: async () => [], stat: async () => null,
    file: async () => new File([], 'song.m4a'), write: async () => {}, remove: async () => {},
  };
  return { library: new AssetLibrary(fs), fail: (value: boolean) => { fail = value; } };
}
const source = { sourceId: 'remote', checksum: 'a'.repeat(64), kind: 'music' as const, title: 'Song', sourceRange: { sourceStartUs: 1000000, sourceEndUs: 4000000 } };

test('catalog provenance attaches to the current asset after a file-watcher reload and survives reopening', async () => {
  const { library } = setup();
  await library.load(); const imported = library.list()[0]!;
  await library.load();
  expect(library.list()[0]).not.toBe(imported);
  library.rememberCatalogSource(imported, source);
  expect(library.list()[0]!.catalogSources).toEqual([source]);
  await library.flush(); await library.load();
  expect(library.list()[0]!.catalogSources).toEqual([source]);
  await library.dispose();
});
test('explicit import flush reports disk failures and retries the unsaved provenance', async () => {
  const { library, fail } = setup();
  await library.load(); library.rememberCatalogSource(library.list()[0]!, source);
  fail(true); await expect(library.flush()).rejects.toThrow('Disk full');
  fail(false); await library.flush(); await library.load();
  expect(library.list()[0]!.catalogSources).toEqual([source]);
  await library.dispose();
});

test('re-probing unchanged audio preserves catalog provenance, while replacement bytes discard it', async () => {
  let manifest: unknown = null;
  const files = new Map<string, File>();
  let mtime = 1000.75;
  const fs: ProjectFS = {
    readManifest: async () => structuredClone(manifest),
    writeManifest: async value => { manifest = structuredClone(value); },
    list: async () => [], stat: async path => files.has(path) ? { size: files.get(path)!.size, mtime } : null,
    file: async path => files.get(path)!,
    write: async (path, blob) => { files.set(path, new File([blob], path, { type: blob.type, lastModified: Math.trunc(mtime) })); },
    remove: async () => {},
  };
  const wav = (amplitude: number) => {
    const bytes = new Uint8Array(44 + 8000 * 2), view = new DataView(bytes.buffer);
    const str = (offset: number, text: string) => bytes.set(new TextEncoder().encode(text), offset);
    str(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, bytes.length - 44, true);
    for (let i = 0; i < 8000; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / 10) * amplitude), true);
    return new Blob([bytes], { type: 'audio/wav' });
  };
  const library = new AssetLibrary(fs);
  await library.load(); const asset = await library.store(wav(1000), { name: 'song.wav' });
  library.rememberCatalogSource(asset, source); await library.flush();
  await library.load();
  expect(library.manifest().assets[0]!.catalogSources).toEqual([source]);
  expect(library.manifest().assets[0]!.stat?.mtime).toBe(1000.75);
  mtime = 2000.5; await fs.write(asset.source, wav(2000)); await library.load();
  expect(library.manifest().assets[0]!.id).not.toBe(asset.id);
  expect(library.manifest().assets[0]!.catalogSources).toBeUndefined();
  await library.dispose();
});
