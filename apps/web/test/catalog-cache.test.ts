import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { deleteDB, openDB } from 'idb';
import { LocalMediaCache } from '../src/lib/local-media-cache';
import { createCatalogFileLoader, createCatalogArtworkLoader, type LocalCatalogMedia, type CatalogArtworkMetadata } from '../src/lib/catalog-cache';
import { CatalogPreviewPlayer, type PreviewState } from '../src/lib/catalog-preview';
import type { CatalogItem } from '@compound/backend/catalog';

const names = new Set<string>(), caches: { close(): Promise<void> }[] = [];
function cache(options: { name?: string; memoryBytes?: number; diskBytes?: number; warn?: (error: unknown) => void } = {}) {
  const name = options.name ?? `catalog-test-${crypto.randomUUID()}`;
  names.add(name);
  const value = new LocalMediaCache<LocalCatalogMedia>({ ...options, name });
  value.setScope('development:alice'); caches.push(value);
  return { cache: value, name };
}
afterEach(async () => {
  for (const value of caches.splice(0)) await value.close();
  for (const name of names) await deleteDB(name);
  names.clear();
});
const item = (sourceId: string): CatalogItem => ({ sourceId, title: sourceId, kind: 'music', provider: 'youtube', status: 'ready', durationUs: 10e6, inUserLibrary: false, inGlobalLibrary: true });
function loader(storage: LocalMediaCache<LocalCatalogMedia>) {
  let preparations = 0, downloads = 0;
  const load = createCatalogFileLoader(storage, {
    prepare: async id => { preparations++; return item(id); },
    download: async id => { downloads++; return { blob: new Blob([id]), media: { item: item(id), checksum: id, url: 'https://example.com/temporary-secret', mimeType: 'audio/mp4', extension: 'm4a' } }; },
  });
  return { load, counts: () => ({ preparations, downloads }) };
}
class Audio {
  currentTime = 0; duration = 10; paused = true; src = ''; plays = 0;
  onloadedmetadata?: () => void; onplaying?: () => void; onpause?: () => void;
  async play() { this.paused = false; this.plays++; }
  pause() { this.paused = true; this.onpause?.(); }
  load() {}
  removeAttribute() {}
}

test('switching songs and reopening the player reuse bytes; Add shares the same loader', async () => {
  const { cache: storage } = cache();
  const { load, counts } = loader(storage);
  const audio = new Audio();
  const player = new CatalogPreviewPlayer(() => {}, { load, audio: () => audio as unknown as HTMLAudioElement, beforePlay() {}, ready() {} });
  try {
    await player.prepare(item('song-a')); audio.onloadedmetadata?.(); audio.onplaying?.();
    const original = player.state.blob;
    await player.prepare(item('song-b'));
    await player.prepare(item('song-a')); audio.onloadedmetadata?.(); audio.onplaying?.();
    expect(player.state.blob).toBe(original);
    expect(player.state.playing).toBe(true);
    player.stop();
    await player.prepare(item('song-a'));
    const imported = await load('song-a');
    expect(imported.blob).toBe(original);
    expect(counts()).toEqual({ preparations: 2, downloads: 2 });
  } finally { player.stop(); }
});

test('reopening the database serves persisted blobs without preparation or download; signed URLs are not stored', async () => {
  const first = cache(); const initial = loader(first.cache);
  await initial.load('song-a'); await first.cache.close();
  const next = cache({ name: first.name }); const restored = loader(next.cache);
  const result = await restored.load('song-a');
  expect(await result.blob.text()).toBe('song-a');
  expect(result.media.item.sourceId).toBe('song-a');
  expect('url' in result.media).toBe(false);
  expect(restored.counts()).toEqual({ preparations: 0, downloads: 0 });
  const db = await openDB(first.name);
  expect(JSON.stringify(await db.getAll('sources'))).not.toContain('temporary-secret');
  db.close();
});

