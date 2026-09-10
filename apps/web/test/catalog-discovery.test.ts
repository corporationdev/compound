import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/solid-query';
import { browseCatalog, catalogSearchInput, catalogSelection } from '../src/lib/catalog-discovery';
import { catalogListOptions } from '../src/lib/catalog-list';
import type { CatalogItem, CatalogList } from '@compound/backend/catalog';

const item = (sourceId: string, personal = false): CatalogItem => ({ sourceId, title: sourceId, kind: 'music', provider: 'upload', status: 'ready', inUserLibrary: personal, inGlobalLibrary: !personal });
const cache = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300000, gcTime: Infinity } } });

test('omitted, empty, and whitespace searches browse; external discovery requires a real query', () => {
  for (const query of [undefined, '', ' \n\t ']) expect(catalogSearchInput({ kind: 'music', query })).toEqual({ kind: 'music', query: '', expand: false });
  for (const query of ['', ' ', 'a']) expect(() => catalogSearchInput({ kind: 'sfx', query, expand: true })).toThrow('--expand needs');
  expect(() => catalogSearchInput({ kind: 'video' as 'music' })).toThrow('--kind');
  expect(() => catalogSearchInput({ kind: 'music', query: 'x'.repeat(121) })).toThrow('120');
});

test('browse collects over 50 items, exhausts both independent cursors, and keeps personal descriptions', async () => {
  const client = cache(); const cursors: unknown[] = [];
  const request = async (_kind: unknown, query: string, cursor?: { personalCursor: string | null; curatedCursor: string | null }): Promise<CatalogList> => {
    expect(query).toBe(''); cursors.push(cursor);
    if (!cursor) return { items: [item('shared', true), ...Array.from({ length: 30 }, (_, i) => item(`first-${i}`))], personalCursor: 'personal-2', curatedCursor: 'public-2' };
    if (cursor.curatedCursor === 'public-2') return { items: [item('shared'), ...Array.from({ length: 30 }, (_, i) => item(`second-${i}`))], personalCursor: null, curatedCursor: 'public-3' };
    expect(cursor.personalCursor).toBeNull();
    return { items: [item('last')], personalCursor: null, curatedCursor: null };
  };
  try {
    const first = await browseCatalog(client, 'alice', 'music', '', request);
    expect(first).toHaveLength(62); expect(first.find(i => i.sourceId === 'shared')?.inUserLibrary).toBe(true);
    expect(cursors).toEqual([undefined, { personalCursor: 'personal-2', curatedCursor: 'public-2' }, { personalCursor: null, curatedCursor: 'public-3' }]);
    expect(await browseCatalog(client, 'alice', 'music', '', request)).toEqual(first);
    expect(cursors).toHaveLength(3);
  } finally { client.clear(); }
});

test('CLI completes a partial UI cache without fetching its fresh first page again', async () => {
  const client = cache(); const calls: unknown[] = [];
  const request = async (_kind: unknown, _query: string, cursor: unknown): Promise<CatalogList> => { calls.push(cursor); return { items: [item('second')], personalCursor: null, curatedCursor: null }; };
  const options = catalogListOptions('alice', 'music', '', true, request);
  client.setQueryData(options.queryKey, { pages: [{ items: [item('first')], personalCursor: null, curatedCursor: 'next' }], pageParams: [undefined] });
  try {
    expect((await browseCatalog(client, 'alice', 'music', '', request)).map(i => i.sourceId)).toEqual(['first', 'second']);
    expect(calls).toEqual([{ personalCursor: null, curatedCursor: 'next' }]);
    expect(client.getQueryData<{ pages: unknown[] }>(options.queryKey)?.pages).toHaveLength(2);
  } finally { client.clear(); }
});

test('browse reports page failures instead of returning an incomplete success and accounts have separate caches', async () => {
  const client = cache(); let fail = true;
  const request = async (_kind: unknown, _query: string, cursor: unknown): Promise<CatalogList> => {
    if (!cursor) return { items: [item('first')], personalCursor: 'next', curatedCursor: null };
    if (fail) throw new Error('Page unavailable');
    return { items: [item('last')], personalCursor: null, curatedCursor: null };
  };
  try {
    await expect(browseCatalog(client, 'alice', 'music', '', request)).rejects.toThrow('Page unavailable');
    fail = false; expect(await browseCatalog(client, 'alice', 'music', '', request)).toHaveLength(2);
    const bob = await browseCatalog(client, 'bob', 'music', '', async () => ({ items: [item('bob')], personalCursor: null, curatedCursor: null }));
    expect(bob.map(i => i.sourceId)).toEqual(['bob']);
  } finally { client.clear(); }
});

test('selection preserves detailed guidance, fractional ranges, and unknown duration without exposing provider URLs', () => {
  const selection = catalogSelection({ ...item('one'), description: 'Quiet piano. Avoid comedy.', durationUs: 11000000, sourceRange: { sourceStartUs: 50000, sourceEndUs: 420000 } });
  expect(selection).toEqual({ sourceId: 'one', title: 'one', kind: 'music', description: 'Quiet piano. Avoid comedy.', duration: 11, sourceRange: { start: 0.05, end: 0.42 }, selectedDuration: 0.37, status: 'ready' });
  expect(catalogSelection(item('two'))).not.toHaveProperty('duration');
  expect(selection).not.toHaveProperty('provider');
});
