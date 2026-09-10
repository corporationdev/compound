import type { CatalogKind, DiscoveredCatalogItem } from "../catalog_types";

export interface ResolvedArtwork {
  bytes: Uint8Array;
  extension: string;
  mimeType: string;
}

export interface ResolvedMedia {
  bytes: Uint8Array;
  description?: string;
  durationUs?: number;
  extension: string;
  height?: number;
  mediaKind: "audio" | "image" | "video";
  mimeType: string;
  width?: number;
}

/** Providers only discover/fetch. Storage, memberships and placement are not their concern. */
export interface MediaProvider {
  kind: CatalogKind;
  resolve(externalId: string, run?: {
    id?: string;
    started(id: string): Promise<void>;
    terminal(): Promise<void>;
  }): Promise<ResolvedMedia>;
  resolveArtwork?(externalId: string): Promise<ResolvedArtwork>;
  search(query: string): Promise<DiscoveredCatalogItem[]>;
}
