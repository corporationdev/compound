import { dehydrate, hydrate, QueryClient, type DehydratedState } from '@tanstack/solid-query';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

const MAX_AGE = 24 * 60 * 60 * 1000;
interface QueryDB extends DBSchema {
  snapshots: { key: string; value: { savedAt: number; state: DehydratedState } };
}

/** Shared server-state cache. Only queries marked meta.persist are stored. */
export class PersistentQueryCache {
  readonly client = new QueryClient({ defaultOptions: { queries: {
    staleTime: 5 * 60 * 1000, gcTime: MAX_AGE, retry: 1,
    refetchOnWindowFocus: false,
  } } });
  scope: string | null = null;
  private db?: Promise<IDBPDatabase<QueryDB>>;
  private ready: Promise<void> = Promise.resolve();
  private generation = 0;
  private restoring = false;
  private writes = new Set<Promise<void>>();
  private unsubscribe: () => void;
  constructor(private name = 'compound-query-cache-v1') {
    this.client.mount();
    this.unsubscribe = this.client.getQueryCache().subscribe(event => {
      if (event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'invalidate')) this.persist();
    });
  }
  private database() {
    return this.db ??= openDB<QueryDB>(this.name, 1, {
      upgrade(db) { db.createObjectStore('snapshots'); },
      blocking: () => { void this.db?.then(db => db.close()); this.db = undefined; },
      terminated: () => { this.db = undefined; },
    });
  }
  setScope(scope: string | null): Promise<void> {
    if (scope === this.scope) return this.ready;
    const current = ++this.generation;
    this.scope = scope; this.restoring = true;
    this.client.clear();
    return this.ready = (async () => {
      try {
        if (!scope) return;
        const saved = await (await this.database()).get('snapshots', scope);
        if (current === this.generation && saved && Date.now() - saved.savedAt < MAX_AGE) hydrate(this.client, saved.state);
      } catch (error) { console.warn('[query-cache] Could not restore cached queries.', error); }
      finally { if (current === this.generation) this.restoring = false; }
    })();
  }
  private persist() {
    const scope = this.scope;
    if (!scope || this.restoring) return;
    const state = dehydrate(this.client, { shouldDehydrateQuery: query => query.meta?.persist === true && query.state.status === 'success' && Date.now() - query.state.dataUpdatedAt < MAX_AGE });
    const savedAt = Date.now();
    const write = this.database().then(db => db.put('snapshots', { state, savedAt }, scope)).then(() => {}).catch(error => {
      console.warn('[query-cache] Could not persist cached queries.', error);
    }).finally(() => this.writes.delete(write));
    this.writes.add(write);
  }
  async flush() { await Promise.all([...this.writes]); }
  async close() {
    this.unsubscribe(); await this.ready; await this.flush();
    this.client.clear(); this.client.unmount();
    (await this.db?.catch(() => undefined))?.close();
  }
}

export const serverQueries = new PersistentQueryCache();
