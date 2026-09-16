/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Asset originals between a project folder and R2. The renderer decides
// what to upload (a library asset with bytes on this machine) and what to
// fetch (one whose source is missing here); the main process moves bytes,
// with the destination and the credentials always obtained from the
// authenticated server rather than from renderer input.
//
// Up: the file goes to the signed URL as a lazy Blob (`fs.openAsBlob`), so a
// multi-gigabyte original streams from disk rather than being read into
// memory, and the server marks the asset ready once it has seen the object.
// Down: the bytes land under `<dir>/cache/originals/`, written to a temp file
// beside the target and renamed once whole; `cache/` is the app's own,
// ignored by sync, git and the renderer's watcher alike.

import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { tempPathFor } from "./atomic";
import { MediaRequestError, mediaRequest } from "./cloud";

import type { MainRequestMap } from "./main-channels";
import type { MAIN_CHANNELS } from "./main-channels";

type UploadRequest = MainRequestMap[typeof MAIN_CHANNELS.CLOUD_ASSET_UPLOAD]["request"];
type UploadResponse = MainRequestMap[typeof MAIN_CHANNELS.CLOUD_ASSET_UPLOAD]["response"];
type FetchRequest = MainRequestMap[typeof MAIN_CHANNELS.CLOUD_ASSET_FETCH]["request"];
type FetchResponse = MainRequestMap[typeof MAIN_CHANNELS.CLOUD_ASSET_FETCH]["response"];

/** The largest original the cloud takes; R2 accepts 5 GiB in one PUT. */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024 * 1024;

/** Where fetched originals live inside a project, relative to its folder. */
export const ORIGINALS_DIR = join("cache", "originals");

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

/**
 * A media type without its parameters, lower-cased: the library probes
 * `video/mp4; codecs="avc1.64001f, mp4a.40.2"`, the cloud records and signs
 * for `video/mp4`. The PUT must carry exactly what was signed.
 */
export function mediaEssence(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

const inflightUploads = new Map<string, Promise<UploadResponse>>();
const inflightFetches = new Map<string, Promise<FetchResponse>>();

/** One run of `run` per key at a time; a second caller joins the first. */
function once<T>(map: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const running = map.get(key);
  if (running) return running;
  const promise = run().finally(() => map.delete(key));
  map.set(key, promise);
  return promise;
}

/**
 * Sends the bytes of a library asset to the cloud, if the cloud does not
 * have them yet. `source` is the absolute path of the file on this machine.
 */
export async function uploadAssetOriginal(request: UploadRequest): Promise<UploadResponse> {
  if (!validSampleId(request.sampleId)) throw new Error("Invalid asset id");
  if (!isAbsolute(request.source)) throw new Error("Asset source must be an absolute path");
  return once(inflightUploads, `${request.organizationId}:${request.sampleId}`, () => upload(request));
}

async function upload(request: UploadRequest): Promise<UploadResponse> {
  const info = await stat(request.source).catch(() => null);
  if (!info?.isFile()) throw new Error(`No such file: ${request.source}`);
  if (info.size < 1 || info.size > MAX_ASSET_BYTES) throw new Error("Originals must be between 1 byte and 4 GiB");

  const mimeType = mediaEssence(request.mimeType);
  const registered = (await mediaRequest(
    "asset-upload-url",
    { organizationId: request.organizationId, sampleId: request.sampleId, size: info.size, mimeType, name: request.name },
    request.token,
  )) as { assetId: string; uploadUrl: string | null };
  if (!registered.uploadUrl) return { assetId: registered.assetId, state: "ready" };

  // A lazy Blob: the size is known up front (the signed URL binds
  // Content-Length to it) and the bytes are read from disk as they are sent.
  const blob = await openAsBlob(request.source, { type: mimeType });
  if (blob.size !== info.size) throw new Error("The file changed while it was being uploaded");
  const response = await fetch(registered.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: blob,
  });
  await response.body?.cancel().catch(() => {});
  if (!response.ok) throw new Error(`Asset upload failed (${response.status})`);

  await mediaRequest("asset-upload-finish", { assetId: registered.assetId }, request.token);
  return { assetId: registered.assetId, state: "ready" };
}

/**
 * Brings an original this machine lacks into `<dir>/cache/originals/`; null
 * when the cloud has none. A file already there at the expected size is
 * reused without a download.
 */
export async function fetchAssetOriginal(request: FetchRequest): Promise<FetchResponse> {
  if (!validSampleId(request.sampleId)) throw new Error("Invalid asset id");
  return once(inflightFetches, `${request.dir}:${request.sampleId}`, () => download(request));
}

async function download(request: FetchRequest): Promise<FetchResponse> {
  let media: { url: string; size: number; mimeType: string; name: string };
  try {
    media = (await mediaRequest(
      "asset-download-url",
      { organizationId: request.organizationId, sampleId: request.sampleId },
      request.token,
    )) as typeof media;
  } catch (error) {
    if (error instanceof MediaRequestError && error.status === 404) return null;
    throw error;
  }

  const path = originalCachePath(request.dir, request.sampleId, media.name);
  const result = { path, name: media.name, mimeType: media.mimeType };
  const existing = await stat(path).catch(() => null);
  if (existing?.isFile() && existing.size === media.size) return result;

  await mkdir(join(request.dir, ORIGINALS_DIR), { recursive: true });
  const response = await fetch(media.url);
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Asset download failed (${response.status})`);
  }
  const temp = tempPathFor(path);
  try {
    let received = 0;
    const counting = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    counting.on("data", (chunk: Buffer) => { received += chunk.length; });
    await pipeline(counting, createWriteStream(temp));
    if (received !== media.size) throw new Error("Asset download was cut short");
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return result;
}
