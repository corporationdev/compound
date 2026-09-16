/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The transfer manager's own logic against a fake cloud: what gets queued
// from the difference between local bytes and the cloud's list, waiting on
// another machine's upload, retries, and the snapshot the renderer shows.

import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getAppPath: () => tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: { on: () => { } },
}));

const { ProjectAssets } = await import("./assets-transfers");
type CloudAssetMeta = import("./assets-transfers").CloudAssetMeta;
type AssetCloud = import("./assets-transfers").AssetCloud;
type AssetsSnapshot = import("./assets-transfers").AssetsSnapshot;

const ORG = "org_1";
const VIDEO = "0123456789abcdef";
const AUDIO = "fedcba9876543210";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
let feeds: Array<(assets: CloudAssetMeta[]) => void> = [];
let cloud: CloudAssetMeta[] = [];
let calls: string[] = [];
let snapshots: AssetsSnapshot[] = [];
let failUploads = 0;

const meta = (sampleId: string, over: Partial<CloudAssetMeta> = {}): CloudAssetMeta => ({
  assetId: `id-${sampleId}`, sampleId, name: `${sampleId}.mp4`, mimeType: "video/mp4", size: 10, originalState: "uploading", proxyState: null, proxySize: null, updatedAt: 1, ...over,
});
const publish = (assets: CloudAssetMeta[]) => { cloud = assets; for (const feed of feeds) feed(assets); };

const fakeCloud: AssetCloud = {
  async uploadOriginal(request, onProgress) {
    calls.push(`up:original:${request.sampleId}`);
    if (failUploads > 0) { failUploads--; throw new Error("network"); }
    onProgress(10, 10);
    const known = cloud.some((asset) => asset.sampleId === request.sampleId);
    const updated: CloudAssetMeta[] = cloud.map((asset) => asset.sampleId === request.sampleId ? { ...asset, originalState: "ready" as const } : asset);
    publish(known ? updated : [...updated, meta(request.sampleId, { originalState: "ready", name: request.name, mimeType: request.mimeType })]);
    return { assetId: `id-${request.sampleId}`, state: "ready" };
  },
  async uploadProxy(request) {
    calls.push(`up:proxy:${request.sampleId}`);
    publish(cloud.map((asset) => asset.sampleId === request.sampleId ? { ...asset, proxyState: "ready" as const, proxySize: 3 } : asset));
  },
  async download(request, onProgress) {
    calls.push(`down:${request.variant}:${request.sampleId}`);
    const asset = cloud.find((candidate) => candidate.sampleId === request.sampleId)!;
    const path = request.variant === "proxy" ? join(dir, "cache", "proxies", `${request.sampleId}.mp4`) : join(dir, "cache", "originals", asset.name);
    await mkdir(join(path, ".."), { recursive: true });
    const size = request.variant === "proxy" ? asset.proxySize! : asset.size;
    await writeFile(path, "x".repeat(size));
    onProgress(size, size);
    return { path, name: asset.name, mimeType: asset.mimeType };
  },
};

function project(eager = false) {
  const assets = new ProjectAssets({
    dir, organizationId: ORG, cloud: fakeCloud,
    feed: (_organizationId, onSnapshot) => { feeds.push(onSnapshot); onSnapshot(cloud); return () => { feeds = feeds.filter((feed) => feed !== onSnapshot); }; },
    getToken: async () => "jwt",
    onChange: (snapshot) => snapshots.push(snapshot),
    retryDelays: [10, 10],
  });
  assets.start();
  return { assets, eager };
}

async function settled(assets: InstanceType<typeof ProjectAssets>) {
  for (let round = 0; round < 100; round++) {
    await sleep(20);
    const snapshot = assets.snapshot();
    if (snapshot.transfers.every((transfer) => transfer.phase === "failed" || transfer.phase === "waiting")) return snapshot;
  }
  throw new Error("transfers did not settle");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "assets-transfers-"));
  feeds = []; cloud = []; calls = []; snapshots = []; failUploads = 0;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("uploads", () => {
  it("sends every local original the cloud lacks, and asks for a proxy of each video that has none", async () => {
    const { assets } = project();
    assets.setLocal([
      { sampleId: VIDEO, source: join(dir, "a.mp4"), mimeType: "video/mp4", name: "a.mp4", type: "VIDEO" },
      { sampleId: AUDIO, source: join(dir, "b.wav"), mimeType: "audio/wav", name: "b.wav", type: "AUDIO" },
    ], false);
    const snapshot = await settled(assets);
    expect([...calls].sort()).toEqual([`up:original:${AUDIO}`, `up:original:${VIDEO}`].sort());
    expect(snapshot.proxyWanted).toEqual([VIDEO]);
    expect(snapshot.cloud[VIDEO]).toEqual({ original: "ready", proxy: "none" });
    assets.stop();
  });

  it("sends a proxy once the renderer has made one, after the original is registered", async () => {
    const { assets } = project();
    await mkdir(join(dir, "cache", "proxies"), { recursive: true });
    await writeFile(join(dir, "cache", "proxies", `${VIDEO}.mp4`), "xxx");
    assets.setLocal([{ sampleId: VIDEO, source: join(dir, "a.mp4"), mimeType: "video/mp4", name: "a.mp4", type: "VIDEO" }], false);
    const snapshot = await settled(assets);
    expect(calls).toEqual([`up:original:${VIDEO}`, `up:proxy:${VIDEO}`]);
    expect(snapshot.proxyWanted).toEqual([]);
    expect(snapshot.cloud[VIDEO]).toEqual({ original: "ready", proxy: "ready" });
    assets.stop();
  });

  it("retries a failed upload with backoff, then lists it as failed until a hand retries it", async () => {
    const { assets } = project();
    failUploads = 3;
    assets.setLocal([{ sampleId: AUDIO, source: join(dir, "b.wav"), mimeType: "audio/wav", name: "b.wav", type: "AUDIO" }], false);
    let snapshot = await settled(assets);
    expect(calls).toEqual([`up:original:${AUDIO}`, `up:original:${AUDIO}`, `up:original:${AUDIO}`]);
    expect(snapshot.transfers).toEqual([expect.objectContaining({ sampleId: AUDIO, kind: "upload", phase: "failed", attempts: 3, error: "network" })]);
    expect(snapshot.summary.failed).toBe(1);
    assets.retry(AUDIO);
    snapshot = await settled(assets);
    expect(snapshot.transfers).toEqual([]);
    expect(snapshot.cloud[AUDIO].original).toBe("ready");
    assets.stop();
  });
});

