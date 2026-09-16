/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// An in-memory cloud with the same versioning rules as `files.write` and
// `files.remove` in Convex, for tests of the sync engine. Subscribers get a
// fresh snapshot after every change, asynchronously, the way a real
// subscription would; `offline` makes every call fail and holds snapshots
// back until the connection "returns".

import type { RemoteFile, RemoteFileMeta, SyncBackend, WriteOutcome } from "../backend";

type Subscriber = (files: RemoteFileMeta[]) => void;

const meta = ({ text: _text, ...rest }: RemoteFile): RemoteFileMeta => rest;

export class FakeBackend implements SyncBackend {
  private readonly rows = new Map<string, Map<string, RemoteFile>>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly held = new Set<string>();
  offline = false;
  /** Delay before a snapshot reaches subscribers. */
  delayMs = 0;
  writes = 0;
  removes = 0;
  fetches = 0;
  batchFetches = 0;
  batchWrites = 0;

  private table(organizationId: string): Map<string, RemoteFile> {
    let table = this.rows.get(organizationId);
    if (!table) this.rows.set(organizationId, (table = new Map()));
    return table;
  }

  snapshot(organizationId: string): RemoteFileMeta[] {
    return [...this.table(organizationId).values()].sort((a, b) => a.path.localeCompare(b.path)).map(meta);
  }

  async fetch(organizationId: string, path: string): Promise<RemoteFile | null> {
    await this.check();
    this.fetches++;
    const row = this.table(organizationId).get(path);
    return row ? { ...row } : null;
  }

  async fetchMany(organizationId: string, paths: string[]): Promise<RemoteFile[]> {
    await this.check();
    this.batchFetches++;
    const table = this.table(organizationId);
    return paths.flatMap((path) => { const row = table.get(path); return row ? [{ ...row }] : []; });
  }

  /** The live text at a path, or null when absent or a tombstone. */
  text(organizationId: string, path: string): string | null {
    const row = this.table(organizationId).get(path);
    return row && !row.deleted ? row.text : null;
  }

  version(organizationId: string, path: string): number | undefined {
    return this.table(organizationId).get(path)?.version;
  }

  setOffline(offline: boolean): void {
    this.offline = offline;
    if (!offline) for (const organizationId of [...this.held]) this.notify(organizationId);
  }

  subscribe(organizationId: string, onSnapshot: Subscriber, _onError: (error: Error) => void): () => void {
    let set = this.subscribers.get(organizationId);
    if (!set) this.subscribers.set(organizationId, (set = new Set()));
    set.add(onSnapshot);
    setTimeout(() => {
      if (set!.has(onSnapshot) && !this.offline) onSnapshot(this.snapshot(organizationId));
      else if (this.offline) this.held.add(organizationId);
    }, this.delayMs);
    return () => {
      set!.delete(onSnapshot);
    };
  }

  private notify(organizationId: string): void {
    if (this.offline) {
      this.held.add(organizationId);
      return;
    }
    this.held.delete(organizationId);
    const snapshot = this.snapshot(organizationId);
    for (const subscriber of this.subscribers.get(organizationId) ?? []) {
      setTimeout(() => {
        if (this.subscribers.get(organizationId)?.has(subscriber)) subscriber(snapshot);
      }, this.delayMs);
    }
  }

  private async check(): Promise<void> {
    if (this.offline) throw new Error("offline");
  }

  async write(organizationId: string, path: string, text: string, hash: string, expectedVersion: number | null): Promise<WriteOutcome> {
    await this.check();
    const table = this.table(organizationId);
    const row = table.get(path);
    if (expectedVersion === null) {
      if (row && !row.deleted) return { status: "conflict", current: { ...row } };
    } else {
      if (!row) return { status: "conflict", current: null };
      if (row.version !== expectedVersion) return { status: "conflict", current: { ...row } };
    }
    const version = (row?.version ?? 0) + 1;
    table.set(path, { path, text, hash, version, deleted: false, updatedAt: Date.now(), updatedBy: "test" });
    this.writes++;
    this.notify(organizationId);
    return { status: "ok", version };
  }

  async remove(organizationId: string, path: string, expectedVersion: number): Promise<WriteOutcome> {
    await this.check();
    const table = this.table(organizationId);
    const row = table.get(path);
    if (!row) return { status: "conflict", current: null };
    if (row.version !== expectedVersion) return { status: "conflict", current: { ...row } };
    const version = row.version + 1;
    table.set(path, { ...row, text: "", hash: "", version, deleted: true, updatedAt: Date.now() });
    this.removes++;
    this.notify(organizationId);
    return { status: "ok", version };
  }

  async writeMany(organizationId: string, files: Array<{ path: string; text: string; hash: string }>): Promise<void> {
    this.batchWrites++;
    await this.check();
    const table = this.table(organizationId);
    for (const file of files) {
      const row = table.get(file.path);
      table.set(file.path, {
        ...file,
        version: (row?.version ?? 0) + 1,
        deleted: false,
        updatedAt: Date.now(),
        updatedBy: "test",
      });
    }
    this.notify(organizationId);
  }
}
