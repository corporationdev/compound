/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Keeps one workspace folder and its organization's cloud rows the same. The rows are the
// truth; the folder is a checkout of them that the compiler, the watcher,
// the inspector's write-back and any agent's own file tools keep using as a
// plain folder. This is what turns their writes into versioned mutations and
// the cloud's changes into files on disk.
//
// Two directions, one queue. Everything — a snapshot from the subscription,
// a change under the folder — is handled one at a time, so a merge never
// runs against a file another step is halfway through writing.
//
//   down  a row is newer than the version this checkout agreed on:
//         clean file  → write it
//         dirty file  → three-way merge against the base we kept, write the
//                       result, push it back with the row's version
//         no history  → the cloud wins; the local text is kept beside it
//   up    a file's text differs from its base:
//         push with the version we know; a conflict comes back with the row
//         as it is now and goes through `down`, which merges and pushes again
//
// Sync's own writes are not claimed with `noteContent`: the renderer must see
// them as changes and recompile. They come back through the watcher here too,
// where the text equals its base and nothing happens.

import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic";
import { watchTree, type TreeWatcher } from "../tree-watch";
import { hashText } from "./hash";
import { withProjectLock } from "./locks";
import { mergeText } from "./merge";
import { isSyncableContent, isSyncablePath, shouldDescend } from "./rules";
import { SyncStore, TOMBSTONE_HASH } from "./state";

import type { RemoteFile, RemoteFileMeta, SyncBackend } from "./backend";

export type SyncState = "starting" | "synced" | "syncing" | "offline" | "error";

export type SyncStatus = {
  state: SyncState;
  /** Changes waiting to go up. */
  pending: number;
  /** Paths under the folder that cannot sync: too large, or not text. */
  skipped: string[];
  error?: string;
};

/**
 * A merge had to choose between two edits to the same lines of `path`. The
 * text that lost is at `keptCopy`, a file under the app's own folder in the
 * workspace, which neither the tree shows nor sync sends.
 */
export type ConflictNotice = { path: string; keptCopy: string };

/** Where the losing side of a merge is kept: under `.compound`, out of the tree and out of sync. */
export const CONFLICTS_DIR = ".compound/conflicts";
/** Paths fetched per round trip on a checkout; matches the backend's cap. */
const PREFETCH_BATCH = 64;
/** How long after a folder appears its contents are looked over for files the watcher missed. */
const SWEEP_DELAY_MS = 250;
/** How long the engine stays quiet before the status says synced. */
const STATUS_SETTLE_MS = 700;
const CONFLICT_SUFFIX = ".conflict";

export type WorkspaceSyncOptions = {
  dir: string;
  organizationId: string;
  backend: SyncBackend;
  /** For tests: how long after a folder appears it is swept for files. */
  sweepDelayMs?: number;
  /** For tests: how long the engine must be quiet before it reports synced. */
  statusSettleMs?: number;
  /** Watch the folder for changes; off in tests that drive `noteChange` themselves. */
  watch?: boolean;
  onStatus?: (status: SyncStatus) => void;
  onConflict?: (notice: ConflictNotice) => void;
  /** A file sync wrote or removed on disk, workspace-relative. */
  onWrite?: (path: string) => void;
  /** First retry delay after a failed push; doubles up to 30 s. */
  retryBaseMs?: number;
  /** How long a burst of changes to one path is collected before it is read. */
  coalesceMs?: number;
};

type LocalFile = { text: string; hash: string };

/** What is at a path on disk: text, nothing (`null`), or something that cannot sync (`undefined`). */
type LocalRead = LocalFile | null | undefined;

