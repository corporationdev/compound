import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, type IDBPDatabase } from 'idb';
import type { GlobalDBSchema, ProjectRecord } from '../src/lib/db';
import { migrateLegacyDatabase } from '../src/lib/db-migration';

const connections: IDBPDatabase<GlobalDBSchema>[] = [];

/** The Diffusion Studio database as it was last written: `roots`, `bundles`, `meta`. */
async function legacyDatabase() {
  const db = await openDB<GlobalDBSchema>('diffusion-studio-idb', 3, { upgrade(db) {
    const roots = db.createObjectStore('roots' as never, { keyPath: 'id' });
    roots.createIndex('by-path', 'path', { unique: true });
    roots.createIndex('by-last-used', 'lastUsedAt');
    db.createObjectStore('bundles', { keyPath: 'projectId' });
    db.createObjectStore('meta');
  } });
  connections.push(db);
  return db;
}

/** The Compound database at its current schema: project records instead of roots. */
async function database() {
  const db = await openDB<GlobalDBSchema>('compound-idb', 4, { upgrade(db) {
    db.createObjectStore('meta');
    db.createObjectStore('bundles', { keyPath: 'projectId' });
    const projects = db.createObjectStore('projects', { keyPath: 'dir' });
    projects.createIndex('by-id', 'id');
    projects.createIndex('by-last-opened', 'lastOpenedAt');
  } });
  connections.push(db);
  return db;
}

type LegacyRoot = { id: string; path: string; name: string; kind: 'multi' | 'single'; createdAt: string; lastUsedAt: string };
const root = (id: string, path: string, kind: LegacyRoot['kind'] = 'single'): LegacyRoot =>
  ({ id, path, name: id, kind, createdAt: '2026-01-01', lastUsedAt: '2026-01-02' });
const record = (dir: string, id: string): ProjectRecord => ({
  dir, id, name: id, displayName: id, entry: 'index.tsx',
  modifiedAt: '2026-02-01', createdAt: '2026-02-01', recordedAt: '2026-02-01', lastOpenedAt: '2026-02-01', cover: null,
});
const putRoot = (db: IDBPDatabase<GlobalDBSchema>, value: LegacyRoot) => db.put('roots' as never, value as never);

// Every test starts from an empty IndexedDB of its own. Other test files in
// this process (the app's db module, for one) hold `compound-idb` open at a
// newer version, which would make opening it at version 4 fail and deleting
// it block.
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
afterEach(() => { for (const db of connections.splice(0)) db.close(); });

test('single-project roots and compiled bundles migrate once; forgetting a project stays forgotten', async () => {
  const old = await legacyDatabase();
  await putRoot(old, root('project', '/Movies/old-project'));
  await putRoot(old, root('library', '/Movies/old-projects', 'multi'));
  await old.put('bundles', { projectId: 'project', code: 'old JSX bundle', updatedAt: '2026-01-01' });
  const next = await database();
  await migrateLegacyDatabase(next);
  const migrated = await next.get('projects', '/Movies/old-project');
  expect(migrated?.displayName).toBe('old-project');
  expect(migrated?.lastOpenedAt).toBe('2026-01-02');
  // A multi root is a folder of projects, not a project: it is not recorded.
  expect(await next.count('projects')).toBe(1);
  expect((await next.get('bundles', 'project'))?.code).toBe('old JSX bundle');
  expect(await old.count('roots' as never)).toBe(2);
  await next.delete('projects', '/Movies/old-project');
  await migrateLegacyDatabase(next);
  expect(await next.count('projects')).toBe(0);
});

test('migration keeps Compound records when folders or bundles already exist', async () => {
  const old = await legacyDatabase();
  await putRoot(old, root('shared', '/Movies/shared'));
  await putRoot(old, root('other', '/Movies/other'));
  await old.put('bundles', { projectId: 'same-id', code: 'old', updatedAt: '2026-01-01' });
  const next = await database();
  await next.put('projects', record('/Movies/shared', 'same-id'));
  await next.put('bundles', { projectId: 'same-id', code: 'new', updatedAt: '2026-01-02' });
  await migrateLegacyDatabase(next);
  expect(await next.count('projects')).toBe(2);
  expect((await next.get('projects', '/Movies/shared'))?.id).toBe('same-id');
  expect((await next.get('bundles', 'same-id'))?.code).toBe('new');
});

test('a clean install never creates the legacy database', async () => {
  const next = await database();
  await migrateLegacyDatabase(next);
  expect((await indexedDB.databases()).map((entry) => entry.name)).toEqual(['compound-idb']);
});
