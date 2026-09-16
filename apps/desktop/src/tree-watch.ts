/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One way to watch a folder tree. Node's own `fs.watch(dir, { recursive })`
// is not it: on Linux it watches files by inode, and every write the app
// makes replaces the inode (a temp file renamed over the target, see
// atomic.ts). The first replacement is reported as the old inode's removal;
// after that the file is invisible to the watcher for good — sync stopped
// after the first change, and nothing said why. chokidar watches
// directories and follows renames on every platform.

import { watch, type FSWatcher } from "chokidar";
import { basename, relative, sep } from "node:path";

import { TEMP_PREFIX } from "./atomic";

/** Trees no watcher wants: installs churn constantly, and .git is not the app's. */
const NEVER_WATCHED: ReadonlySet<string> = new Set(["node_modules", ".git"]);

export type TreeWatcher = {
  /** Resolves once the tree is being watched; events before then are dropped. */
  ready: Promise<void>;
  close(): Promise<void>;
};

export type TreeWatchOptions = {
  /** Called with every path that changed, `dir`-relative and `/`-separated. */
  onChange: (path: string) => void;
  onError?: (error: Error) => void;
};

/**
 * Reports every file or folder added, changed or removed under `dir`. The
 * app's temp files and the never-watched trees are left out; anything else
 * is reported as it is, for the caller to filter.
 */
export function watchTree(dir: string, { onChange, onError }: TreeWatchOptions): TreeWatcher {
  const watcher: FSWatcher = watch(dir, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (path) => {
      const name = basename(path);
      return path !== dir && (NEVER_WATCHED.has(name) || name.startsWith(TEMP_PREFIX));
    },
  });
  const report = (absolute: string) => {
    const path = relative(dir, absolute);
    if (path) onChange(path.split(sep).join("/"));
  };
  for (const event of ["add", "change", "unlink", "addDir", "unlinkDir"] as const) watcher.on(event, report);
  watcher.on("error", (error) => onError?.(error instanceof Error ? error : new Error(String(error))));
  const ready = new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  return { ready, close: () => watcher.close() };
}
