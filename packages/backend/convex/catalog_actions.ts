'use node';
import { CatalogDownloadError } from './catalog_providers/youtube';
import { createHash } from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import { v } from 'convex/values';
import { api, internal } from './_generated/api';
import { action, internalAction } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { CatalogMedia } from '../catalog';
import { catalogKind, catalogSourceRange } from './catalog_types';
import { catalogManifestSource, validatePublicCatalog } from './catalog_manifest';
import { getProvider, providerForKind } from './catalog_providers/registry';
import { fetchJson, isRecord } from './catalog_providers/http';
import { catalogUrl, readCatalogObject, writeCatalogObject, deleteCatalogObject } from '../lib/catalog-storage';

export const resolveLink = action({ args: { url: v.string(), kind: catalogKind }, handler: async (ctx, args): Promise<string> => {
  if (!await ctx.runQuery(api.auth.getCurrentUser, {})) throw new Error('Sign in to use the library');
  const source = catalogManifestSource(args.url.trim());
  let title = source.externalId.replaceAll('-', ' ');
  if (source.provider === 'youtube') {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${source.externalId}`)}&format=json`;
    const metadata = await fetchJson(url, { hosts: ['www.youtube.com'], maxBytes: 100000 });
    if (!isRecord(metadata) || typeof metadata.title !== 'string') throw new Error('Could not read this media link');
    title = metadata.title;
  }
  return ctx.runMutation(api.catalog.ensureExternal, { ...source, kind: args.kind, title: title.slice(0, 160) });
} });
export const artwork = action({ args: { sourceId: v.id('catalogSources') }, handler: async (ctx, args): Promise<{ url: string | null }> => {
  const source = await ctx.runQuery(api.catalog.artworkSource, args);
  if (source.provider === 'upload') return { url: null };
  let key = source.key;
  if (!key) {
    const provider = getProvider(source.provider);
    if (!provider.resolveArtwork) return { url: null };
    const image = await provider.resolveArtwork(source.externalId);
    // The current artwork adapter returns bounded JPEG bytes independently of audio.
    if (image.extension !== 'jpg' || image.mimeType !== 'image/jpeg') throw new Error('Unsupported artwork format');
    const destination = `library/artwork/${args.sourceId}.jpg`;
    await writeCatalogObject(destination, image.bytes, image.mimeType);
    key = await ctx.runMutation(internal.catalog.cacheArtwork, { ...args, key: destination });
  }
  return { url: await catalogUrl(key) };
} });
export const playback = action({ args: { sourceId: v.id('catalogSources') }, handler: async (ctx, args): Promise<CatalogMedia> => {
  const { key, ...media } = await ctx.runQuery(api.catalog.media, args);
  return { ...media, url: await catalogUrl(key) };
} });
export const searchProvider = internalAction({ args: { searchId: v.id('catalogSearches') }, handler: async (ctx, args): Promise<void> => {
  const search = await ctx.runQuery(internal.catalog.searchContext, args);
  if (!search || search.status !== 'running') return;
  try {
    const items = await getProvider(providerForKind(search.kind)).search(search.query);
    await ctx.runMutation(internal.catalog.finishSearch, { ...args, items });
  } catch {
    await ctx.runMutation(internal.catalog.finishSearch, { ...args, error: 'Catalog search is unavailable. Try again.' });
  }
} });
export const prepareSource = internalAction({ args: { sourceId: v.id('catalogSources'), attempt: v.number() }, handler: async (ctx, args): Promise<void> => {
  const source = await ctx.runQuery(internal.catalog.context, { sourceId: args.sourceId });
  if (!source || source.attempt !== args.attempt || !await ctx.runMutation(internal.catalog.progress, args)) return;
  let writtenKey: string | undefined;
  try {
    let bytes: Uint8Array, mimeType: string, extension: string, durationUs: number;
    if (source.provider === 'upload') {
      if (!source.uploadKey) throw new Error('Uploaded audio is missing');
      bytes = await readCatalogObject(source.uploadKey);
      if (bytes.length !== source.size) throw new Error('Upload is incomplete. Upload the file again.');
      const metadata = await parseBuffer(bytes, { mimeType: source.mimeType }, { duration: true });
      const duration = metadata.format.duration;
      if (!duration || !Number.isFinite(duration) || duration <= 0 || duration > 7200 || metadata.format.hasVideo || !metadata.format.sampleRate || !metadata.format.numberOfChannels) throw new Error('Upload a playable audio file shorter than two hours');
      const container = metadata.format.container;
      if (container === 'MPEG') { mimeType = 'audio/mpeg'; extension = 'mp3'; }
      else if (container === 'WAVE') { mimeType = 'audio/wav'; extension = 'wav'; }
      else if (metadata.format.codec === 'MPEG-4/AAC' && new TextDecoder().decode(bytes.subarray(4, 8)) === 'ftyp') { mimeType = 'audio/mp4'; extension = 'm4a'; }
      else throw new Error('Supported library formats are MP3, AAC/M4A and WAV');
      durationUs = Math.round(duration * 1000000);
    } else {
      const media = await getProvider(source.provider).resolve(source.externalId, {
        id: source.externalRunId,
        started: async externalRunId => { if (!await ctx.runMutation(internal.catalog.progress, { ...args, externalRunId })) throw new Error('Preparation was superseded'); },
        terminal: async () => { await ctx.runMutation(internal.catalog.progress, { ...args, externalRunTerminal: true }); },
      });
      if (!media.durationUs) throw new Error('Audio duration is missing');
      ({ bytes, mimeType, extension } = media); durationUs = media.durationUs;
    }
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const key = `library/${source.ownerId ? 'private' : 'catalog'}/${source._id}/${args.attempt}.${extension}`;
    if (!await ctx.runMutation(internal.catalog.progress, args)) return;
    await writeCatalogObject(key, bytes, mimeType);
    writtenKey = key;
    const accepted = await ctx.runMutation(internal.catalog.complete, { ...args, key, checksum, size: bytes.length, mimeType, extension, durationUs });
    if (!accepted) await deleteCatalogObject(key);
    if (source.uploadKey) await deleteCatalogObject(source.uploadKey);
  } catch (error) {
    if (writtenKey) {
      const current = await ctx.runQuery(internal.catalog.context, { sourceId: args.sourceId });
      if (current?.key !== writtenKey) await deleteCatalogObject(writtenKey).catch(() => {});
    }
    // Provider exceptions can contain transient URLs. Only user-owned validation messages are returned.
    const message = error instanceof CatalogDownloadError ? error.publicMessage : source.provider === 'upload' && error instanceof Error ? error.message : 'Audio preparation failed. Please try again.';
    const detail = (error instanceof Error ? error.message : 'Unknown preparation failure').replace(/https?:\/\/\S+/g, '[provider URL]');
    await ctx.runMutation(internal.catalog.fail, { ...args, error: message, detail });
  }
} });
export const deleteObjects = internalAction({ args: { keys: v.array(v.string()) }, handler: async (_ctx, args) => {
  for (const key of args.keys) await deleteCatalogObject(key);
} });
export const reconcile = internalAction({
  args: { items: v.array(v.object({ sourceUrl: v.string(), title: v.string(), description: v.string(), sourceRange: v.optional(catalogSourceRange) })), revision: v.string() },
  handler: async (ctx, args): Promise<{ count: number; revision: string }> => {
    validatePublicCatalog(args.items, ['music', 'sfx']);
    const ready: { sourceId: Id<'catalogSources'>; title: string; description: string; sourceRange?: { sourceStartUs: number; sourceEndUs: number } }[] = [];
    // Seed one at a time, leaving provider capacity for interactive requests.
    for (const item of args.items) {
      const sourceId: Id<'catalogSources'> = await ctx.runMutation(internal.catalog.ensureForDeploy, { ...catalogManifestSource(item.sourceUrl), title: item.title });
      const source = await ctx.runQuery(internal.catalog.context, { sourceId });
      if (source?.status !== 'ready') throw new Error(`Prepare catalog source before publishing: ${item.title}`);
      ready.push({ sourceId, title: item.title, description: item.description, ...(item.sourceRange ? { sourceRange: item.sourceRange } : {}) });
    }
    return ctx.runMutation(internal.catalog.publish, { items: ready, revision: args.revision });
  },
});
