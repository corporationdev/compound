import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export type LocalMedia<T> = { blob: Blob; checksum: string; metadata: T };
type PendingMedia<T> = { promise: Promise<LocalMedia<T>>; downloading: boolean; onMiss: Set<() => void> };
type FileRow = { scope: string; checksum: string; blob: Blob; size: number; usedAt: number };
type SourceRow = { scope: string; sourceId: string; checksum: string; metadata: unknown };
interface MediaDB extends DBSchema {
  files: { key: [string, string]; value: FileRow; indexes: { 'by-used': number } };
  sources: { key: [string, string]; value: SourceRow; indexes: { 'by-file': [string, string] } };
  meta: { key: string; value: number };
}

/** Browser-owned, content-addressed media storage. Components share downloads
 * and a small memory cache; IndexedDB survives renderer/page restarts. */
export class LocalMediaCache<T> {
  private db?: Promise<IDBPDatabase<MediaDB>>;
  private scope: string | null = null;
  private generation = 0;
  private memory = new Map<string, LocalMedia<T>>();
  private memoryBytes = 0;
  private pending = new Map<string, PendingMedia<T>>();
  private writes = new Set<Promise<void>>();
  private warned = false;

  constructor(private options: { name: string; memoryBytes?: number; diskBytes?: number; warn?: (error: unknown) => void }) {}

  setScope(scope: string | null) {
    if (scope === this.scope) return;
    this.scope = scope; this.generation++;
    this.memory.clear(); this.memoryBytes = 0; this.pending.clear();
  }

  private database() {
    return this.db ??= openDB<MediaDB>(this.options.name, 1, {
      upgrade(db) {
        db.createObjectStore('files', { keyPath: ['scope', 'checksum'] }).createIndex('by-used', 'usedAt');
        db.createObjectStore('sources', { keyPath: ['scope', 'sourceId'] }).createIndex('by-file', ['scope', 'checksum']);
        db.createObjectStore('meta');
      },
      blocking: () => { void this.db?.then(db => db.close()); this.db = undefined; },
      terminated: () => { this.db = undefined; },
    });
  }

  private warn(error: unknown) {
    if (this.warned) return;
    this.warned = true;
    if (this.options.warn) this.options.warn(error);
    else console.warn('[media-cache] Persistent storage is unavailable; using the memory cache.', error);
  }

  private remember(sourceId: string, value: LocalMedia<T>) {
    const previous = this.memory.get(sourceId);
    if (previous) { this.memoryBytes -= previous.blob.size; this.memory.delete(sourceId); }
    const budget = this.options.memoryBytes ?? 64 * 1024 * 1024;
    this.memory.set(sourceId, value); this.memoryBytes += value.blob.size;
    // Keep at least the latest file, even if it alone exceeds the soft budget.
    while (this.memoryBytes > budget && this.memory.size > 1) {
      const [id, oldest] = this.memory.entries().next().value!;
      this.memoryBytes -= oldest.blob.size; this.memory.delete(id);
    }
  }

  private background(write: Promise<void>) {
    const pending = write.catch(error => this.warn(error)).finally(() => this.writes.delete(pending));
    this.writes.add(pending);
  }

  private async read(scope: string, sourceId: string): Promise<LocalMedia<T> | undefined> {
    try {
      const db = await this.database();
      const tx = db.transaction(['sources', 'files'], 'readonly');
      const source = await tx.objectStore('sources').get([scope, sourceId]);
      const file = source && await tx.objectStore('files').get([scope, source.checksum]);
      await tx.done;
      if (!source || !file || file.blob.size !== file.size) return;
      // Touch in a separate transaction; never hold playback behind disk writes.
      this.background(this.touch(scope, file.checksum));
      return { blob: file.blob, checksum: file.checksum, metadata: source.metadata as T };
    } catch (error) { this.warn(error); return; }
  }

  private async touch(scope: string, checksum: string) {
    const db = await this.database();
    const tx = db.transaction('files', 'readwrite');
    const row = await tx.store.get([scope, checksum]);
    if (row) await tx.store.put({ ...row, usedAt: Date.now() });
    await tx.done;
  }

  private async write(scope: string, sourceId: string, value: LocalMedia<T>) {
    const budget = this.options.diskBytes ?? 512 * 1024 * 1024;
    if (value.blob.size > budget) return;
    const db = await this.database();
    const tx = db.transaction(['sources', 'files', 'meta'], 'readwrite');
    // Observe transaction rejection even when an individual request fails first.
    const done = tx.done; void done.catch(() => {});
    const files = tx.objectStore('files'), sources = tx.objectStore('sources'), meta = tx.objectStore('meta');
    const key: [string, string] = [scope, value.checksum];
    const existing = await files.get(key);
    let size = (await meta.get('bytes') ?? 0) - (existing?.size ?? 0) + value.blob.size;
    await files.put({ scope, checksum: value.checksum, blob: value.blob, size: value.blob.size, usedAt: Date.now() });
    await sources.put({ scope, sourceId, checksum: value.checksum, metadata: value.metadata });
    let oldest = await files.index('by-used').openCursor();
    while (size > budget && oldest) {
      const row = oldest.value;
      if (row.scope !== scope || row.checksum !== value.checksum) {
        size -= row.size;
        let alias = await sources.index('by-file').openCursor([row.scope, row.checksum]);
        while (alias) { await alias.delete(); alias = await alias.continue(); }
        await oldest.delete();
      }
      oldest = await oldest.continue();
    }
    await meta.put(size, 'bytes');
    await done;
  }

  /** The loader runs only on a true cache miss, once for concurrent callers. */
  ensure(sourceId: string, load: () => Promise<LocalMedia<T>>, onMiss?: () => void): Promise<LocalMedia<T>> {
    const scope = this.scope, generation = this.generation;
    if (!scope) return Promise.reject(new Error('Sign in required'));
    const assertCurrent = () => {
      if (generation !== this.generation) throw new DOMException('The account changed', 'AbortError');
    };
    const cached = this.memory.get(sourceId);
    if (cached) {
      this.remember(sourceId, cached); this.background(this.touch(scope, cached.checksum));
      return Promise.resolve().then(() => { assertCurrent(); return cached; });
    }
    const pending = this.pending.get(sourceId);
    if (pending) {
      if (onMiss) {
        if (pending.downloading) onMiss();
        else pending.onMiss.add(onMiss);
      }
      return pending.promise;
    }
    const entry: PendingMedia<T> = { promise: undefined!, downloading: false, onMiss: new Set(onMiss ? [onMiss] : []) };
    const request = (async () => {
      const stored = await this.read(scope, sourceId);
      assertCurrent();
      if (stored) { this.remember(sourceId, stored); return stored; }
      entry.downloading = true;
      for (const notify of entry.onMiss) notify();
      entry.onMiss.clear();
      const value = await load();
      assertCurrent();
      this.remember(sourceId, value);
      this.background(this.write(scope, sourceId, value));
      return value;
    })().finally(() => { if (this.pending.get(sourceId) === entry) this.pending.delete(sourceId); });
    entry.promise = request;
    this.pending.set(sourceId, entry);
    return request;
  }

  async flush() { await Promise.all([...this.writes]); }
  async close() { this.setScope(null); await this.flush(); (await this.db?.catch(() => undefined))?.close(); this.db = undefined; }
}
