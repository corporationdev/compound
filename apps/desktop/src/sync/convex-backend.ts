/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The sync backend over Convex: one WebSocket client for the main process,
// subscriptions through `files.list`, versioned writes through `files.write`
// and `files.remove`. Auth is a token fetcher the app supplies; the client
// re-asks it when a JWT expires.

import { ConvexClient } from "convex/browser";
import { api } from "@compound/backend/convex/_generated/api";

import type { CloudAssetMeta } from "../assets-transfers";
import type { RemoteFile, RemoteFileMeta, SyncBackend, WriteOutcome } from "./backend";

export type TokenFetcher = (args: { forceRefreshToken: boolean }) => Promise<string | null>;

export class ConvexSyncBackend implements SyncBackend {
  readonly client: ConvexClient;

  constructor(convexUrl: string, fetchToken: TokenFetcher) {
    this.client = new ConvexClient(convexUrl, { unsavedChangesWarning: false });
    this.client.setAuth(fetchToken);
  }

  subscribe(organizationId: string, onSnapshot: (files: RemoteFileMeta[]) => void, onError: (error: Error) => void): () => void {
    const unsubscribe = this.client.onUpdate(
      api.files.list,
      { organizationId },
      (files) => onSnapshot(files as RemoteFileMeta[]),
      onError,
    );
    return () => unsubscribe();
  }

  /** The organization's asset list, now and on every change; for the transfer manager. */
  subscribeAssets(organizationId: string, onSnapshot: (assets: CloudAssetMeta[]) => void, onError: (error: Error) => void): () => void {
    const unsubscribe = this.client.onUpdate(
      api.assets.list,
      { organizationId },
      (assets) => onSnapshot(assets as CloudAssetMeta[]),
      onError,
    );
    return () => unsubscribe();
  }

  fetch(organizationId: string, path: string): Promise<RemoteFile | null> {
    return this.client.query(api.files.get, { organizationId, path }) as Promise<RemoteFile | null>;
  }

  fetchMany(organizationId: string, paths: string[]): Promise<RemoteFile[]> {
    return this.client.query(api.files.getMany, { organizationId, paths }) as Promise<RemoteFile[]>;
  }

  write(organizationId: string, path: string, text: string, hash: string, expectedVersion: number | null): Promise<WriteOutcome> {
    return this.client.mutation(api.files.write, { organizationId, path, text, hash, expectedVersion }) as Promise<WriteOutcome>;
  }

  remove(organizationId: string, path: string, expectedVersion: number): Promise<WriteOutcome> {
    return this.client.mutation(api.files.remove, { organizationId, path, expectedVersion }) as Promise<WriteOutcome>;
  }

  async writeMany(organizationId: string, files: Array<{ path: string; text: string; hash: string }>): Promise<void> {
    await this.client.mutation(api.files.writeMany, { organizationId, files });
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
