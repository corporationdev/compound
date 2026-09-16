/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Asset bytes between a project folder and R2, one transfer at a time. The
// transfer manager (see assets-transfers.ts) decides what moves and when;
// this moves it, with the destination and the credentials always obtained
// from the authenticated server rather than from renderer input.
//
// Up: the file streams from disk to the signed URL, so a multi-gigabyte
// original is never read into memory, and the server marks the asset ready
// once it has seen the object. Down: the bytes land under `<dir>/cache/`,
// written to a temp file beside the target and renamed once whole; `cache/`
// is the app's own, ignored by sync, git and the renderer's watcher alike.
// An original keeps its name's extension under `cache/originals/`; a proxy
// is always `cache/proxies/<sampleId>.mp4`.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { tempPathFor } from "./atomic";
import { MediaRequestError, mediaRequest } from "./cloud";

/** The largest original the cloud takes; R2 accepts 5 GiB in one PUT. */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024 * 1024;

/** Where fetched originals live inside a project, relative to its folder. */
export const ORIGINALS_DIR = join("cache", "originals");
/** Where proxies live inside a project, made here or fetched, relative to its folder. */
export const PROXIES_DIR = join("cache", "proxies");

export type AssetVariant = "original" | "proxy";

/** Bytes moved so far, and the total; called as the transfer advances. */
export type ProgressCallback = (bytes: number, total: number) => void;

export type UploadOriginalRequest = {
  dir: string;
  organizationId: string;
  sampleId: string;
  /** Absolute path of the file on this machine. */
  source: string;
  mimeType: string;
  name: string;
  token: string | null;
};
export type UploadProxyRequest = { dir: string; sampleId: string; assetId: string; token: string | null };
export type FetchRequest = { dir: string; organizationId: string; sampleId: string; variant: AssetVariant; token: string | null };
export type FetchResponse = { path: string; name: string; mimeType: string } | null;

const SAMPLE_ID = /^[0-9a-f]{16}$/;

/** A library id as the cloud names it; anything else is not one and never reaches a path. */
export function validSampleId(sampleId: string): boolean {
  return SAMPLE_ID.test(sampleId);
}

/** The extension of a file name, dot included and lower-cased; '' when there is none. */
export function extensionOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  const ext = base.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : "";
}

/**
 * Where a fetched original is kept: named by its sample id (its identity on
 * every machine) with the extension of its cloud name, so decoders that go
 * by extension still recognise it.
 */
export function originalCachePath(dir: string, sampleId: string, name: string): string {
  if (!validSampleId(sampleId)) throw new Error("Invalid asset id");
  return join(dir, ORIGINALS_DIR, `${sampleId}${extensionOf(name)}`);
}

/** Where an asset's proxy is kept, whether made on this machine or fetched. */
export function proxyCachePath(dir: string, sampleId: string): string {
  if (!validSampleId(sampleId)) throw new Error("Invalid asset id");
  return join(dir, PROXIES_DIR, `${sampleId}.mp4`);
}

/**
 * A media type without its parameters, lower-cased: the library probes
 * `video/mp4; codecs="avc1.64001f, mp4a.40.2"`, the cloud records and signs
 * for `video/mp4`. The PUT must carry exactly what was signed.
 */
export function mediaEssence(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

/** The size of the file at `path` when it is a plain file, else null. */
export async function fileSize(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() ? info.size : null;
}

/**
 * PUTs a file to a signed URL, streaming from disk. The signature binds
 * Content-Type and Content-Length, so both are sent exactly as declared.
 */
function putFile(url: string, source: string, size: number, mimeType: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(new URL(url), { method: "PUT", headers: { "Content-Type": mimeType, "Content-Length": String(size) } }, (response) => {
      response.resume();
      response.on("end", () => {
        if (response.statusCode && response.statusCode < 300) resolve();
        else reject(new Error(`Asset upload failed (${response.statusCode})`));
      });
    });
    request.on("error", reject);
    signal?.addEventListener("abort", () => request.destroy(new Error("Upload cancelled")), { once: true });
    const stream = createReadStream(source);
    let sent = 0;
    stream.on("data", (chunk: Buffer | string) => {
      sent += chunk.length;
      onProgress?.(sent, size);
    });
    stream.on("error", (error) => request.destroy(error));
    stream.pipe(request);
  });
}

