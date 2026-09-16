/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Every asset transfer of every open project, in one place: what this
// machine still has to send, what it is bringing down, what it is waiting
// on another machine to finish, and how far along each is. The renderer
// tells it which assets have bytes here; the organization's asset list from
// Convex tells it what the cloud holds; the difference is the work.
//
// Up: every local original, and the proxy of every local video (made by the
// renderer, which has the codecs; this only sends it). Down: every proxy the
// cloud has for an asset missing here, straight away, so a project is
// playable on a second machine long before its originals are; originals
// only when asked for (export, or a fetch that prefers them) unless the
// caller opted into bringing them down in the background too.
//
// Failures retry with backoff a few times and then wait for a hand; a fetch
// for something another machine has not finished sending waits on the list
// instead of failing.

import { fetchAssetVariant, fileSize, originalCachePath, proxyCachePath, uploadAssetOriginal, uploadAssetProxy } from "./assets-cloud";

import type { AssetVariant, FetchRequest, FetchResponse, ProgressCallback, UploadOriginalRequest, UploadProxyRequest } from "./assets-cloud";

/** One row of the organization's asset list, as Convex publishes it. */
export type CloudAssetMeta = {
  assetId: string;
  sampleId: string;
  name: string;
  mimeType: string;
  size: number;
  originalState: "uploading" | "ready";
  proxyState: "uploading" | "ready" | null;
  proxySize: number | null;
  updatedAt: number;
};

/** A library asset whose bytes are on this machine, as the renderer reports it. */
export type LocalAssetInfo = {
  sampleId: string;
  /** Absolute path of the file. */
  source: string;
  mimeType: string;
  name: string;
  /** The library's asset type: only VIDEO gets a proxy. */
  type: string;
};

export type TransferKind = "upload" | "download";
export type TransferPhase = "queued" | "active" | "waiting" | "failed" | "done";

export type AssetTransfer = {
  sampleId: string;
  name: string;
  kind: TransferKind;
  variant: AssetVariant;
  phase: TransferPhase;
  bytes: number;
  total: number;
  attempts: number;
  error?: string;
};

export type AssetsSnapshot = {
  dir: string;
  transfers: AssetTransfer[];
  /** Local videos with no proxy here or in the cloud: the renderer makes one. */
  proxyWanted: string[];
  /** What the cloud holds for each sample this project knows, by sample id. */
  cloud: Record<string, { original: "none" | "uploading" | "ready"; proxy: "none" | "uploading" | "ready" }>;
  summary: { uploading: number; downloading: number; waiting: number; failed: number; bytesLeft: number };
  /** Why the cloud's asset list is not available, while it is not. */
  error?: string;
};

export type AttachRequest = { dir: string; organizationId: string; local: LocalAssetInfo[]; eagerOriginals: boolean };

/** The moving of bytes, behind a seam so the manager's logic runs in a test without a network. */
export interface AssetCloud {
  uploadOriginal(request: UploadOriginalRequest, onProgress: ProgressCallback, signal: AbortSignal): Promise<unknown>;
  uploadProxy(request: UploadProxyRequest, onProgress: ProgressCallback, signal: AbortSignal): Promise<unknown>;
  download(request: FetchRequest, onProgress: ProgressCallback, signal: AbortSignal): Promise<FetchResponse>;
}

/** The organization's asset list, now and on every change. */
export type AssetsFeed = (organizationId: string, onSnapshot: (assets: CloudAssetMeta[]) => void, onError: (error: Error) => void) => () => void;

export const realAssetCloud: AssetCloud = {
  uploadOriginal: (request, onProgress, signal) => uploadAssetOriginal(request, onProgress, signal),
  uploadProxy: (request, onProgress, signal) => uploadAssetProxy(request, onProgress, signal),
  download: (request, onProgress, signal) => fetchAssetVariant(request, onProgress, signal),
};

const UPLOAD_CONCURRENCY = 2;
const DOWNLOAD_CONCURRENCY = 2;
/** Delays before each retry; the last repeats for as long as the project is open. A transfer is never given up on: the cloud may be down for a while. */
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];
/** How long a fetch waits for another machine to finish sending before it gives up. */
const WAIT_LIMIT_MS = 15 * 60_000;
const EMIT_DELAY_MS = 150;
const FEED_RETRY_MS = 5_000;

type Transfer = AssetTransfer & {
  done: Promise<FetchResponse | void>;
  finish: (value: FetchResponse | void) => void;
  fail: (error: Error) => void;
  abort: AbortController;
  retryTimer?: ReturnType<typeof setTimeout>;
};

