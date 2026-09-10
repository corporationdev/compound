/** Shared library contract. UI and future CLI clients use the same source IDs. */
export type CatalogKind = 'music' | 'sfx';
export type CatalogProvider = 'youtube' | 'myinstants';
export type SourceRange = { sourceStartUs: number; sourceEndUs: number };
export type CatalogItem = {
  sourceId: string;
  kind: CatalogKind;
  provider: CatalogProvider | 'upload';
  title: string;
  description?: string;
  artworkAvailable?: boolean;
  durationUs?: number;
  sourceRange?: SourceRange;
  inUserLibrary: boolean;
  inGlobalLibrary: boolean;
  status: 'uploading' | 'queued' | 'running' | 'ready' | 'failed';
  error?: string;
};
export type CatalogPage = { items: CatalogItem[]; cursor: string | null };
export type CatalogList = {
  items: CatalogItem[];
  personalCursor: string | null;
  curatedCursor: string | null;
};
export type CatalogMedia = {
  item: CatalogItem;
  url: string;
  mimeType: string;
  extension: string;
  checksum: string;
};
export const MAX_CATALOG_UPLOAD_BYTES = 100 * 1024 * 1024;
export const CATALOG_UPLOAD_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav'] as const;
export function mergeCatalogItems(...groups: CatalogItem[][]): CatalogItem[] {
  const items = new Map<string, CatalogItem>();
  for (const group of groups) for (const item of group) {
    const previous = items.get(item.sourceId);
    // Personal display metadata is authoritative, independent of response order.
    items.set(item.sourceId, previous?.inUserLibrary ? previous : item);
  }
  return [...items.values()];
}