const MAX_RETRY_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `.compound/conflicts/scenes/a.tsx.<stamp>.conflict` for `scenes/a.tsx`. */
function conflictPathFor(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${CONFLICTS_DIR}/${path}.${stamp}${CONFLICT_SUFFIX}`;
}

/** The folders holding a live `package.json` among `files`. */
export function projectRootsOf(files: readonly RemoteFileMeta[]): Set<string> {
  const roots = new Set<string>();
  for (const { path, deleted } of files) {
    if (deleted) continue;
    if (path === "package.json") roots.add("");
    else if (path.endsWith("/package.json")) roots.add(path.slice(0, -"/package.json".length));
  }
  return roots;
}

export class WorkspaceSync {
  readonly dir: string;
  readonly organizationId: string;
  private readonly backend: SyncBackend;
  private readonly options: WorkspaceSyncOptions;
  private readonly store: SyncStore;

  private queue: Promise<void> = Promise.resolve();
  private busy = 0;
  private initialized = false;
  private readonly early = new Set<string>();
  private resolveStarted: (() => void) | undefined;
  private rejectStarted: ((error: Error) => void) | undefined;
  private readonly started: Promise<void>;

  private latestSnapshot: RemoteFileMeta[] | null = null;
  private readonly latestMeta = new Map<string, RemoteFileMeta>();
  private roots: ReadonlySet<string> = new Set();
  /** Rows fetched ahead for a snapshot, so a checkout is one round trip per batch rather than one per file. */
  private readonly prefetched = new Map<string, RemoteFile>();
  private snapshotQueued = false;

  private readonly coalesce = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Set<string>();
  private readonly skipped = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay: number;
  private offline = false;
  private fatal: string | undefined;
  private lastStatus = "";
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  private unsubscribe: (() => void) | undefined;
  private watcher: TreeWatcher | undefined;
  private stopped = false;

  constructor(options: WorkspaceSyncOptions) {
    this.options = options;
    this.dir = options.dir;
    this.organizationId = options.organizationId;
    this.backend = options.backend;
    this.store = new SyncStore(options.dir, options.organizationId);
    this.retryDelay = options.retryBaseMs ?? 1000;
    this.started = new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    // Nothing awaits `started` until `start()` is called; a failure before
    // then must not surface as an unhandled rejection.
    this.started.catch(() => { });
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  /** Subscribes, applies the first snapshot, reconciles the folder. */
  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      await this.store.load();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    // What this checkout already agreed on says which folders are projects
    // before the cloud's first word arrives, so a listing in between marks
    // them right.
    this.roots = projectRootsOf(this.store.paths().map((path) => ({ path, deleted: this.store.get(path)?.hash === TOMBSTONE_HASH })) as RemoteFileMeta[]);
    this.emitStatus();
    this.unsubscribe = this.backend.subscribe(
      this.organizationId,
      (files) => this.onSnapshot(files),
      (error) => this.fail(error),
    );
    if (this.options.watch !== false) {
      this.watcher = watchTree(this.dir, { onChange: (path) => this.noteChange(path) });
    }
    await this.started;
  }

  /** A path under the folder may have changed. Cheap to call for anything. */
  noteChange(path: string): void {
    if (this.stopped || !isSyncablePath(path)) return;
    if (!this.initialized) {
      this.early.add(path);
      return;
    }
    void this.sweepFolder(path);
    const timer = this.coalesce.get(path);
    if (timer) clearTimeout(timer);
    this.coalesce.set(path, setTimeout(() => {
      this.coalesce.delete(path);
      void this.enqueue(() => this.reconcile(path));
    }, this.options.coalesceMs ?? 100));
    this.emitStatus();
  }

  /**
   * A folder that appeared (made, or renamed into place) may already hold
   * files the watcher never saw: they were written in the moment between the
   * folder's event and the watcher attaching to it — how a project is
   * scaffolded — or came with a folder renamed in. A little after, every
   * file under it is noted as changed; ones the store knows cost nothing.
   */
  private async sweepFolder(path: string): Promise<void> {
    const info = await stat(this.absolute(path)).catch(() => null);
    if (!info?.isDirectory()) return;
    await new Promise((resolve) => setTimeout(resolve, this.options.sweepDelayMs ?? SWEEP_DELAY_MS));
    if (this.stopped) return;
    const walk = async (parent: string): Promise<void> => {
      const entries = await readdir(this.absolute(parent), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!shouldDescend(entry.name)) continue;
        const child = `${parent}/${entry.name}`;
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() && isSyncablePath(child)) this.noteChange(child);
      }
    };
    await walk(path);
  }

  /** Resolves once nothing is queued or collecting. Failed pushes waiting to retry do not count. */
  async idle(): Promise<void> {
    while (true) {
      await this.queue;
      if (this.busy === 0 && this.coalesce.size === 0 && !this.snapshotQueued) return;
      await sleep(5);
    }
  }

  async stop(): Promise<void> {
    if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = undefined; }
    this.stopped = true;
    // A start still waiting on its first snapshot must not wait forever.
    this.rejectStarted?.(new Error("Sync stopped before it started"));
    this.unsubscribe?.();
    void this.watcher?.close();
    for (const timer of this.coalesce.values()) clearTimeout(timer);
    this.coalesce.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.queue;
    await this.store.flush();
  }

  /**
   * Every folder the cloud holds a `package.json` in, workspace-relative
   * (`''` for the workspace itself). Known from the snapshot, before any of
   * the folder's files are written here — so a listing can treat the folder
   * as a project from its first file, not once enough of it has landed.
   */
  get projectRoots(): ReadonlySet<string> {
    return this.roots;
  }

  get status(): SyncStatus {
    const skipped = [...this.skipped].sort();
    if (this.fatal) return { state: "error", pending: this.pending.size, skipped, error: this.fatal };
    if (!this.initialized) return { state: "starting", pending: 0, skipped };
    const pending = this.pending.size + this.coalesce.size;
    if (this.offline) return { state: "offline", pending, skipped };
    if (this.busy > 0 || this.coalesce.size > 0 || this.snapshotQueued || this.pending.size > 0)
      return { state: "syncing", pending, skipped };
    return { state: "synced", pending: 0, skipped };
  }

  // -------------------------------------------------------------------------
  // The queue

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.busy++;
    this.emitStatus();
    const run = this.queue.then(task).catch((error: unknown) => {
      console.warn(`[sync] ${this.organizationId}: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.busy--;
      this.emitStatus();
    });
    this.queue = run;
    return run;
  }

  /**
   * Reports the status when it changes. Going quiet is reported only once
   * the engine has been quiet for a moment: every file sync writes comes
   * back through the watcher as a change to look at, so a checkout of seven
   * files would otherwise flip syncing and synced seven times over.
   */
  private emitStatus(): void {
    const status = this.status;
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = undefined; }
      return;
    }
    if (status.state === "synced" && !this.stopped) {
      if (this.statusTimer) return;
      this.statusTimer = setTimeout(() => {
        this.statusTimer = undefined;
        this.emitStatus();
      }, this.options.statusSettleMs ?? STATUS_SETTLE_MS);
      return;
    }
    if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = undefined; }
    this.lastStatus = key;
    this.options.onStatus?.(status);
  }

  private fail(error: Error): void {
    this.fatal = error.message;
    this.emitStatus();
    this.rejectStarted?.(error);
  }

  /** Whatever `path` needs now: the cloud's newer row applied, or the local text pushed. */
  private async reconcile(path: string): Promise<void> {
    const meta = this.latestMeta.get(path);
    const known = this.store.get(path);
    if (meta && (!known || known.version < meta.version)) await this.applyRemote(meta);
    else await this.pushLocal(path);
  }

  // -------------------------------------------------------------------------
  // Down

  private onSnapshot(files: RemoteFileMeta[]): void {
    if (this.stopped) return;
    this.latestSnapshot = files;
    if (this.snapshotQueued) return;
    this.snapshotQueued = true;
    void this.enqueue(async () => {
      this.snapshotQueued = false;
      const snapshot = this.latestSnapshot ?? [];
      this.latestMeta.clear();
      for (const meta of snapshot) this.latestMeta.set(meta.path, meta);
      this.roots = projectRootsOf(snapshot);
      try {
        await this.prefetch(snapshot);
        for (const meta of snapshot) await this.applyRemote(meta);
      } catch (error) {
        // One row that cannot be applied must not stop the rest, and never
        // the start: an engine that never initializes parks every local
        // change for good. The row is tried again with the next snapshot.
        console.warn(`[sync] ${this.organizationId}: applying the cloud's files: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.prefetched.clear();
      }
      if (this.initialized) return;
      try {
        await this.scanLocal();
      } catch (error) {
        console.warn(`[sync] ${this.organizationId}: scanning the folder: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.initialized = true;
      for (const path of this.early) this.noteChange(path);
      this.early.clear();
      this.resolveStarted?.();
    });
  }

  /**
   * Fetches, in batches, the text of every row in `snapshot` this checkout
   * has yet to apply: a first checkout lands as a few round trips, and the
   * folder fills in one go rather than file by file. A batch that fails is
   * left to `applyRemote`, which fetches on its own and defers on error.
   */
  private async prefetch(snapshot: readonly RemoteFileMeta[]): Promise<void> {
    const wanted = snapshot.filter((meta) => !meta.deleted && (this.store.get(meta.path)?.version ?? -1) < meta.version).map((meta) => meta.path);
    while (wanted.length > 0 && !this.stopped) {
      const batch = wanted.splice(0, PREFETCH_BATCH);
      let rows: RemoteFile[];
      try {
        rows = await this.backend.fetchMany(this.organizationId, batch);
      } catch {
        return;
      }
      if (rows.length === 0) return;
      for (const row of rows) this.prefetched.set(row.path, row);
      // The backend answers in the order asked and may stop short when the
      // text adds up: everything after the last row it gave goes back on the list.
      const last = batch.indexOf(rows[rows.length - 1]!.path);
      if (last >= 0 && last < batch.length - 1) wanted.unshift(...batch.slice(last + 1));
    }
  }

  /** Brings the folder up to the row `meta` describes, merging when the file has moved on locally. */
  private async applyRemote(meta: RemoteFileMeta): Promise<void> {
    const { path } = meta;
    const known = this.store.get(path);
    if (known && known.version >= meta.version) return;

    let remote: RemoteFile | null;
    const ahead = this.prefetched.get(path);
    this.prefetched.delete(path);
    if (ahead && ahead.version >= meta.version) {
      remote = ahead;
    } else {
      try {
        remote = await this.backend.fetch(this.organizationId, path);
      } catch (error) {
        this.defer(path, error);
        return;
      }
    }
    this.online(path);
    if (!remote || (known && known.version >= remote.version)) return;

    const local = await this.readLocal(path);
    if (local === undefined) return;
    const base = await this.store.readBase(path);
    // Clean: the text on disk is what this checkout last agreed with the
    // cloud on. The base text says so; failing that, the recorded hash does.
    const clean = local !== null && (base !== null
      ? local.text === base
      : known !== undefined && known.hash !== TOMBSTONE_HASH && local.hash === known.hash);

    if (remote.deleted) {
      if (local === null) return this.advance(remote);
      if (clean) {
        if (!(await this.removeLocal(path, local.hash))) return this.retryRemote(meta);
        return this.advance(remote);
      }
      // The cloud dropped a file this checkout has changed (or never synced):
      // text beats absence, so it goes back up as a new file.
      await this.advance(remote);
      this.schedulePush(path);
      return;
    }

    if (local === null) {
      // Missing here: either never checked out, or deleted locally while the
      // cloud changed it — and a change beats a delete.
      if (!(await this.writeLocal(path, remote.text, null))) return this.retryRemote(meta);
      await this.advance(remote);
      return;
    }

    if (local.text === remote.text) return this.advance(remote);

    if (clean) {
      if (!(await this.writeLocal(path, remote.text, local.hash))) return this.retryRemote(meta);
      return this.advance(remote);
    }

    if (known === undefined && base === null) {
      // No history here at all — a folder copied by hand, or pointed at this
      // organization after the fact. Nothing says which text is newer, and the
      // cloud's is everyone's: it wins, and the local text is kept beside it.
      const kept = await this.keepCopy(path, local.text);
      if (!(await this.writeLocal(path, remote.text, local.hash))) return this.retryRemote(meta);
      await this.advance(remote);
      if (kept) this.options.onConflict?.({ path, keptCopy: this.absolute(kept) });
      return;
    }

    // Changed on both sides since the base.
    const merged = mergeText(base ?? "", local.text, remote.text);
    if (merged.text !== local.text && !(await this.writeLocal(path, merged.text, local.hash))) return this.retryRemote(meta);
    await this.advance(remote);
    if (merged.conflicted) {
      // The cloud's text lost the overlap; a copy is kept on this machine.
      const kept = await this.keepCopy(path, remote.text);
      if (kept) this.options.onConflict?.({ path, keptCopy: this.absolute(kept) });
    }
    if (merged.text !== remote.text) this.schedulePush(path);
  }

  /** Records `remote` as what this checkout and the cloud agree on. Base first: a crash between the two leaves a base that is at worst too new, never too old. */
  private async advance(remote: RemoteFile): Promise<void> {
    if (remote.deleted) {
      await this.store.removeBase(remote.path);
      this.store.set(remote.path, { version: remote.version, hash: TOMBSTONE_HASH });
    } else {
      await this.store.writeBase(remote.path, remote.text);
      this.store.set(remote.path, { version: remote.version, hash: hashText(remote.text) });
    }
  }

  /** Writes `text` as a conflict copy for `path`, under the app's folder. Returns the copy's path, or null when it could not be written. */
  private async keepCopy(path: string, text: string): Promise<string | null> {
    const copy = conflictPathFor(path);
    try {
      const target = this.absolute(copy);
      await mkdir(dirname(target), { recursive: true });
      await writeFileAtomic(target, text);
      return copy;
    } catch (error) {
      console.warn(`[sync] ${this.organizationId}: could not keep a conflict copy of ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** The file moved while a row was being applied to it: apply the row again, against what is there now. */
  private retryRemote(meta: RemoteFileMeta): void {
    void this.enqueue(() => this.applyRemote(meta));
  }

  private schedulePush(path: string): void {
    void this.enqueue(() => this.pushLocal(path));
  }

  // -------------------------------------------------------------------------
  // Up

  /** Pushes what is at `path` if it differs from the base this checkout agreed on. */
  private async pushLocal(path: string): Promise<void> {
    if (this.stopped) return;
    const local = await this.readLocal(path);
    if (local === undefined) return;
    const known = this.store.get(path);

    if (local === null) {
      if (!known || known.hash === TOMBSTONE_HASH) return;
      let outcome;
      try {
        outcome = await this.backend.remove(this.organizationId, path, known.version);
      } catch (error) {
        this.defer(path, error);
        return;
      }
      this.online(path);
      if (outcome.status === "ok") {
        await this.store.removeBase(path);
        this.store.set(path, { version: outcome.version, hash: TOMBSTONE_HASH });
      } else if (outcome.current) {
        await this.applyRemote(outcome.current);
      } else {
        this.store.delete(path);
        await this.store.removeBase(path);
      }
      return;
    }

    if (known && known.hash === local.hash) return;
    const expected = known && known.hash !== TOMBSTONE_HASH ? known.version : null;
    let outcome;
    try {
      outcome = await this.backend.write(this.organizationId, path, local.text, local.hash, expected);
    } catch (error) {
      this.defer(path, error);
      return;
    }
    this.online(path);
    if (outcome.status === "ok") {
      await this.store.writeBase(path, local.text);
      this.store.set(path, { version: outcome.version, hash: local.hash });
    } else if (outcome.current) {
      await this.applyRemote(outcome.current);
    } else {
      // Expected a version the cloud no longer has any row for: start over as a create.
      this.store.delete(path);
      await this.store.removeBase(path);
      this.schedulePush(path);
    }
  }

  /** Every syncable file on disk and every path once synced, each pushed or reconciled. */
  private async scanLocal(): Promise<void> {
    const seen = new Set<string>();
    const walk = async (parent: string): Promise<void> => {
      const entries = await readdir(join(this.dir, ...parent.split("/").filter(Boolean)), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!shouldDescend(entry.name)) continue;
        const path = parent ? `${parent}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && isSyncablePath(path)) {
          seen.add(path);
          await this.pushLocal(path);
        }
      }
    };
    await walk("");
    for (const path of this.store.paths()) {
      if (!seen.has(path)) await this.pushLocal(path);
    }
  }

  // -------------------------------------------------------------------------
  // Retry

  private defer(path: string, error: unknown): void {
    this.pending.add(path);
    if (!this.offline) {
      this.offline = true;
      console.warn(`[sync] ${this.organizationId} offline: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.emitStatus();
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
      for (const path of [...this.pending]) {
        this.pending.delete(path);
        void this.enqueue(() => this.reconcile(path));
      }
    }, this.retryDelay);
  }

  private online(path?: string): void {
    if (path) this.pending.delete(path);
    if (!this.offline) return;
    this.offline = false;
    this.retryDelay = this.options.retryBaseMs ?? 1000;
    this.emitStatus();
  }

  // -------------------------------------------------------------------------
  // Disk

  private absolute(path: string): string {
    return join(this.dir, ...path.split("/"));
  }

  private async readLocal(path: string): Promise<LocalRead> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.absolute(path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
        this.noteSkipped(path, false);
        return null;
      }
      throw error;
    }
    if (!isSyncableContent(bytes)) {
      this.noteSkipped(path, true);
      return undefined;
    }
    this.noteSkipped(path, false);
    const text = bytes.toString("utf8");
    return { text, hash: hashText(text) };
  }

  private noteSkipped(path: string, skipped: boolean): void {
    const was = this.skipped.has(path);
    if (skipped === was) return;
    if (skipped) this.skipped.add(path);
    else this.skipped.delete(path);
    this.emitStatus();
  }

  /**
   * Writes `text` at `path`, unless the file no longer holds what was read
   * before the decision to write it was made (`expected`: its hash, or null
   * for absent). Someone else — the user's editor, an agent, the inspector's
   * write-back — may write the same file at any moment, and a write decided
   * against stale content would take theirs away. The check and the write
   * happen under the folder's lock, which the write-back holds too. Answers
   * false when it stood down.
   */
  private writeLocal(path: string, text: string, expected: string | null): Promise<boolean> {
    return withProjectLock(this.dir, async () => {
      if (this.stopped) return false;
      const now = await this.readLocal(path);
      const hash = now === null ? null : now === undefined ? undefined : now.hash;
      if (hash !== expected) return false;
      const target = this.absolute(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFileAtomic(target, text);
      this.options.onWrite?.(path);
      return true;
    });
  }

  /**
   * Takes away the folders a removed file leaves empty, up to the workspace
   * itself: a project deleted on another machine should not linger here as
   * an empty folder the tree then shows. A folder with anything else in it
   * stops the climb.
   */
  private async pruneEmptyParents(path: string): Promise<void> {
    const segments = path.split("/");
    for (let depth = segments.length - 1; depth >= 1; depth--) {
      const folder = segments.slice(0, depth).join("/");
      const entries = await readdir(this.absolute(folder)).catch(() => null);
      if (entries === null || entries.length > 0) return;
      await rm(this.absolute(folder), { recursive: true, force: true }).catch(() => {});
      this.options.onWrite?.(folder);
    }
  }

  /** Removes `path` if it still holds the text with hash `expected`. */
  private removeLocal(path: string, expected: string): Promise<boolean> {
    return withProjectLock(this.dir, async () => {
      if (this.stopped) return false;
      const now = await this.readLocal(path);
      if (!now || now.hash !== expected) return false;
      await rm(this.absolute(path), { force: true });
      await this.pruneEmptyParents(path);
      this.options.onWrite?.(path);
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// Publishing

/** Every syncable file under `dir`, read as text, workspace-relative paths. */
export async function collectSyncableFiles(dir: string): Promise<Array<{ path: string; text: string; hash: string }>> {
  const files: Array<{ path: string; text: string; hash: string }> = [];
  const walk = async (parent: string): Promise<void> => {
    const entries = await readdir(join(dir, ...parent.split("/").filter(Boolean)), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!shouldDescend(entry.name)) continue;
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && isSyncablePath(path)) {
        const bytes = await readFile(join(dir, ...path.split("/")));
        if (!isSyncableContent(bytes)) continue;
        const text = bytes.toString("utf8");
        files.push({ path, text, hash: hashText(text) });
      }
    }
  };
  await walk("");
  return files;
}

/** Force-writes a local folder's files as the organization's rows, in bounded batches. */
export async function publishFolder(dir: string, organizationId: string, backend: SyncBackend, batch = 32): Promise<number> {
  const files = await collectSyncableFiles(dir);
  for (let i = 0; i < files.length; i += batch) {
    await backend.writeMany(organizationId, files.slice(i, i + batch));
  }
  return files.length;
}
