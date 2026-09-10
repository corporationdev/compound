import type { CatalogKind, CatalogProvider } from "./catalog_types";

// Convex-side parsing and validation only. The editable catalog data lives in
// packages/backend/catalog_manifest.ts and is passed to the action by CI.

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;
const YOUTUBE_PATH_PATTERN = /^\/(?:embed|shorts)\/([^/]+)$/;
const MYINSTANTS_ID_PATTERN = /^[A-Za-z0-9_-]{1,240}$/;
const MYINSTANTS_PATH_PATTERN =
  /^\/[a-z]{2}\/instant\/([A-Za-z0-9_-]{1,240})\/?$/;

export interface CatalogManifestItem {
  description: string;
  sourceRange?: {
    sourceEndUs: number;
    sourceStartUs: number;
  };
  sourceUrl: string;
  title: string;
}

export interface CatalogManifestSource {
  externalId: string;
  kind: CatalogKind;
  provider: CatalogProvider;
}

export function catalogManifestSource(
  sourceUrl: string
): CatalogManifestSource {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new Error(`Invalid catalog source URL: ${sourceUrl}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error(`Catalog source URLs must use HTTPS: ${sourceUrl}`);
  }

  const hostname = url.hostname.toLowerCase();
  const youtubeId = youtubeExternalId(url, hostname);
  if (youtubeId) {
    return { externalId: youtubeId, kind: "music", provider: "youtube" };
  }

  if (hostname === "myinstants.com" || hostname === "www.myinstants.com") {
    const externalId = MYINSTANTS_PATH_PATTERN.exec(url.pathname)?.[1];
    if (externalId && MYINSTANTS_ID_PATTERN.test(externalId)) {
      return { externalId, kind: "sfx", provider: "myinstants" };
    }
  }

  throw new Error(`Unsupported catalog source URL: ${sourceUrl}`);
}

export function validatePublicCatalog(
  items: readonly CatalogManifestItem[],
  managedKinds: readonly CatalogKind[]
): void {
  const identities = new Set<string>();
  for (const item of items) {
    const title = item.title.trim();
    const description = item.description.trim();
    if (!title || title.length > 160) {
      throw new Error("Catalog titles must be from 1 to 160 characters");
    }
    if (!description || description.length > 1000) {
      throw new Error("Catalog descriptions must be from 1 to 1000 characters");
    }
    const source = catalogManifestSource(item.sourceUrl);
    if (!managedKinds.includes(source.kind)) {
      throw new Error(`Catalog kind is not repo-managed: ${source.kind}`);
    }
    const identity = `${source.provider}:${source.externalId}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate catalog source: ${item.sourceUrl}`);
    }
    identities.add(identity);

    const range = item.sourceRange;
    if (
      range &&
      (!(
        Number.isSafeInteger(range.sourceStartUs) &&
        Number.isSafeInteger(range.sourceEndUs)
      ) ||
        range.sourceStartUs < 0 ||
        range.sourceEndUs <= range.sourceStartUs)
    ) {
      throw new Error(`Invalid source range for ${item.title}`);
    }
  }
}

function youtubeExternalId(url: URL, hostname: string): string | null {
  let externalId: string | undefined;
  if (hostname === "youtu.be") {
    externalId = url.pathname.split("/").filter(Boolean)[0];
  } else if (
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "music.youtube.com"
  ) {
    externalId =
      url.pathname === "/watch"
        ? (url.searchParams.get("v") ?? undefined)
        : YOUTUBE_PATH_PATTERN.exec(url.pathname)?.[1];
  }
  return externalId && YOUTUBE_ID_PATTERN.test(externalId) ? externalId : null;
}
