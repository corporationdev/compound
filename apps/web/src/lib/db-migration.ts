import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { GlobalDBSchema, ProjectRecord } from './db';

type LegacyRoot = { path: string; kind?: 'multi' | 'single'; createdAt: string; lastUsedAt: string };

/** Last segment of a path, whichever separator it uses. */
const folderLabel = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Copy the old registry once; leave original storage and any Compound rows intact. */
export async function migrateLegacyDatabase(db: IDBPDatabase<GlobalDBSchema>): Promise<void> {
  if (await db.get('meta', 'brand-migrated')) return;
  const databases = await indexedDB.databases();
  if (!databases.some((entry) => entry.name === 'diffusion-studio-idb')) {
    await db.put('meta', true, 'brand-migrated');
    return;
  }
  const legacy = await openDB<GlobalDBSchema>('diffusion-studio-idb');
  try {
    // Version 3 retired the `roots` store (see db.ts). A legacy database may
    // still hold one: its single-project roots become project records, and
    // its multi roots are dropped, exactly as `retireRoots` does.
    const roots: LegacyRoot[] = legacy.objectStoreNames.contains('roots' as never)
      ? ((await legacy.getAll('roots' as never)) as LegacyRoot[])
      : [];
    const projects = legacy.objectStoreNames.contains('projects') ? await legacy.getAll('projects') : [];
    const bundles = legacy.objectStoreNames.contains('bundles') ? await legacy.getAll('bundles') : [];
    const tx = db.transaction(['projects', 'bundles', 'meta'], 'readwrite');
    const store = tx.objectStore('projects');
    for (const project of projects) {
      if (!await store.get(project.dir)) await store.put(project);
    }
    for (const root of roots) {
      if (root.kind !== 'single' || await store.get(root.path)) continue;
      const name = folderLabel(root.path);
      const record: ProjectRecord = {
        dir: root.path, id: '', name, displayName: name, entry: '',
        modifiedAt: root.lastUsedAt, createdAt: root.createdAt,
        recordedAt: root.createdAt, lastOpenedAt: root.lastUsedAt, cover: null,
      };
      await store.put(record);
    }
    for (const bundle of bundles) {
      if (!await tx.objectStore('bundles').get(bundle.projectId)) {
        await tx.objectStore('bundles').put(bundle);
      }
    }
    await tx.objectStore('meta').put(true, 'brand-migrated');
    await tx.done;
  } finally {
    legacy.close();
  }
}
