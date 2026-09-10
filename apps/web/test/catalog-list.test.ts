import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { deleteDB } from 'idb';
import { InfiniteQueryObserver } from '@tanstack/solid-query';
import { PersistentQueryCache } from '../src/lib/query-cache';
import { catalogListKey, catalogListOptions } from '../src/lib/catalog-list';
import type { CatalogKind, CatalogList } from '@compound/backend/catalog';

const caches: PersistentQueryCache[] = [], names = new Set<string>(), cleanups: (() => void)[] = [];
const scope = 'development:alice';
async function cache(name = `catalog-queries-${crypto.randomUUID()}`) {
  names.add(name); const storage = new PersistentQueryCache(name); caches.push(storage); await storage.setScope(scope);
  return { storage, name };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const storage of caches.splice(0)) await storage.close();
  for (const name of names) await deleteDB(name);
  names.clear();
});
const page = (kind: CatalogKind, title = kind): CatalogList => ({ items: [{ sourceId: title, title, kind, provider: 'upload', inGlobalLibrary: false, inUserLibrary: true, status: 'ready' }], personalCursor: null, curatedCursor: null });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('each tab fetches on first open; leaving, returning, and switching cached tabs issue no requests', async () => {
  const { storage } = await cache(); const requests: CatalogKind[] = [];
  const request = async (kind: CatalogKind) => { requests.push(kind); return page(kind); };
  const options = (kind: CatalogKind, active: boolean) => catalogListOptions(scope, kind, '', active, request);
  const observer = new InfiniteQueryObserver(storage.client, options('music', false));
  cleanups.push(observer.subscribe(() => {}));
  await settle(); expect(requests).toEqual([]);
  observer.setOptions(options('music', true)); await observer.refetch();
  observer.setOptions(options('music', false)); await settle(); expect(requests).toEqual(['music']);
  observer.setOptions(options('sfx', true)); await observer.refetch();
  expect(requests).toEqual(['music', 'sfx']);
  observer.setOptions(options('music', true));
  expect(observer.getCurrentResult().data?.pages[0]?.items[0]?.kind).toBe('music');
  expect(observer.getCurrentResult().isFetching).toBe(false);
  observer.setOptions(options('sfx', true));
  expect(observer.getCurrentResult().data?.pages[0]?.items[0]?.kind).toBe('sfx');
  observer.setOptions(options('sfx', false)); observer.setOptions(options('sfx', true));
  await settle(); expect(requests).toEqual(['music', 'sfx']);
});

test('stale listings stay visible while a single background refresh replaces them', async () => {
  const { storage } = await cache(); let resolve!: (page: CatalogList) => void;
  const options = catalogListOptions(scope, 'sfx', '', true, () => new Promise(done => { resolve = done; }));
  storage.client.setQueryData(options.queryKey, { pages: [page('sfx', 'cached')], pageParams: [undefined] }, { updatedAt: Date.now() - 6 * 60 * 1000 });
  const observer = new InfiniteQueryObserver(storage.client, options);
  cleanups.push(observer.subscribe(() => {}));
  expect(observer.getCurrentResult().data?.pages[0]?.items[0]?.title).toBe('cached');
  expect(observer.getCurrentResult().isPending).toBe(false);
  expect(observer.getCurrentResult().isFetching).toBe(true);
  resolve(page('sfx', 'updated')); await settle();
  expect(observer.getCurrentResult().data?.pages[0]?.items[0]?.title).toBe('updated');
  expect(observer.getCurrentResult().isFetching).toBe(false);
});

test('in-flight first fetch finishes into the cache after leaving, without starting another request', async () => {
  const { storage } = await cache(); let calls = 0, resolve!: (page: CatalogList) => void;
  const request = () => { calls++; return new Promise<CatalogList>(done => { resolve = done; }); };
  const observer = new InfiniteQueryObserver(storage.client, catalogListOptions(scope, 'music', '', true, request));
  cleanups.push(observer.subscribe(() => {}));
  observer.setOptions(catalogListOptions(scope, 'music', '', false, request));
  resolve(page('music')); await settle();
  observer.setOptions(catalogListOptions(scope, 'music', '', true, request)); await settle();
  expect(calls).toBe(1); expect(observer.getCurrentResult().data?.pages).toHaveLength(1);
});

test('pagination is retained when switching away and back, with independent personal and curated cursors', async () => {
  const { storage } = await cache(); const cursors: unknown[] = [];
  const request = async (kind: CatalogKind, _query: string, cursor: unknown): Promise<CatalogList> => {
    cursors.push(cursor); return { ...page(kind, cursor ? 'second' : 'first'), curatedCursor: cursor ? null : 'next-page' };
  };
  const options = catalogListOptions(scope, 'music', '', true, request);
  const observer = new InfiniteQueryObserver(storage.client, options);
  cleanups.push(observer.subscribe(() => {})); await observer.refetch(); await observer.fetchNextPage();
  observer.setOptions({ ...options, enabled: false }); observer.setOptions(options); await settle();
  expect(observer.getCurrentResult().data?.pages).toHaveLength(2);
  expect(cursors).toEqual([undefined, { personalCursor: null, curatedCursor: 'next-page' }]);
});

test('query snapshots restore both tabs after reload without fetching fresh listings', async () => {
  const first = await cache();
  for (const kind of ['music', 'sfx'] as const) await first.storage.client.fetchInfiniteQuery(catalogListOptions(scope, kind, '', true, async type => page(type)));
  await first.storage.close();
  const next = await cache(first.name); let calls = 0;
  for (const kind of ['music', 'sfx'] as const) {
    const result = await next.storage.client.fetchInfiniteQuery(catalogListOptions(scope, kind, '', true, async type => { calls++; return page(type); }));
    expect(result.pages[0]?.items[0]?.kind).toBe(kind);
  }
  expect(calls).toBe(0);
});

test('search keys and accounts are isolated; upload invalidation refreshes active listings only', async () => {
  const { storage } = await cache(); const queries: string[] = [];
  const request = async (kind: CatalogKind, query: string) => { queries.push(query); return page(kind, query || 'all'); };
  const all = catalogListOptions(scope, 'music', '', true, request);
  await storage.client.fetchInfiniteQuery(all);
  await storage.client.fetchInfiniteQuery(catalogListOptions(scope, 'music', 'drums', true, request));
  const observer = new InfiniteQueryObserver(storage.client, all);
  cleanups.push(observer.subscribe(() => {}));
  await storage.client.invalidateQueries({ queryKey: catalogListKey(scope) });
  expect(queries).toEqual(['', 'drums', '']);
  observer.destroy();
  await storage.setScope('development:bob');
  expect(storage.client.getQueryData(all.queryKey)).toBeUndefined();
  await storage.client.fetchInfiniteQuery(catalogListOptions(storage.scope, 'music', '', true, request));
  await storage.flush(); await storage.setScope(scope);
  expect(storage.client.getQueryData(all.queryKey)).toBeDefined();
  expect(storage.client.getQueryData(catalogListOptions('development:bob', 'music', '', false, request).queryKey)).toBeUndefined();
});
