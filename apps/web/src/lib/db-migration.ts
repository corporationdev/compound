import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { GlobalDBSchema } from './db';

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
    const roots = legacy.objectStoreNames.contains('roots') ? await legacy.getAll('roots') : [];
    const bundles = legacy.objectStoreNames.contains('bundles') ? await legacy.getAll('bundles') : [];
    const tx = db.transaction(['roots', 'bundles', 'meta'], 'readwrite');
    for (const root of roots) {
      if (!await tx.objectStore('roots').get(root.id) &&
          !await tx.objectStore('roots').index('by-path').get(root.path)) {
        await tx.objectStore('roots').put(root);
      }
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
