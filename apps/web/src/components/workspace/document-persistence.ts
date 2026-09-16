/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WorkspaceWriteResult } from '@desktop/main-channels';

type PersistenceOptions = {
  read: () => string;
  apply: (text: string) => void;
  write: (text: string, base: string) => Promise<WorkspaceWriteResult>;
  onError: (error: unknown) => void;
  onConflict: () => void;
};

/** Coordinates the editor, asynchronous disk writes, and file watcher reads. */
export function createDocumentPersistence(initial: string, options: PersistenceOptions) {
  let base = initial;
  let dirty = false;
  let epoch = 0;
  let refreshId = 0;
  let watching = true;
  let writesCancelled = false;
  let pending: Promise<boolean> = Promise.resolve(true);

  const save = (): Promise<boolean> => {
    pending = pending.then(async () => {
      // Continue until edits typed during a write have also reached disk.
      // A caller awaiting save (navigation/unmount) therefore flushes them too.
      while (true) {
        if (writesCancelled) return false;
        const text = options.read();
        if (text === base) {
          dirty = false;
          return true;
        }
        epoch++;
        try {
          const result = await options.write(text, base);
          base = text;
          epoch++;
          const changedDuringWrite = options.read() !== text;
          if (result.status === 'merged') {
            if (!changedDuringWrite) {
              base = result.text;
              options.apply(result.text);
            }
            // If typing continued, leave the editor alone. The next write is
            // based on the submitted snapshot, so main merges the later edit
            // with the merged file without interpreting remote lines as deletions.
            if (result.conflicted) options.onConflict();
          }
          dirty = changedDuringWrite;
          if (!dirty) return true;
        } catch (error) {
          dirty = true;
          epoch++;
          options.onError(error);
          return false;
        }
      }
    });
    return pending;
  };

  return {
    save,
    get dirty() { return dirty; },
    get pending() { return pending; },
    markDirty() { dirty = true; epoch++; },
    stopWatching() { watching = false; refreshId++; },
    // Deletion cannot cancel an IPC already sent, but must prevent queued
    // saves or a follow-up write from recreating the page after it is removed.
    cancelFutureWrites() { writesCancelled = true; },
    async refresh(readRemote: () => Promise<string | null>) {
      const request = ++refreshId;
      await pending;
      if (!watching || dirty || request !== refreshId) return;
      const startedAt = epoch;
      const text = await readRemote();
      // Reads may resolve out of order or after typing/a write; never install
      // that stale snapshot over the current local draft.
      if (!watching || dirty || request !== refreshId || startedAt !== epoch || text === null || text === base) return;
      base = text;
      epoch++;
      options.apply(text);
    },
  };
}
