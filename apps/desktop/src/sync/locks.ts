/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One writer at a time per folder tree. The inspector's write-back reads a
// project file, edits the tree and writes it; sync reads a workspace file,
// checks it is what it decided against and writes it. Interleave the two and
// one of them writes over the other's result. Both take this lock around
// their read-and-write, keyed by the folder, so an edit always lands on the
// text that is there.
//
// Folders nest: a project sits inside the workspace, and the workspace sync
// writes the project's files. So a lock on a folder also waits for the locks
// held on any folder above or below it, which is what makes a lock on the
// workspace and a lock on a project inside it exclude each other.

import { resolve, sep } from "node:path";

const tails = new Map<string, Promise<void>>();

const isNested = (a: string, b: string): boolean =>
  a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep);

/** Runs `task` once every earlier task for the same folder, or one nested with it, has finished. */
export function withProjectLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(dir);
  const related: Promise<void>[] = [];
  for (const [other, tail] of tails) if (isNested(key, other)) related.push(tail);
  const previous = Promise.all(related).then(() => { });
  let release: () => void = () => { };
  const held = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.then(() => held);
  tails.set(key, tail);
  return previous.then(task).finally(() => {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  });
}
