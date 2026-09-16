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

  private table(projectId: string): Map<string, RemoteFile> {
    let table = this.rows.get(projectId);
    if (!table) this.rows.set(projectId, (table = new Map()));
    return table;
  }

  snapshot(projectId: string): RemoteFileMeta[] {
    return [...this.table(projectId).values()].sort((a, b) => a.path.localeCompare(b.path)).map(meta);
  }

  async fetch(projectId: string, path: string): Promise<RemoteFile | null> {
    await this.check();
    const row = this.table(projectId).get(path);
    return row ? { ...row } : null;
  }

  /** The live text at a path, or null when absent or a tombstone. */
  text(projectId: string, path: string): string | null {
    const row = this.table(projectId).get(path);
    return row && !row.deleted ? row.text : null;
  }

  version(projectId: string, path: string): number | undefined {
    return this.table(projectId).get(path)?.version;
  }

  setOffline(offline: boolean): void {
    this.offline = offline;
    if (!offline) for (const projectId of [...this.held]) this.notify(projectId);
  }

  subscribe(projectId: string, onSnapshot: Subscriber, _onError: (error: Error) => void): () => void {
    let set = this.subscribers.get(projectId);
    if (!set) this.subscribers.set(projectId, (set = new Set()));
    set.add(onSnapshot);
    setTimeout(() => {
      if (set!.has(onSnapshot) && !this.offline) onSnapshot(this.snapshot(projectId));
      else if (this.offline) this.held.add(projectId);
    }, this.delayMs);
    return () => {
      set!.delete(onSnapshot);
    };
  }

  private notify(projectId: string): void {
    if (this.offline) {
      this.held.add(projectId);
      return;
    }
    this.held.delete(projectId);
    const snapshot = this.snapshot(projectId);
    for (const subscriber of this.subscribers.get(projectId) ?? []) {
      setTimeout(() => {
        if (this.subscribers.get(projectId)?.has(subscriber)) subscriber(snapshot);
      }, this.delayMs);
    }
  }

  private async check(): Promise<void> {
    if (this.offline) throw new Error("offline");
  }

  async write(projectId: string, path: string, text: string, hash: string, expectedVersion: number | null): Promise<WriteOutcome> {
    await this.check();
    const table = this.table(projectId);
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
    this.notify(projectId);
    return { status: "ok", version };
  }

  async remove(projectId: string, path: string, expectedVersion: number): Promise<WriteOutcome> {
    await this.check();
    const table = this.table(projectId);
    const row = table.get(path);
    if (!row) return { status: "conflict", current: null };
    if (row.version !== expectedVersion) return { status: "conflict", current: { ...row } };
    const version = row.version + 1;
    table.set(path, { ...row, text: "", hash: "", version, deleted: true, updatedAt: Date.now() });
    this.removes++;
    this.notify(projectId);
    return { status: "ok", version };
  }

  async writeMany(projectId: string, files: Array<{ path: string; text: string; hash: string }>): Promise<void> {
    await this.check();
    const table = this.table(projectId);
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
    this.notify(projectId);
  }
}