test('memory and IndexedDB playback never emit loading UI, including metadata and playback start', async () => {
  const first = cache(); const initial = loader(first.cache);
  await initial.load('song-a');
  const verify = async (load: ReturnType<typeof loader>['load']) => {
    const states: PreviewState[] = [], audio = new Audio();
    const player = new CatalogPreviewPlayer(state => states.push(state), { load, audio: () => audio as unknown as HTMLAudioElement, beforePlay() {}, ready() {} });
    try {
      await player.prepare(item('song-a'));
      audio.onloadedmetadata?.(); audio.onplaying?.();
      expect(player.state.playing).toBe(true);
      expect(player.state.blob).toBeDefined();
      expect(states.some(state => state.preparing || state.progress !== undefined || state.stage !== '')).toBe(false);
    } finally { player.stop(); }
  };
  await verify(initial.load);
  expect(initial.counts()).toEqual({ preparations: 1, downloads: 1 });
  await first.cache.close();
  const reopened = loader(cache({ name: first.name }).cache);
  await verify(reopened.load);
  expect(reopened.counts()).toEqual({ preparations: 0, downloads: 0 });
});

test('uncached playback shows loading even when it joins a download already started by Add', async () => {
  const { cache: storage } = cache();
  let release!: () => void, started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const load = createCatalogFileLoader(storage, {
    prepare: async id => { started(); await hold; return item(id); },
    download: async id => ({ blob: new Blob([id]), media: { item: item(id), checksum: id, url: '', mimeType: 'audio/mp4', extension: 'm4a' } }),
  });
  const added = load('song-a'); await beginning;
  const audio = new Audio();
  const player = new CatalogPreviewPlayer(() => {}, { load, audio: () => audio as unknown as HTMLAudioElement, beforePlay() {}, ready() {} });
  try {
    const preview = player.prepare(item('song-a'));
    expect(player.state.preparing).toBe(true);
    expect(player.state.progress).toBe(0);
    release(); await added; await preview;
    audio.onloadedmetadata?.(); expect(player.state.preparing).toBe(true);
    audio.onplaying?.(); expect(player.state.preparing).toBe(false); expect(player.state.progress).toBe(1);
  } finally { release(); player.stop(); }
});

test('simultaneous preview and Add share a single preparation and download', async () => {
  const { cache: storage } = cache(); const { load, counts } = loader(storage);
  const [preview, added, reopened] = await Promise.all([load('song-a'), load('song-a'), load('song-a')]);
  expect(preview.blob).toBe(added.blob); expect(added.blob).toBe(reopened.blob);
  expect(counts()).toEqual({ preparations: 1, downloads: 1 });
});

test('canceling one consumer does not cancel another consumer or poison the shared cache', async () => {
  const { cache: storage } = cache();
  let release!: () => void, started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  let downloads = 0;
  const load = createCatalogFileLoader(storage, {
    prepare: async id => { started(); await hold; return item(id); },
    download: async id => { downloads++; return { blob: new Blob([id]), media: { item: item(id), checksum: id, url: '', mimeType: 'audio/mp4', extension: 'm4a' } }; },
  });
  const controller = new AbortController();
  const preview = load('song-a', undefined, controller.signal);
  const aborted = preview.catch(error => error);
  await beginning;
  const added = load('song-a'); controller.abort(); release();
  expect((await aborted).name).toBe('AbortError'); await added;
  expect(await (await load('song-a')).blob.text()).toBe('song-a');
  expect(downloads).toBe(1);
});

test('account and environment scopes are isolated, including requests completed after sign-out', async () => {
  const { cache: storage } = cache(); const { load, counts } = loader(storage);
  await load('song-a'); await storage.flush();
  storage.setScope('development:bob'); await load('song-a');
  storage.setScope('production:alice'); await load('song-a');
  expect(counts()).toEqual({ preparations: 3, downloads: 3 });
  storage.setScope('development:alice'); await load('song-a');
  expect(counts().downloads).toBe(3);
  const hit = load('song-a'); storage.setScope(null);
  await expect(hit).rejects.toHaveProperty('name', 'AbortError');
  await expect(load('song-a')).rejects.toThrow('Sign in required');

  storage.setScope('development:alice');
  let release!: () => void, started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const request = storage.ensure('in-flight', async () => { started(); await hold; return { blob: new Blob(['old-account']), checksum: 'old', metadata: { item: item('in-flight'), checksum: 'old', mimeType: 'audio/mp4', extension: 'm4a' } }; });
  const canceled = request.catch(error => error);
  await beginning; storage.setScope(null); release(); expect((await canceled).name).toBe('AbortError');
  storage.setScope('development:alice'); await load('in-flight');
  expect(counts().downloads).toBe(4);
});

