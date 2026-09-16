/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One writer at a time per project folder. The inspector's write-back reads a
// file, edits the tree and writes it; sync reads a file, checks it is what it
// decided against and writes it. Interleave the two and one of them writes
// over the other's result. Both take this lock around their read-and-write,
// keyed by the folder, so an edit always lands on the text that is there.

import { resolve } from "node:path";

const tails = new Map<string, Promise<void>>();

/** Runs `task` once every earlier task for the same folder has finished. */
export function withProjectLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(dir);
  const previous = tails.get(key) ?? Promise.resolve();
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
