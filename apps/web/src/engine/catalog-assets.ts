import type { Asset, AssetLibrary } from '@compound/assets';
import { catalogFile, type CatalogItem, type SourceRange } from '@/lib/catalog';

export const CATALOG_DRAG_TYPE = 'application/x-compound-catalog';
export type CatalogDrag = { sourceId: string; sourceRange?: SourceRange };
export function readCatalogDrag(event: DragEvent): CatalogDrag | null {
  const text = event.dataTransfer?.getData(CATALOG_DRAG_TYPE);
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (typeof value.sourceId !== 'string' || value.sourceId.length > 100) return null;
    const range = value.sourceRange;
    if (range && (!Number.isSafeInteger(range.sourceStartUs) || !Number.isSafeInteger(range.sourceEndUs) || range.sourceStartUs < 0 || range.sourceEndUs <= range.sourceStartUs)) return null;
    return { sourceId: value.sourceId, ...(range ? { sourceRange: range } : {}) };
  } catch { return null; }
}
const queues = new WeakMap<AssetLibrary, Promise<unknown>>();
/** The sole catalog -> local project boundary, shared by UI and CLI. */
export function importCatalogAsset(library: AssetLibrary, sourceId: string, progress?: (item: CatalogItem) => void): Promise<Asset> {
  const task = (queues.get(library) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (library.closed) throw new Error('The project was closed');
    const existing = library.list().find(asset => asset.catalogSources?.some(source => source.sourceId === sourceId));
    if (existing) { await library.flush(); return existing; }
    const { blob, media } = await catalogFile(sourceId, progress);
    if (library.closed) throw new Error('The project was closed before the download finished');
    const sameBytes = library.list().find(asset => asset.catalogSources?.some(source => source.checksum === media.checksum));
    const title = media.item.title.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').trim().slice(0, 120) || 'audio';
    const asset = sameBytes ?? await library.store(blob, { folder: media.item.kind, name: `${title}.${media.extension}` });
    library.rememberCatalogSource(asset, { sourceId, checksum: media.checksum, title: media.item.title, kind: media.item.kind, ...(media.item.sourceRange ? { sourceRange: media.item.sourceRange } : {}) });
    await library.flush();
    return asset;
  });
  queues.set(library, task);
  return task;
}