/**
 * Sends the bytes of a library asset to the cloud, if the cloud does not
 * have them yet. `source` is the absolute path of the file on this machine.
 */
export async function uploadAssetOriginal(request: UploadOriginalRequest, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<{ assetId: string; state: "uploading" | "ready" }> {
  if (!validSampleId(request.sampleId)) throw new Error("Invalid asset id");
  if (!isAbsolute(request.source)) throw new Error("Asset source must be an absolute path");
  const size = await fileSize(request.source);
  if (size === null) throw new Error(`No such file: ${request.source}`);
  if (size < 1 || size > MAX_ASSET_BYTES) throw new Error("Originals must be between 1 byte and 4 GiB");

  const mimeType = mediaEssence(request.mimeType);
  const registered = (await mediaRequest(
    "asset-upload-url",
    { organizationId: request.organizationId, sampleId: request.sampleId, size, mimeType, name: request.name },
    request.token,
  )) as { assetId: string; uploadUrl: string | null };
  if (!registered.uploadUrl) return { assetId: registered.assetId, state: "ready" };

  if ((await fileSize(request.source)) !== size) throw new Error("The file changed while it was being uploaded");
  await putFile(registered.uploadUrl, request.source, size, mimeType, onProgress, signal);
  await mediaRequest("asset-upload-finish", { assetId: registered.assetId }, request.token);
  return { assetId: registered.assetId, state: "ready" };
}

/** Sends the proxy at `cache/proxies/<sampleId>.mp4` up beside its original, if the cloud lacks it. */
export async function uploadAssetProxy(request: UploadProxyRequest, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<void> {
  const path = proxyCachePath(request.dir, request.sampleId);
  const size = await fileSize(path);
  if (size === null) throw new Error(`No proxy at ${path}`);
  const registered = (await mediaRequest("asset-proxy-upload-url", { assetId: request.assetId, size }, request.token)) as { uploadUrl: string | null };
  if (!registered.uploadUrl) return;
  await putFile(registered.uploadUrl, path, size, "video/mp4", onProgress, signal);
  await mediaRequest("asset-proxy-upload-finish", { assetId: request.assetId }, request.token);
}

/**
 * Brings a variant this machine lacks into the project's cache; null when
 * the cloud has none. A file already there at the expected size is reused
 * without a download.
 */
export async function fetchAssetVariant(request: FetchRequest, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<FetchResponse> {
  if (!validSampleId(request.sampleId)) throw new Error("Invalid asset id");
  let media: { url: string; size: number; mimeType: string; name: string };
  try {
    media = (await mediaRequest(
      "asset-download-url",
      { organizationId: request.organizationId, sampleId: request.sampleId, variant: request.variant },
      request.token,
    )) as typeof media;
  } catch (error) {
    if (error instanceof MediaRequestError && error.status === 404) return null;
    throw error;
  }

  const path = request.variant === "proxy"
    ? proxyCachePath(request.dir, request.sampleId)
    : originalCachePath(request.dir, request.sampleId, media.name);
  const result = { path, name: media.name, mimeType: media.mimeType };
  if ((await fileSize(path)) === media.size) {
    onProgress?.(media.size, media.size);
    return result;
  }

  await mkdir(join(request.dir, request.variant === "proxy" ? PROXIES_DIR : ORIGINALS_DIR), { recursive: true });
  const response = await fetch(media.url, { signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Asset download failed (${response.status})`);
  }
  const temp = tempPathFor(path);
  try {
    let received = 0;
    const counting = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    counting.on("data", (chunk: Buffer) => {
      received += chunk.length;
      onProgress?.(received, media.size);
    });
    await pipeline(counting, createWriteStream(temp), { signal });
    if (received !== media.size) throw new Error("Asset download was cut short");
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return result;
}

/** Brings an original this machine lacks into `<dir>/cache/originals/`; null when the cloud has none. */
export function fetchAssetOriginal(request: Omit<FetchRequest, "variant">, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<FetchResponse> {
  return fetchAssetVariant({ ...request, variant: "original" }, onProgress, signal);
}
