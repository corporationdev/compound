/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The main process's view of every checkout it keeps in sync: one Convex
// client, one `WorkspaceSync` per open workspace folder, status pushed to
// the window as events. The renderer says which folder is which
// organization's workspace and hands over the signed native session it
// holds; JWTs for the Convex connection are minted from that session here.

import { basename } from "node:path";

import type { BrowserWindow } from "electron";

import { authRequest, cloudConfig } from "../cloud";
import { MAIN_CHANNELS } from "../main-channels";
import { mainBridge } from "../main-manager";
import { ConvexSyncBackend } from "./convex-backend";
import { WorkspaceSync } from "./workspace-sync";

import type { CloudAssetMeta } from "../assets-transfers";
import type { SyncStatus } from "./workspace-sync";
import type { SyncBackend } from "./backend";

export type SyncStartRequest = { dir: string; organizationId: string; sessionToken: string };

export class SyncManager {
  private backend: ConvexSyncBackend | SyncBackend | undefined;
  private sessionToken: string | null = null;
  private readonly syncs = new Map<string, WorkspaceSync>();
  private window: BrowserWindow | null = null;

  /** Tests hand in their own backend; the app builds a Convex one on first use. */
  constructor(backend?: SyncBackend) {
    this.backend = backend;
  }

  attach(window: BrowserWindow | null): void {
    this.window = window;
  }

  private async fetchToken(): Promise<string | null> {
    if (!this.sessionToken) return null;
    const result = await authRequest("token", undefined, this.sessionToken);
    // The auth server may rotate the signed session; keep what it issued.
    if (result.sessionToken && result.sessionToken !== this.sessionToken) this.sessionToken = result.sessionToken;
    if (!result.sessionToken) this.sessionToken = null;
    return (result.data as { token?: string } | null)?.token ?? null;
  }

  private async ensureBackend(sessionToken: string): Promise<SyncBackend> {
    this.sessionToken = sessionToken;
    if (!this.backend) {
      const config = await cloudConfig();
      this.backend = new ConvexSyncBackend(config.convexUrl, () => this.fetchToken());
    }
    return this.backend;
  }

  /** The signed session changed (sign-in, sign-out): every connection follows it. */
  async setSession(sessionToken: string | null): Promise<void> {
    this.sessionToken = sessionToken;
    if (!sessionToken) await this.stopAll();
  }

  /** A Convex JWT for the signed-in user, minted from the session the renderer handed over; null when signed out. */
  token(): Promise<string | null> {
    return this.fetchToken();
  }

  /**
   * The organization's asset list, for the transfer manager: rides the same
   * Convex connection. Errors until a workspace has started syncing, since
   * that is what brings the session here.
   */
  subscribeAssets(organizationId: string, onSnapshot: (assets: CloudAssetMeta[]) => void, onError: (error: Error) => void): () => void {
    const backend = this.backend;
    if (!backend?.subscribeAssets) {
      onError(new Error("Not connected to the cloud"));
      return () => {};
    }
    return backend.subscribeAssets(organizationId, onSnapshot, onError);
  }

  status(dir: string): SyncStatus | null {
    return this.syncs.get(dir)?.status ?? null;
  }

  /** The project folders the cloud knows under `dir`, or null when it is not syncing. */
  projectRoots(dir: string): ReadonlySet<string> | null {
    return this.syncs.get(dir)?.projectRoots ?? null;
  }

  /**
   * Starts keeping `dir` in step with the organization's workspace; a folder
   * already syncing it is left alone. A folder with files and no sync
   * history has them pushed up as creates by the engine's startup
   * reconcile, so binding a folder for the first time is this same call.
   */
  async start({ dir, organizationId, sessionToken }: SyncStartRequest): Promise<SyncStatus> {
    const existing = this.syncs.get(dir);
    if (existing && existing.organizationId === organizationId) {
      this.sessionToken = sessionToken;
      return existing.status;
    }
    if (existing) await this.stop(dir);
    const backend = await this.ensureBackend(sessionToken);
    const sync = new WorkspaceSync({
      dir,
      organizationId,
      backend,
      onStatus: (status) => this.emit(MAIN_CHANNELS.SYNC_STATUS, { dir, status }),
      onConflict: (notice) => this.emit(MAIN_CHANNELS.SYNC_CONFLICT, { dir, ...notice }),
    });
    this.syncs.set(dir, sync);
    try {
      await sync.start();
    } catch (error) {
      this.syncs.delete(dir);
      await sync.stop();
      throw error;
    }
    return sync.status;
  }

  async stop(dir: string): Promise<void> {
    const sync = this.syncs.get(dir);
    if (!sync) return;
    this.syncs.delete(dir);
    await sync.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.syncs.keys()].map((dir) => this.stop(dir)));
  }

  private emit<C extends typeof MAIN_CHANNELS.SYNC_STATUS | typeof MAIN_CHANNELS.SYNC_CONFLICT>(
    channel: C,
    data: C extends typeof MAIN_CHANNELS.SYNC_STATUS
      ? { dir: string; status: SyncStatus }
      : { dir: string; path: string; keptCopy: string },
  ): void {
    if (!this.window || this.window.isDestroyed()) return;
    mainBridge.emit(this.window, channel, data as never);
  }
}

export const syncManager = new SyncManager();

/** For log lines: the folder without its parents. */
export const shortDir = (dir: string): string => basename(dir);