describe("downloads", () => {
  it("brings ready proxies down unasked, and originals only when opted in", async () => {
    publish([meta(VIDEO, { originalState: "ready", proxyState: "ready", proxySize: 3 }), meta(AUDIO, { originalState: "ready", mimeType: "audio/wav", name: "b.wav" })]);
    const { assets } = project();
    assets.setLocal([], false);
    await settled(assets);
    expect(calls).toEqual([`down:proxy:${VIDEO}`]);
    assets.setLocal([], true);
    await settled(assets);
    expect(calls.slice(1).sort()).toEqual([`down:original:${AUDIO}`, `down:original:${VIDEO}`].sort());
    assets.stop();
  });

  it("a fetch prefers the proxy, waits on an upload another machine has under way, and serves a cached file without asking again", async () => {
    publish([meta(VIDEO, { originalState: "uploading" })]);
    const { assets } = project();
    assets.setLocal([], false);
    const pending = assets.fetch(VIDEO, "proxy");
    await sleep(30);
    expect(assets.snapshot().transfers).toEqual([expect.objectContaining({ sampleId: VIDEO, kind: "download", variant: "proxy", phase: "waiting" })]);
    expect(assets.snapshot().summary.waiting).toBe(1);
    publish([meta(VIDEO, { originalState: "ready", proxyState: "uploading", proxySize: 3 })]);
    await sleep(30);
    expect(calls).toEqual([]);
    publish([meta(VIDEO, { originalState: "ready", proxyState: "ready", proxySize: 3 })]);
    const result = await pending;
    expect(result?.path).toBe(join(dir, "cache", "proxies", `${VIDEO}.mp4`));
    expect(calls).toEqual([`down:proxy:${VIDEO}`]);
    expect((await assets.fetch(VIDEO, "proxy"))?.path).toBe(result?.path);
    expect(calls).toEqual([`down:proxy:${VIDEO}`]);
    // The original, asked for by name, comes down on its own transfer.
    expect((await assets.fetch(VIDEO, "original"))?.path).toBe(join(dir, "cache", "originals", `${VIDEO}.mp4`));
    expect(calls).toEqual([`down:proxy:${VIDEO}`, `down:original:${VIDEO}`]);
    assets.stop();
  });

  it("stops waiting for a proxy once the original is ready and no proxy was ever registered", async () => {
    publish([meta(VIDEO, { originalState: "uploading" })]);
    const { assets } = project();
    assets.setLocal([], false);
    const pending = assets.fetch(VIDEO, "proxy");
    await sleep(30);
    expect(assets.snapshot().summary.waiting).toBe(1);
    // The other machine finishes the original but runs code that makes no proxies.
    publish([meta(VIDEO, { originalState: "ready" })]);
    expect((await pending)?.path).toBe(join(dir, "cache", "originals", `${VIDEO}.mp4`));
    expect(calls).toEqual([`down:original:${VIDEO}`]);
    assets.stop();
  });

  it("falls back to the original for an asset that will never have a proxy", async () => {
    publish([meta(AUDIO, { originalState: "ready", mimeType: "audio/wav", name: "b.wav" }), meta(VIDEO, { originalState: "ready" })]);
    const { assets } = project();
    assets.setLocal([], false);
    expect((await assets.fetch(AUDIO, "proxy"))?.path).toBe(join(dir, "cache", "originals", "b.wav"));
    // A ready original with no proxy was sent before proxies existed.
    expect((await assets.fetch(VIDEO, "proxy"))?.path).toBe(join(dir, "cache", "originals", `${VIDEO}.mp4`));
    assets.stop();
  });
});
