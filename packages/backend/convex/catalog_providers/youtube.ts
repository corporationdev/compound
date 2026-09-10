import { parseBuffer } from "music-metadata";
import type { DiscoveredCatalogItem } from "../catalog_types";
import { fetchBytes, fetchJson, isRecord } from "./http";
import type { MediaProvider, ResolvedArtwork, ResolvedMedia } from "./types";

const API = "https://api.apify.com/v2";
const POLICY = {
  hosts: ["api.apify.com"],
  maxBytes: 4_000_000,
  timeoutMs: 130_000,
};
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,32}$/;

function credentials(): { Authorization: string } {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) {
    throw new Error("Missing APIFY_TOKEN");
  }
  return { Authorization: `Bearer ${token}` };
}

async function apify(path: string, body?: unknown): Promise<unknown> {
  return await fetchJson(`${API}/${path}`, POLICY, {
    headers: { ...credentials(), "Content-Type": "application/json" },
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
  });
}

function durationSeconds(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  const parts = value.split(":").map(Number);
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => !Number.isFinite(part) || part < 0)
  ) {
    return 0;
  }
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

export function parseYouTubeSearch(payload: unknown): DiscoveredCatalogItem[] {
  if (!Array.isArray(payload)) {
    throw new Error("Music search returned an invalid response");
  }
  const results: DiscoveredCatalogItem[] = [];
  const seen = new Set<string>();
  for (const item of payload) {
    if (!isRecord(item)) {
      continue;
    }
    const externalId = item.videoId ?? item.id;
    const seconds = durationSeconds(item.lengthText ?? item.duration);
    if (
      item.type !== "video" ||
      typeof externalId !== "string" ||
      !YOUTUBE_ID.test(externalId) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      seconds <= 0 ||
      seconds > 1200 ||
      seen.has(externalId)
    ) {
      continue;
    }
    seen.add(externalId);
    results.push({
      externalId,
      title: item.title.trim().slice(0, 160),
      durationUs: Math.round(seconds * 1_000_000),
    });
    if (results.length === 20) {
      break;
    }
  }
  return results;
}

async function downloadYouTube(externalId: string, progress?: Parameters<MediaProvider['resolve']>[1]): Promise<ResolvedMedia> {
  if (!YOUTUBE_ID.test(externalId)) {
    throw new Error("Invalid YouTube source id");
  }
  let runId = progress?.id;
  if (!runId) {
  const started = await apify("acts/streamers~youtube-video-downloader/runs?timeout=240&maxTotalChargeUsd=0.5", {
    preferredFormat: "m4a",
    storeInKVStore: true,
    transcriptionAndSubtitle: "NONE",
    videos: [{ url: `https://www.youtube.com/watch?v=${externalId}` }],
  });
  if (
    !(isRecord(started) && isRecord(started.data)) ||
    typeof started.data.id !== "string"
  ) {
    throw new Error("Music download could not start");
  }
  runId = started.data.id;
  await progress?.started(runId);
  }
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const payload = await apify(`actor-runs/${encodeURIComponent(runId)}`);
    if (!(isRecord(payload) && isRecord(payload.data))) {
      throw new Error("Music download returned an invalid run");
    }
    const run = payload.data;
    if (["FAILED", "TIMED-OUT", "ABORTED"].includes(String(run.status))) {
      await progress?.terminal();
      throw new CatalogDownloadError(`Audio download run ${runId} ended ${String(run.status)}`);
    }
    if (run.status !== "SUCCEEDED") {
      continue;
    }
    if (typeof run.defaultDatasetId !== "string") {
      throw new Error("Music download has no result");
    }
    const dataset = await apify(
      `datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&format=json`
    );
    try { return await prepareDownloadedMedia(dataset, externalId); }
    catch (error) {
      // A successful Actor run can still contain a failed item. Retrying it must
      // start a fresh run; transport errors can resume the existing saved file.
      if (error instanceof CatalogDownloadError) await progress?.terminal();
      throw error;
    }
  }
  throw new Error("Music download timed out");
}

export class CatalogDownloadError extends Error {
  readonly publicMessage = 'The catalog download service could not fetch this audio. Try again shortly.';
}

export async function prepareDownloadedMedia(
  dataset: unknown,
  externalId: string
): Promise<ResolvedMedia> {
  const item: unknown = Array.isArray(dataset) ? dataset[0] : null;
  if (!isRecord(item) || item.id !== externalId) throw new CatalogDownloadError('Music download returned no matching audio');
  // Keep reading completed runs from the previous integration during deployment.
  const fileUrl = item.downloadedFileUrl ?? (isRecord(item.savedFile) ? item.savedFile.url : undefined);
  if (typeof fileUrl !== 'string') throw new CatalogDownloadError('Music download returned no audio file');
  const url = new URL(fileUrl);
  if (!url.pathname.startsWith('/v2/key-value-stores/') || !url.pathname.includes('/records/')) throw new CatalogDownloadError('Music download returned an invalid storage record');
  const bytes = await fetchBytes(
    fileUrl,
    { ...POLICY, maxBytes: 100_000_000 },
    { headers: credentials() }
  );
  return await parseYouTubeAudio(bytes);
}

export async function parseYouTubeAudio(
  bytes: Uint8Array
): Promise<ResolvedMedia> {
  const metadata = await parseBuffer(
    bytes,
    { mimeType: "audio/mp4" },
    { duration: true }
  );
  const duration = metadata.format.duration;
  if (
    !(duration && Number.isFinite(duration)) ||
    duration <= 0 ||
    duration > 1200 ||
    new TextDecoder().decode(bytes.subarray(4, 8)) !== "ftyp" ||
    metadata.format.codec !== "MPEG-4/AAC" ||
    metadata.format.hasAudio !== true ||
    metadata.format.hasVideo === true ||
    !(metadata.format.sampleRate && metadata.format.sampleRate > 0) ||
    !(metadata.format.numberOfChannels && metadata.format.numberOfChannels > 0)
  ) {
    throw new Error(
      "Music downloader did not return a valid AAC audio-only MP4 file"
    );
  }
  // YouTube AAC often uses dash/iso6/mp41 brands, not the optional M4A brand.
  // Validate the parsed audio stream rather than rejecting those valid files.
  return {
    bytes,
    extension: "m4a",
    mimeType: "audio/mp4",
    mediaKind: "audio",
    durationUs: Math.round(duration * 1_000_000),
  };
}

async function downloadYouTubeArtwork(
  externalId: string
): Promise<ResolvedArtwork> {
  if (!YOUTUBE_ID.test(externalId)) {
    throw new Error("Invalid YouTube source id");
  }
  const bytes = await fetchBytes(
    `https://i.ytimg.com/vi/${externalId}/hqdefault.jpg`,
    { hosts: ["i.ytimg.com"], maxBytes: 3_000_000 }
  );
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) {
    throw new Error("Music artwork was not a JPEG image");
  }
  return { bytes, extension: "jpg", mimeType: "image/jpeg" };
}

export const youtubeProvider: MediaProvider = {
  kind: "music",
  async search(query) {
    return parseYouTubeSearch(
      await apify(
        "acts/api-ninja~youtube-search-scraper/run-sync-get-dataset-items?timeout=120",
        {
          geo: "US",
          lang: "en",
          maxResults: 20,
          query,
          scrapeAllResults: false,
          sortBy: "relevance",
          type: "video",
        }
      )
    );
  },
  resolve: downloadYouTube,
  resolveArtwork: downloadYouTubeArtwork,
};