type Waiter = { variant: AssetVariant; check: () => boolean; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

const keyOf = (kind: TransferKind, variant: AssetVariant, sampleId: string) => `${kind}:${variant}:${sampleId}`;
const isVideo = (mimeType: string) => mimeType.startsWith("video/");

export type ProjectAssetsOptions = {
  dir: string;
  organizationId: string;
  cloud: AssetCloud;
  feed: AssetsFeed;
  getToken: () => Promise<string | null>;
  onChange: (snapshot: AssetsSnapshot) => void;
  /** Retry delays, for tests. */
  retryDelays?: number[];
  /** How long to wait before asking for a failed feed again, for tests. */
  feedRetryMs?: number;
};

/** The transfers of one project folder. */
export class ProjectAssets {
  readonly dir: string;
  readonly organizationId: string;
  private readonly options: ProjectAssetsOptions;
  private local = new Map<string, LocalAssetInfo>();
  private cloud = new Map<string, CloudAssetMeta>();
  private cloudKnown = false;
  private eagerOriginals = false;
  private readonly transfers = new Map<string, Transfer>();
  private readonly waiters = new Set<Waiter>();
  private readonly proxyWanted = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  private reconciling: Promise<void> = Promise.resolve();
  private reconcileAgain = false;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private feedError: string | undefined;
  private feedRetry: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ProjectAssetsOptions) {
    this.options = options;
    this.dir = options.dir;
    this.organizationId = options.organizationId;
  }

  start(): void {
    this.subscribeFeed();
  }

  /** Follows the organization's asset list; a feed that fails (signed out, not connected yet) is asked for again after a pause. */
  private subscribeFeed(): void {
    if (this.stopped) return;
    this.unsubscribe?.();
    this.unsubscribe = this.options.feed(
      this.organizationId,
      (assets) => {
        this.cloud = new Map(assets.map((asset) => [asset.sampleId, asset]));
        this.cloudKnown = true;
        this.feedError = undefined;
        this.settleWaiters();
        this.scheduleReconcile();
      },
      (error) => {
        this.feedError = error.message;
        console.warn(`[assets] ${this.dir}: asset list unavailable (${error.message}); retrying`);
        this.emitSoon();
        if (this.feedRetry) clearTimeout(this.feedRetry);
        this.feedRetry = setTimeout(() => {
          this.feedRetry = undefined;
          this.subscribeFeed();
        }, this.options.feedRetryMs ?? FEED_RETRY_MS);
      },
    );
  }

  /** The renderer's latest word on which assets have bytes here, and whether originals come down unasked. */
  setLocal(local: LocalAssetInfo[], eagerOriginals: boolean): void {
    this.local = new Map(local.map((asset) => [asset.sampleId, asset]));
    this.eagerOriginals = eagerOriginals;
    this.scheduleReconcile();
  }

  /** Puts a failed transfer back in the queue, as a fresh attempt. */
  retry(sampleId: string): void {
    for (const transfer of [...this.transfers.values()]) {
      if (transfer.sampleId !== sampleId || transfer.phase !== "failed") continue;
      if (transfer.retryTimer) clearTimeout(transfer.retryTimer);
      transfer.retryTimer = undefined;
      transfer.phase = "queued";
    }
    this.pump();
    this.emitSoon();
  }

  /**
   * The bytes of an asset missing here, as a cached file: the proxy when it
   * is preferred and the cloud has or is making one, else the original.
   * Waits on another machine's upload rather than failing while it is
   * under way.
   */
  async fetch(sampleId: string, prefer: AssetVariant): Promise<FetchResponse> {
    for (;;) {
      const variant = await this.chooseVariant(sampleId, prefer);
      const cached = await this.cachedPath(sampleId, variant);
      if (cached) {
        const meta = this.cloud.get(sampleId);
        return { path: cached, name: variant === "proxy" ? `${sampleId}.mp4` : meta?.name ?? sampleId, mimeType: variant === "proxy" ? "video/mp4" : meta?.mimeType ?? "" };
      }
      if (this.isReady(sampleId, variant)) {
        const transfer = this.ensure("download", variant, sampleId);
        this.pump();
        return (await transfer.done) ?? null;
      }
      // Not there yet: wait for the cloud to move, then decide again — a
      // proxy that was hoped for may never come, and the original will do.
      await this.waitFor(sampleId, variant);
    }
  }

  private async chooseVariant(sampleId: string, prefer: AssetVariant): Promise<AssetVariant> {
    if (prefer === "original") return "original";
    if (await this.cachedPath(sampleId, "proxy")) return "proxy";
    const meta = this.cloud.get(sampleId);
    if (!meta) return "proxy";
    if (meta.proxyState) return "proxy";
    // A video the cloud has no proxy for yet: one is coming while the
    // original is still going up; an original that is ready with none was
    // sent before proxies existed, and is all there will be.
    if (isVideo(meta.mimeType) && meta.originalState !== "ready") return "proxy";
    return "original";
  }

  private isReady(sampleId: string, variant: AssetVariant): boolean {
    const meta = this.cloud.get(sampleId);
    if (!meta) return false;
    return variant === "proxy" ? meta.proxyState === "ready" : meta.originalState === "ready";
  }

  /**
   * Whether what a fetch of `variant` waits on has arrived: the variant
   * itself, or, for a proxy, the original with no proxy on its way — that
   * asset will never have one, and the fetch falls back to the original.
   */
  private settled(sampleId: string, variant: AssetVariant): boolean {
    if (this.isReady(sampleId, variant)) return true;
    const meta = this.cloud.get(sampleId);
    return variant === "proxy" && !!meta && meta.originalState === "ready" && meta.proxyState === null;
  }

  private waitFor(sampleId: string, variant: AssetVariant): Promise<void> {
    if (this.settled(sampleId, variant)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        variant,
        check: () => this.settled(sampleId, variant),
        resolve: () => { clearTimeout(waiter.timer); this.waiters.delete(waiter); this.dropWaiting(sampleId, variant); resolve(); },
        reject: (error) => { clearTimeout(waiter.timer); this.waiters.delete(waiter); this.dropWaiting(sampleId, variant); reject(error); },
        timer: setTimeout(() => waiter.reject(new Error(`${sampleId} is not in the cloud yet`)), WAIT_LIMIT_MS),
      };
      this.waiters.add(waiter);
      const meta = this.cloud.get(sampleId);
      const key = keyOf("download", variant, sampleId);
      if (!this.transfers.has(key)) {
        this.transfers.set(key, this.makeTransfer("download", variant, sampleId, meta?.name ?? sampleId, 0, "waiting"));
      }
      this.emitSoon();
    });
  }

  private dropWaiting(sampleId: string, variant: AssetVariant): void {
    const key = keyOf("download", variant, sampleId);
    const transfer = this.transfers.get(key);
    if (transfer?.phase === "waiting") this.transfers.delete(key);
  }

  private settleWaiters(): void {
    for (const waiter of [...this.waiters]) if (waiter.check()) waiter.resolve();
  }

  private async cachedPath(sampleId: string, variant: AssetVariant): Promise<string | null> {
    const meta = this.cloud.get(sampleId);
    if (variant === "proxy") {
      const path = proxyCachePath(this.dir, sampleId);
      const size = await fileSize(path);
      if (size === null) return null;
      // Made here and not yet in the cloud, or fetched at the cloud's size.
      return !meta?.proxySize || meta.proxySize === size ? path : null;
    }
    if (!meta) return null;
    const path = originalCachePath(this.dir, sampleId, meta.name);
    return (await fileSize(path)) === meta.size ? path : null;
  }

  private scheduleReconcile(): void {
    if (this.stopped) return;
    if (this.reconcileAgain) return;
    this.reconcileAgain = true;
    this.reconciling = this.reconciling.then(async () => {
      this.reconcileAgain = false;
      await this.reconcile().catch((error: unknown) => console.warn(`[assets] ${this.dir}: ${error instanceof Error ? error.message : String(error)}`));
    });
  }

  /** Lines the queue up with what is here and what the cloud has. */
  private async reconcile(): Promise<void> {
    if (this.stopped || !this.cloudKnown) return;
    this.proxyWanted.clear();
    for (const asset of this.local.values()) {
      const meta = this.cloud.get(asset.sampleId);
      if (meta?.originalState !== "ready") this.ensure("upload", "original", asset.sampleId);
      if (asset.type !== "VIDEO" || meta?.proxyState === "ready") continue;
      if (await fileSize(proxyCachePath(this.dir, asset.sampleId)) !== null) {
        // The proxy waits for the original's row: a proxy is registered against it.
        if (meta) this.ensure("upload", "proxy", asset.sampleId);
      } else {
        this.proxyWanted.add(asset.sampleId);
      }
    }
    for (const meta of this.cloud.values()) {
      if (this.local.has(meta.sampleId)) continue;
      if (meta.proxyState === "ready" && !(await this.cachedPath(meta.sampleId, "proxy"))) this.ensure("download", "proxy", meta.sampleId);
      if (this.eagerOriginals && meta.originalState === "ready" && !(await this.cachedPath(meta.sampleId, "original"))) this.ensure("download", "original", meta.sampleId);
    }
    this.pump();
    this.emitSoon();
  }

  private makeTransfer(kind: TransferKind, variant: AssetVariant, sampleId: string, name: string, total: number, phase: TransferPhase): Transfer {
    let finish!: Transfer["finish"];
    let fail!: Transfer["fail"];
    const done = new Promise<FetchResponse | void>((resolve, reject) => { finish = resolve; fail = reject; });
    done.catch(() => {});
    return { sampleId, name, kind, variant, phase, bytes: 0, total, attempts: 0, done, finish, fail, abort: new AbortController() };
  }

  /** The transfer for (kind, variant, sample), queued if there was none. */
  private ensure(kind: TransferKind, variant: AssetVariant, sampleId: string): Transfer {
    const key = keyOf(kind, variant, sampleId);
    const existing = this.transfers.get(key);
    if (existing && existing.phase !== "done" && existing.phase !== "waiting") return existing;
    const meta = this.cloud.get(sampleId);
    const local = this.local.get(sampleId);
    const total = variant === "proxy" ? meta?.proxySize ?? 0 : meta?.size ?? 0;
    const transfer = this.makeTransfer(kind, variant, sampleId, local?.name ?? meta?.name ?? sampleId, total, "queued");
    this.transfers.set(key, transfer);
    return transfer;
  }

  /** Starts queued transfers up to the concurrency of their kind, proxies before originals. */
  private pump(): void {
    if (this.stopped) return;
    for (const kind of ["upload", "download"] as const) {
      const limit = kind === "upload" ? UPLOAD_CONCURRENCY : DOWNLOAD_CONCURRENCY;
      const all = [...this.transfers.values()].filter((transfer) => transfer.kind === kind);
      let active = all.filter((transfer) => transfer.phase === "active").length;
      const queued = all
        .filter((transfer) => transfer.phase === "queued" && !transfer.retryTimer)
        .sort((a, b) => (a.variant === b.variant ? 0 : a.variant === "proxy" ? -1 : 1));
      for (const transfer of queued) {
        if (active >= limit) break;
        active++;
        void this.run(transfer);
      }
    }
  }

  private async run(transfer: Transfer): Promise<void> {
    transfer.phase = "active";
    transfer.bytes = 0;
    this.emitSoon();
    const progress: ProgressCallback = (bytes, total) => {
      transfer.bytes = bytes;
      transfer.total = total;
      this.emitSoon();
    };
    try {
      const token = await this.options.getToken();
      const signal = transfer.abort.signal;
      let result: FetchResponse | void = undefined;
      if (transfer.kind === "upload") {
        const local = this.local.get(transfer.sampleId);
        if (!local) throw new Error("The asset is no longer in the library");
        if (transfer.variant === "original") {
          await this.options.cloud.uploadOriginal({ dir: this.dir, organizationId: this.organizationId, sampleId: local.sampleId, source: local.source, mimeType: local.mimeType, name: local.name, token }, progress, signal);
        } else {
          const meta = this.cloud.get(transfer.sampleId);
          if (!meta) throw new Error("The original is not registered yet");
          await this.options.cloud.uploadProxy({ dir: this.dir, sampleId: local.sampleId, assetId: meta.assetId, token }, progress, signal);
        }
      } else {
        result = await this.options.cloud.download({ dir: this.dir, organizationId: this.organizationId, sampleId: transfer.sampleId, variant: transfer.variant, token }, progress, signal);
        if (!result) throw new Error(`${transfer.name} is not in the cloud yet`);
      }
      if (this.stopped) return;
      transfer.phase = "done";
      transfer.bytes = transfer.total;
      transfer.finish(result);
      this.transfers.delete(keyOf(transfer.kind, transfer.variant, transfer.sampleId));
    } catch (error) {
      if (this.stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      transfer.attempts++;
      transfer.error = message;
      console.warn(`[assets] ${transfer.kind} of ${transfer.name} (${transfer.variant}) failed on attempt ${transfer.attempts}: ${message}`);
      const delays = this.options.retryDelays ?? RETRY_DELAYS_MS;
      const delay = delays[Math.min(transfer.attempts, delays.length) - 1]!;
      // Listed as failed once the ladder is climbed, so the reason shows and a
      // hand can retry at once; the next attempt is still scheduled.
      transfer.phase = transfer.attempts >= delays.length ? "failed" : "queued";
      transfer.retryTimer = setTimeout(() => {
        transfer.retryTimer = undefined;
        if (transfer.phase === "failed") transfer.phase = "queued";
        this.pump();
      }, delay);
    } finally {
      this.pump();
      this.emitSoon();
    }
  }

  snapshot(): AssetsSnapshot {
    const transfers = [...this.transfers.values()].map(({ sampleId, name, kind, variant, phase, bytes, total, attempts, error }) => ({ sampleId, name, kind, variant, phase, bytes, total, attempts, error }));
    const summary = { uploading: 0, downloading: 0, waiting: 0, failed: 0, bytesLeft: 0 };
    for (const transfer of transfers) {
      if (transfer.phase === "failed") summary.failed++;
      else if (transfer.phase === "waiting") summary.waiting++;
      else if (transfer.kind === "upload") summary.uploading++;
      else summary.downloading++;
      if (transfer.phase === "queued" || transfer.phase === "active") summary.bytesLeft += Math.max(0, transfer.total - transfer.bytes);
    }
    const cloud: AssetsSnapshot["cloud"] = {};
    for (const sampleId of new Set([...this.local.keys(), ...this.cloud.keys()])) {
      const meta = this.cloud.get(sampleId);
      cloud[sampleId] = { original: meta?.originalState ?? "none", proxy: meta?.proxyState ?? "none" };
    }
    return { dir: this.dir, transfers, proxyWanted: [...this.proxyWanted], cloud, summary, error: this.feedError };
  }

  private emitSoon(): void {
    if (this.stopped || this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      if (!this.stopped) this.options.onChange(this.snapshot());
    }, EMIT_DELAY_MS);
  }

  /** Whether the feed has failed, and why. */
  error(): string | undefined {
    return this.feedError;
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.feedRetry) clearTimeout(this.feedRetry);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    for (const transfer of this.transfers.values()) {
      if (transfer.retryTimer) clearTimeout(transfer.retryTimer);
      transfer.abort.abort();
      transfer.fail(new Error("The project was closed"));
    }
    for (const waiter of [...this.waiters]) waiter.reject(new Error("The project was closed"));
    this.transfers.clear();
  }
}

