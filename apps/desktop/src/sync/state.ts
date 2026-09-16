/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What a checkout remembers between runs: for every synced path, the version
// it last agreed with the cloud on and the hash of that text; and the text
// itself, so a later local edit can be merged three ways against the cloud's
// next version. All of it lives under the app's folder in the project, which
// git and the project watcher already ignore.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic";

/** The last agreed version of a path. A hash of "" marks a tombstone. */
export type FileState = { version: number; hash: string };

export const TOMBSTONE_HASH = "";

type Persisted = { projectId: string; files: Record<string, FileState> };

export const SYNC_DIR = ".compound/sync";

export class SyncStore {
  readonly dir: string;
  readonly projectId: string;
  private files = new Map<string, FileState>();
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(dir: string, projectId: string) {
    this.dir = dir;
    this.projectId = projectId;
  }

  private get root(): string {
    return join(this.dir, ...SYNC_DIR.split("/"));
  }

  private get statePath(): string {
    return join(this.root, "state.json");
  }

  private basePath(path: string): string {
    return join(this.root, "base", ...path.split("/"));
  }

  async load(): Promise<void> {
    await mkdir(join(this.root, "base"), { recursive: true });
    let parsed: Persisted;
    try {
      parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Persisted;
    } catch {
      // No state yet: a fresh checkout, or a publish that has not synced.
      return;
    }
    // A checkout of one project must not be pointed at another: its files
    // would go up as that project's, over whatever was there. The binding in
    // package.json is text anyone can edit; this record is not.
    if (parsed.projectId !== this.projectId) {
      throw new Error(
        `This folder is a checkout of a different cloud project. Remove ${SYNC_DIR} to start over.`,
      );
    }
    for (const [path, state] of Object.entries(parsed.files ?? {})) {
      if (typeof state?.version === "number" && typeof state.hash === "string") this.files.set(path, state);
    }
  }

  get(path: string): FileState | undefined {
    return this.files.get(path);
  }

  set(path: string, state: FileState): void {
    this.files.set(path, state);
    this.scheduleSave();
  }

  delete(path: string): void {
    this.files.delete(path);
    this.scheduleSave();
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  async readBase(path: string): Promise<string | null> {
    try {
      return await readFile(this.basePath(path), "utf8");
    } catch {
      return null;
    }
  }

  async writeBase(path: string, text: string): Promise<void> {
    const target = this.basePath(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }

  async removeBase(path: string): Promise<void> {
    await rm(this.basePath(path), { force: true });
  }


  private scheduleSave(): void {
    this.dirty = true;
    this.saving = this.saving.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const persisted: Persisted = { projectId: this.projectId, files: Object.fromEntries(this.files) };
      await mkdir(this.root, { recursive: true });
      await writeFileAtomic(this.statePath, JSON.stringify(persisted, null, 2) + "\n");
    }).catch(() => { });
  }

  /** Resolves once every queued save has landed. */
  flush(): Promise<void> {
    return this.saving;
  }
}
