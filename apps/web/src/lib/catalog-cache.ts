import type { CatalogItem, CatalogMedia } from '@compound/backend/catalog';
import { LocalMediaCache } from './local-media-cache';
import { serverQueries } from './query-cache';

// Signed URLs are transport credentials, not part of a locally stored file.
export type LocalCatalogMedia = Omit<CatalogMedia, 'url'>;
export const catalogMediaCache = new LocalMediaCache<LocalCatalogMedia>({ name: 'compound-catalog-media-v1' });
export type CatalogArtworkMetadata = { available: boolean };
export const catalogArtworkCache = new LocalMediaCache<CatalogArtworkMetadata>({ name: 'compound-catalog-artwork-v1', memoryBytes: 8 * 1024 * 1024, diskBytes: 64 * 1024 * 1024 });

export function setCatalogCacheScope(scope: string | null) {
  catalogMediaCache.setScope(scope);
  catalogArtworkCache.setScope(scope);
  return serverQueries.setScope(scope);
}

export function createCatalogArtworkLoader(cache: LocalMediaCache<CatalogArtworkMetadata>, download: (id: string) => Promise<Blob | null>) {
  return async (sourceId: string): Promise<Blob | null> => {
    const result = await cache.ensure(sourceId, async () => {
      const image = await download(sourceId);
      // Remember confirmed absence too; a missing image is not a failed request.
      const blob = image ?? new Blob();
      const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
      return { blob, checksum, metadata: { available: image !== null } };
    });
    return result.metadata.available ? result.blob : null;
  };
}

export function createCatalogFileLoader(cache: LocalMediaCache<LocalCatalogMedia>, dependencies: {
  prepare: (id: string, progress?: (item: CatalogItem) => void) => Promise<CatalogItem>;
  download: (id: string) => Promise<{ blob: Blob; media: CatalogMedia }>;
}) {
  return async (sourceId: string, progress?: (item: CatalogItem) => void, signal?: AbortSignal, onMiss?: () => void): Promise<{ blob: Blob; media: LocalCatalogMedia }> => {
    signal?.throwIfAborted();
    const result = await cache.ensure(sourceId, async () => {
      // Closing a player cancels its consumer; other consumers and later
      // previews can still reuse the shared download when it finishes.
      await dependencies.prepare(sourceId, progress);
      const { blob, media: { url: _url, ...media } } = await dependencies.download(sourceId);
      return { blob, checksum: media.checksum, metadata: media };
    }, onMiss);
    signal?.throwIfAborted();
    return { blob: result.blob, media: result.metadata };
  };
}
