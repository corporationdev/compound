/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the sync engine needs from the cloud, and nothing more. Convex
// implements it for the app (see `./convex-backend`); tests implement it in
// memory. Keeping the engine behind this seam is what lets the whole
// reconcile / merge / retry logic run in a unit test without a network.

/** One row of `projectFiles`, with its text. Tombstones have `deleted` and empty text. */
export type RemoteFile = {
  path: string;
  text: string;
  hash: string;
  version: number;
  deleted: boolean;
  updatedAt: number;
  updatedBy: string;
};

/**
 * A row without its text: what a subscription delivers. A change then costs
 * every subscriber one small list, and only the rows whose version moved are
 * fetched — rather than the whole project's text on every keystroke.
 */
export type RemoteFileMeta = Omit<RemoteFile, "text">;

/**
 * What a versioned write comes back with. A conflict carries the row as the
 * server holds it now (or null when the path is unknown there), so the caller
 * can merge against it without another round trip.
 */
export type WriteOutcome =
  | { status: "ok"; version: number }
  | { status: "conflict"; current: RemoteFile | null };

export interface SyncBackend {
  /**
   * Delivers the full list of a project's files (tombstones included, no
   * text) now and on every change, until the returned function is called.
   * Errors that end the subscription (signed out, no access) go to `onError`.
   */
  subscribe(
    projectId: string,
    onSnapshot: (files: RemoteFileMeta[]) => void,
    onError: (error: Error) => void,
  ): () => void;

  /** One row with its text, or null when the path has never existed. */
  fetch(projectId: string, path: string): Promise<RemoteFile | null>;

  /**
   * Writes `text` at `path` if the server's version is `expectedVersion`.
   * `null` means create: only succeeds when the path is absent or a tombstone.
   */
  write(
    projectId: string,
    path: string,
    text: string,
    hash: string,
    expectedVersion: number | null,
  ): Promise<WriteOutcome>;

  /** Turns the row at `path` into a tombstone if its version is `expectedVersion`. */
  remove(projectId: string, path: string, expectedVersion: number): Promise<WriteOutcome>;

  /** Force-writes many files at once, no version check. Used to publish a local folder. */
  writeMany(projectId: string, files: Array<{ path: string; text: string; hash: string }>): Promise<void>;
}