test('failed downloads can be retried and are never cached', async () => {
  const { cache: storage } = cache();
  let attempts = 0;
  const load = createCatalogFileLoader(storage, {
    prepare: async id => item(id),
    download: async id => {
      if (++attempts === 1) throw new Error('Audio download is incomplete. Retry.');
      return { blob: new Blob([id]), media: { item: item(id), checksum: id, url: '', mimeType: 'audio/mp4', extension: 'm4a' } };
    },
  });
  await expect(load('song-a')).rejects.toThrow('incomplete');
  await load('song-a'); await load('song-a'); expect(attempts).toBe(2);
});

test('disk storage deduplicates by checksum and evicts least recently used files with their aliases', async () => {
  const first = cache({ memoryBytes: 4, diskBytes: 8 });
  const media = (sourceId: string, checksum = sourceId) => ({ blob: new Blob(['1234']), checksum, metadata: { item: item(sourceId), checksum, mimeType: 'audio/mp4', extension: 'm4a' } });
  await first.cache.ensure('aaaa', async () => media('aaaa')); await first.cache.flush();
  await first.cache.ensure('bbbb', async () => media('bbbb')); await first.cache.flush();
  await first.cache.ensure('alias', async () => media('alias', 'bbbb')); await first.cache.flush();
  const db = await openDB(first.name);
  expect(await db.count('files')).toBe(2);
  await first.cache.ensure('cccc', async () => media('cccc')); await first.cache.flush();
  expect(await db.count('files')).toBe(2);
  expect(await db.get('sources', ['development:alice', 'aaaa'])).toBeUndefined();
  expect(await db.get('sources', ['development:alice', 'alias'])).toBeDefined();
  expect(await db.get('meta', 'bytes')).toBe(8);
  db.close();
});

test('blocked IndexedDB still allows same-session replay through the memory cache', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')!;
  let warnings = 0;
  const { cache: storage } = cache({ warn: () => { warnings++; } }); const { load, counts } = loader(storage);
  try {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    await load('song-a'); await load('song-b'); await load('song-a'); await storage.flush();
    expect(counts()).toEqual({ preparations: 2, downloads: 2 });
    expect(warnings).toBe(1);
  } finally { Object.defineProperty(globalThis, 'indexedDB', descriptor); }
});

function artworkCache(name = `artwork-test-${crypto.randomUUID()}`) {
  names.add(name);
  const storage = new LocalMediaCache<CatalogArtworkMetadata>({ name });
  storage.setScope('development:alice'); caches.push(storage);
  return { storage, name };
}

test('scrolling back to artwork and mounting a preview share one endpoint request and image download', async () => {
  const { storage } = artworkCache(); let requests = 0;
  const jpeg = new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' });
  const load = createCatalogArtworkLoader(storage, async () => { requests++; return jpeg; });
  const [row, dock] = await Promise.all([load('song-a'), load('song-a')]);
  expect(row).toBe(dock);
  for (let scroll = 0; scroll < 20; scroll++) expect(await load('song-a')).toBe(jpeg);
  expect(requests).toBe(1);
});

test('artwork bytes and confirmed missing images survive reload without asking for another signed URL', async () => {
  const first = artworkCache(); let requests = 0;
  const load = createCatalogArtworkLoader(first.storage, async id => { requests++; return id === 'missing' ? null : new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }); });
  await load('song-a'); expect(await load('missing')).toBeNull(); await first.storage.close();
  const restored = artworkCache(first.name);
  const reopen = createCatalogArtworkLoader(restored.storage, async () => { throw new Error('Unexpected artwork request after reload'); });
  expect((await reopen('song-a'))?.type).toBe('image/jpeg');
  expect((await reopen('song-a'))?.size).toBe(4);
  expect(await reopen('missing')).toBeNull();
  expect(requests).toBe(2);
});

test('artwork request errors can retry, rather than caching a permanent missing thumbnail', async () => {
  const { storage } = artworkCache(); let requests = 0;
  const load = createCatalogArtworkLoader(storage, async () => {
    if (++requests === 1) throw new Error('Artwork request failed');
    return new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' });
  });
  await expect(load('song-a')).rejects.toThrow('Artwork request failed');
  await load('song-a'); await load('song-a'); expect(requests).toBe(2);
});
