import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import type { GlobalDBSchema, ProjectRoot } from '../src/lib/db';
import { migrateLegacyDatabase } from '../src/lib/db-migration';

const connections: IDBPDatabase<GlobalDBSchema>[] = [];
async function database(name: string) {
  const db = await openDB<GlobalDBSchema>(name, 3, { upgrade(db) {
    const roots = db.createObjectStore('roots', { keyPath: 'id' });
    roots.createIndex('by-path', 'path', { unique: true });
    roots.createIndex('by-last-used', 'lastUsedAt');
    db.createObjectStore('bundles', { keyPath: 'projectId' });
    db.createObjectStore('meta');
  } });
  connections.push(db);
  return db;
}
const root = (id: string, path: string): ProjectRoot => ({ id, path, name: id, kind: 'multi', createdAt: '2026-01-01', lastUsedAt: '2026-01-01' });
afterEach(async () => {
  for (const db of connections.splice(0)) db.close();
  await deleteDB('compound-idb');
  await deleteDB('diffusion-studio-idb');
});

test('saved roots and compiled bundles migrate once; forgetting a project stays forgotten', async () => {
  const old = await database('diffusion-studio-idb');
  await old.put('roots', root('project', '/Movies/old-projects'));
  await old.put('bundles', { projectId: 'project', code: 'old JSX bundle', updatedAt: '2026-01-01' });
  const next = await database('compound-idb');
  await migrateLegacyDatabase(next);
  expect((await next.get('roots', 'project'))?.path).toBe('/Movies/old-projects');
  expect((await next.get('bundles', 'project'))?.code).toBe('old JSX bundle');
  expect(await old.count('roots')).toBe(1);
  await next.delete('roots', 'project');
  await migrateLegacyDatabase(next);
  expect(await next.count('roots')).toBe(0);
});

test('migration keeps Compound records when IDs or paths already exist', async () => {
  const old = await database('diffusion-studio-idb');
  await old.put('roots', root('same-id', '/Movies/old'));
  await old.put('roots', root('old-id', '/Movies/shared'));
  await old.put('bundles', { projectId: 'same-id', code: 'old', updatedAt: '2026-01-01' });
  const next = await database('compound-idb');
  await next.put('roots', root('same-id', '/Movies/current'));
  await next.put('roots', root('new-id', '/Movies/shared'));
  await next.put('bundles', { projectId: 'same-id', code: 'new', updatedAt: '2026-01-02' });
  await migrateLegacyDatabase(next);
  expect(await next.count('roots')).toBe(2);
  expect((await next.get('roots', 'same-id'))?.path).toBe('/Movies/current');
  expect((await next.get('bundles', 'same-id'))?.code).toBe('new');
});

test('a clean install never creates the legacy database', async () => {
  const next = await database('compound-idb');
  await migrateLegacyDatabase(next);
  expect((await indexedDB.databases()).map((entry) => entry.name)).toEqual(['compound-idb']);
});
