/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The main process's view of every checkout it keeps in sync: one Convex
// client, one `ProjectSync` per open cloud project, status pushed to the
// window as events. The renderer says which folder belongs to which cloud
// project and hands over the signed native session it holds; JWTs for the
// Convex connection are minted from that session here.

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { BrowserWindow } from "electron";

import { authRequest, cloudConfig } from "../cloud";
import { MAIN_CHANNELS } from "../main-channels";
import { mainBridge } from "../main-manager";
import { ConvexSyncBackend } from "./convex-backend";
import { ProjectSync, publishFolder } from "./project-sync";

import type { SyncStatus } from "./project-sync";
import type { SyncBackend } from "./backend";

export type SyncStartRequest = { dir: string; projectId: string; sessionToken: string };

export class SyncManager {
  private backend: ConvexSyncBackend | SyncBackend | undefined;
  private sessionToken: string | null = null;
  private readonly syncs = new Map<string, ProjectSync>();
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

  status(dir: string): SyncStatus | null {
    return this.syncs.get(dir)?.status ?? null;
  }

  /** Starts keeping `dir` in step with `projectId`; a folder already syncing that project is left alone. */
  async start({ dir, projectId, sessionToken }: SyncStartRequest): Promise<SyncStatus> {
    const existing = this.syncs.get(dir);
    if (existing && existing.projectId === projectId) {
      this.sessionToken = sessionToken;
      return existing.status;
    }
    if (existing) await this.stop(dir);
    const backend = await this.ensureBackend(sessionToken);
    const sync = new ProjectSync({
      dir,
      projectId,
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

  /** Pushes every syncable file of a local folder up as the project's rows, then starts syncing it. */
  async publish({ dir, projectId, sessionToken }: SyncStartRequest): Promise<{ files: number; status: SyncStatus }> {
    const backend = await this.ensureBackend(sessionToken);
    await this.stop(dir);
    const files = await publishFolder(dir, projectId, backend);
    const status = await this.start({ dir, projectId, sessionToken });
    return { files, status };
  }

  /**
   * Gives a cloud project a folder on this machine: an empty one under
   * `root`, filled by the first snapshot. Returns the folder.
   */
  async materialize({ root, projectId, name, sessionToken }: { root: string; projectId: string; name: string; sessionToken: string }): Promise<string> {
    const dir = await freeFolder(root, folderName(name));
    await mkdir(dir, { recursive: true });
    await this.start({ dir, projectId, sessionToken });
    return dir;
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

/** A folder name a project may be given on disk: what the record calls it, made safe. */
export function folderName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return cleaned || "project";
}

/** `base`, or `base-2`, `base-3`... when the folder is taken. */
async function freeFolder(root: string, base: string): Promise<string> {
  const { stat } = await import("node:fs/promises");
  const taken = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
  let name = base;
  for (let i = 2; await taken(join(root, name)); i++) name = `${base}-${i}`;
  return join(root, name);
}

export const syncManager = new SyncManager();

/** For log lines: the folder without its parents. */
export const shortDir = (dir: string): string => basename(dir);
