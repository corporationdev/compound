import { mediaRequest } from './media-api';
import { uploadToCloud } from './upload';
import { getToken } from './auth-client';
import { mainBridge } from './ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { catalogMediaCache, catalogArtworkCache, createCatalogFileLoader, createCatalogArtworkLoader } from './catalog-cache';
import { downloadCatalogArtwork } from '@compound/backend/catalog-artwork';
import { MAX_CATALOG_UPLOAD_BYTES, type CatalogItem, type CatalogKind, type CatalogList, type CatalogMedia, type SourceRange } from '@compound/backend/catalog';
export { mergeCatalogItems } from '@compound/backend/catalog';
export type { CatalogItem, CatalogKind, SourceRange } from '@compound/backend/catalog';

const delay = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new DOMException('Canceled', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1500);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});
export const listCatalog = (kind: CatalogKind, query: string, cursors?: Pick<CatalogList, 'personalCursor' | 'curatedCursor'>) => mediaRequest<CatalogList>('catalog-list', { kind, query, ...cursors });
export const getCatalogItem = (sourceId: string) => mediaRequest<CatalogItem>('catalog-get', { sourceId });
export const getCatalogArtwork = createCatalogArtworkLoader(catalogArtworkCache, async sourceId => {
  // Only the packaged file:// renderer needs native transport. The development
  // renderer has the same allowed HTTP origin and fetch path as the web app.
  if (window.desktop && window.location.protocol === 'file:') {
    const bytes = await mainBridge.call(MAIN_CHANNELS.CLOUD_CATALOG_ARTWORK, { sourceId, token: await getToken() });
    return bytes === null ? null : new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
  }
  const { url } = await mediaRequest<{ url: string | null }>('catalog-artwork', { sourceId });
  return url === null ? null : new Blob([await downloadCatalogArtwork(url)], { type: 'image/jpeg' });
});
export async function searchExternalCatalog(kind: CatalogKind, query: string, signal?: AbortSignal): Promise<CatalogItem[]> {
  const searchId = await mediaRequest<string>('catalog-search', { kind, query });
  const deadline = Date.now() + 180000;
  while (!signal?.aborted && Date.now() < deadline) {
    const result = await mediaRequest<{ status: string; items: CatalogItem[]; error?: string }>('catalog-search-status', { searchId });
    if (result.status === 'ready') return result.items;
    if (result.status === 'failed') throw new Error(result.error ?? 'External search failed');
    await delay(signal);
  }
  if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
  throw new Error('Search is taking longer than expected. Try again.');
}
export async function resolveCatalogLink(kind: CatalogKind, url: string) {
  const sourceId = await mediaRequest<string>('catalog-resolve', { kind, url });
  return getCatalogItem(sourceId);
}
export async function prepareCatalogItem(sourceId: string, progress?: (item: CatalogItem) => void, signal?: AbortSignal): Promise<CatalogItem> {
  await mediaRequest('catalog-prepare', { sourceId });
  const deadline = Date.now() + 600000;
  while (!signal?.aborted && Date.now() < deadline) {
    const item = await getCatalogItem(sourceId);
    progress?.(item);
    if (item.status === 'ready') return item;
    if (item.status === 'failed') throw new Error(item.error ?? 'Audio preparation failed');
    await delay(signal);
  }
  if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
  throw new Error('Audio is still preparing. Try opening it again shortly.');
}
export const catalogFile = createCatalogFileLoader(catalogMediaCache, { prepare: prepareCatalogItem, download: downloadCatalogFile });
async function downloadCatalogFile(sourceId: string): Promise<{ blob: Blob; media: CatalogMedia }> {
  let bytes: Uint8Array<ArrayBuffer>, media: CatalogMedia;
  if (window.desktop) {
    const result = await mainBridge.call(MAIN_CHANNELS.CLOUD_CATALOG_FILE, { sourceId, token: await getToken() });
    bytes = new Uint8Array(result.bytes); media = result.media;
  } else {
    media = await mediaRequest<CatalogMedia>('catalog-playback', { sourceId });
    const response = await fetch(media.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Could not download audio');
    if (Number(response.headers.get('content-length')) > MAX_CATALOG_UPLOAD_BYTES) throw new Error('Audio exceeds 100 MiB');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Audio is empty');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > MAX_CATALOG_UPLOAD_BYTES) throw new Error('Audio exceeds 100 MiB'); chunks.push(chunk.value); }
    } finally { await reader.cancel(); }
    bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  }
  const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (checksum !== media.checksum) throw new Error('Audio download is incomplete. Retry.');
  return { blob: new Blob([bytes], { type: media.mimeType }), media };
}
export const saveCatalogItem = (sourceId: string, sourceRange?: SourceRange | null) => mediaRequest('catalog-save', { sourceId, ...(sourceRange !== undefined ? { sourceRange } : {}) });
export const removeCatalogItem = (sourceId: string) => mediaRequest('catalog-remove', { sourceId });
export async function uploadCatalogFile(file: File, kind: CatalogKind): Promise<CatalogItem> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const mimeType = ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' } as Record<string, string>)[ext ?? ''];
  if (!mimeType || !file.size || file.size > MAX_CATALOG_UPLOAD_BYTES) throw new Error('Choose an MP3, M4A or WAV file up to 100 MiB');
  const title = file.name.replace(/\.[^.]+$/, '').slice(0, 160);
  // The Worker completes the upload and queues preparation in one step.
  const sourceId = await uploadToCloud({ purpose: 'library', kind, title, mimeType }, { blob: file });
  return prepareCatalogItem(sourceId);
}