export type AssetTransferManagerOptions = {
  cloud: AssetCloud;
  feed: AssetsFeed;
  getToken: () => Promise<string | null>;
  onChange: (snapshot: AssetsSnapshot) => void;
  retryDelays?: number[];
};

/** One `ProjectAssets` per open project folder. */
export class AssetTransferManager {
  private readonly projects = new Map<string, ProjectAssets>();
  private readonly options: AssetTransferManagerOptions;

  constructor(options: AssetTransferManagerOptions) {
    this.options = options;
  }

  attach(request: AttachRequest): AssetsSnapshot {
    let project = this.projects.get(request.dir);
    if (project && project.organizationId !== request.organizationId) {
      project.stop();
      project = undefined;
    }
    if (!project) {
      project = new ProjectAssets({ ...this.options, dir: request.dir, organizationId: request.organizationId });
      this.projects.set(request.dir, project);
      project.start();
    }
    project.setLocal(request.local, request.eagerOriginals);
    return project.snapshot();
  }

  update(dir: string, local: LocalAssetInfo[], eagerOriginals: boolean): void {
    this.projects.get(dir)?.setLocal(local, eagerOriginals);
  }

  /**
   * The renderer let go of the project (closed it, or is reloading). The
   * transfers carry on: an upload a third of the way through is not undone
   * by a reload, and the next attach picks the project up where it is.
   * Only a change of organization or the app's end stops them.
   */
  detach(_dir: string): void {}

  retry(dir: string, sampleId: string): void {
    this.projects.get(dir)?.retry(sampleId);
  }

  fetch(dir: string, sampleId: string, prefer: AssetVariant): Promise<FetchResponse> {
    const project = this.projects.get(dir);
    if (!project) return Promise.reject(new Error("The project is not attached to the cloud"));
    return project.fetch(sampleId, prefer);
  }

  snapshot(dir: string): AssetsSnapshot | null {
    return this.projects.get(dir)?.snapshot() ?? null;
  }

  stopAll(): void {
    for (const [dir, project] of [...this.projects]) {
      project.stop();
      this.projects.delete(dir);
    }
  }
}
