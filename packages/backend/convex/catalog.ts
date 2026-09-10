import { ConvexError, v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { authComponent } from './auth';
import { internal } from './_generated/api';
import { query, mutation, internalQuery, internalMutation, type QueryCtx, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { CatalogItem, CatalogPage } from '../catalog';
import { MAX_CATALOG_UPLOAD_BYTES, CATALOG_UPLOAD_TYPES } from '../catalog';
import { catalogKind, catalogProvider, catalogSourceRange, discoveredCatalogItem, validateRange } from './catalog_types';
import { providerCapabilities } from './catalog_providers/capabilities';

export const CURATED = 'system:catalog';
const LEASE_MS = 10 * 60_000;
type Reader = Pick<QueryCtx, 'db'>;
export async function owner(ctx: QueryCtx | MutationCtx) {
  const user = await authComponent.getAuthUser(ctx);
  if (!user) throw new ConvexError('Sign in to use the library');
  return user._id;
}
async function sourceFor(ctx: Reader, id: Id<'catalogSources'>, ownerId: string) {
  const source = await ctx.db.get(id);
  if (!source || (source.ownerId && source.ownerId !== ownerId)) throw new ConvexError('Library item not found');
  return source;
}
async function entryFor(ctx: Reader, ownerId: string, sourceId: Id<'catalogSources'>) {
  return ctx.db.query('catalogEntries').withIndex('by_owner_source', q => q.eq('ownerId', ownerId).eq('sourceId', sourceId)).unique();
}
async function itemFor(ctx: Reader, source: Doc<'catalogSources'>, ownerId: string): Promise<CatalogItem> {
  const [personal, curated] = await Promise.all([entryFor(ctx, ownerId, source._id), entryFor(ctx, CURATED, source._id)]);
  return {
    sourceId: source._id, kind: personal?.kind ?? curated?.kind ?? source.kind, provider: source.provider,
    title: personal?.title ?? curated?.title ?? source.title,
    description: personal?.description ?? curated?.description,
    artworkAvailable: !!source.artworkKey || (source.provider !== 'upload' && providerCapabilities[source.provider].artwork),
    durationUs: source.durationUs, sourceRange: personal?.sourceRange ?? curated?.sourceRange,
    inUserLibrary: !!personal, inGlobalLibrary: !!curated,
    status: source.status, ...(source.error ? { error: source.error } : {}),
  };
}
async function rateLimit(ctx: MutationCtx, ownerId: string) {
  const window = Math.floor(Date.now() / 3_600_000);
  const row = await ctx.db.query('catalogRateLimits').withIndex('by_owner', q => q.eq('ownerId', ownerId)).unique();
  if (row?.window === window && row.count >= 120) throw new ConvexError('Library request limit reached. Try again later.');
  if (row) await ctx.db.patch(row._id, { window, count: row.window === window ? row.count + 1 : 1 });
  else await ctx.db.insert('catalogRateLimits', { ownerId, window, count: 1 });
}
export const page = query({
  args: { kind: catalogKind, query: v.optional(v.string()), scope: v.union(v.literal('personal'), v.literal('curated')), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<CatalogPage> => {
    const ownerId = await owner(ctx);
    const scope = args.scope === 'curated' ? CURATED : ownerId;
    const search = (args.query ?? '').trim().slice(0, 120);
    const options = { ...args.paginationOpts, numItems: Math.min(30, Math.max(1, args.paginationOpts.numItems)) };
    const page = search
      ? await ctx.db.query('catalogEntries').withSearchIndex('search', q => q.search('searchText', search).eq('ownerId', scope).eq('kind', args.kind)).paginate(options)
      : await ctx.db.query('catalogEntries').withIndex('by_owner_kind_order', q => q.eq('ownerId', scope).eq('kind', args.kind)).paginate(options);
    const items: CatalogItem[] = [];
    for (const entry of page.page) {
      const source = await ctx.db.get(entry.sourceId);
      if (source && (!source.ownerId || source.ownerId === ownerId)) items.push(await itemFor(ctx, source, ownerId));
    }
    return { items, cursor: page.isDone ? null : page.continueCursor };
  },
});
export const get = query({ args: { sourceId: v.id('catalogSources') }, handler: async (ctx, args): Promise<CatalogItem> => {
  const ownerId = await owner(ctx);
  return itemFor(ctx, await sourceFor(ctx, args.sourceId, ownerId), ownerId);
} });
/** Artwork can be read before audio is prepared; private source checks still apply. */
export const artworkSource = query({ args: { sourceId: v.id('catalogSources') }, handler: async (ctx, args) => {
  const source = await sourceFor(ctx, args.sourceId, await owner(ctx));
  return { provider: source.provider, externalId: source.externalId, key: source.artworkKey };
} });
export const cacheArtwork = internalMutation({ args: { sourceId: v.id('catalogSources'), key: v.string() }, handler: async (ctx, args) => {
  const source = await ctx.db.get(args.sourceId);
  if (!source || source.ownerId || source.provider === 'upload') throw new Error('Artwork is unavailable');
  if (args.key !== `library/artwork/${source._id}.jpg`) throw new Error('Invalid artwork object');
  if (source.artworkKey) return source.artworkKey;
  await ctx.db.patch(source._id, { artworkKey: args.key });
  return args.key;
} });
export const media = query({ args: { sourceId: v.id('catalogSources') }, handler: async (ctx, args) => {
  const ownerId = await owner(ctx);
  const source = await sourceFor(ctx, args.sourceId, ownerId);
  if (source.status !== 'ready' || !source.key || !source.checksum || !source.mimeType || !source.extension) throw new ConvexError('Audio is not ready yet');
  return { item: await itemFor(ctx, source, ownerId), key: source.key, checksum: source.checksum, mimeType: source.mimeType, extension: source.extension };
} });

async function ensureSource(ctx: MutationCtx, provider: 'youtube' | 'myinstants', kind: 'music' | 'sfx', externalId: string, title: string, durationUs?: number) {
  const existing = await ctx.db.query('catalogSources').withIndex('by_external', q => q.eq('provider', provider).eq('externalId', externalId)).unique();
  if (existing) return existing._id;
  return ctx.db.insert('catalogSources', { provider, externalId, kind, title: title.slice(0, 160), durationUs, status: 'queued', attempt: 0, updatedAt: 0 });
}
export const ensureExternal = mutation({
  args: { provider: catalogProvider, kind: catalogKind, externalId: v.string(), title: v.string(), durationUs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await rateLimit(ctx, await owner(ctx));
    if (!/^[A-Za-z0-9_-]{1,240}$/.test(args.externalId) || !args.title.trim()) throw new ConvexError('Invalid media source');
    return ensureSource(ctx, args.provider, args.kind, args.externalId, args.title, args.durationUs);
  },
});
export const ensureForDeploy = internalMutation({
  args: { provider: catalogProvider, kind: catalogKind, externalId: v.string(), title: v.string() },
  handler: async (ctx, args) => ensureSource(ctx, args.provider, args.kind, args.externalId, args.title),
});

async function begin(ctx: MutationCtx, source: Doc<'catalogSources'>) {
  if (source.status === 'ready') return source._id;
  if (source.status === 'uploading') throw new ConvexError('Finish uploading this audio first');
  if (source.attempt > 0 && ['queued', 'running'].includes(source.status) && source.updatedAt > Date.now() - LEASE_MS) return source._id;
  const attempt = source.attempt + 1;
  await ctx.db.patch(source._id, { status: 'queued', attempt, updatedAt: Date.now(), error: undefined, ...(source.externalRunTerminal ? { externalRunId: undefined, externalRunTerminal: undefined } : {}) });
  await ctx.scheduler.runAfter(0, internal.catalog_actions.prepareSource, { sourceId: source._id, attempt });
  return source._id;
}
export const prepare = mutation({ args: { sourceId: v.id('catalogSources') }, handler: async (ctx, args) => {
  const ownerId = await owner(ctx);
  const source = await sourceFor(ctx, args.sourceId, ownerId);
  if (source.status !== 'ready' && (!source.attempt || source.status === 'failed')) await rateLimit(ctx, ownerId);
  return begin(ctx, source);
} });
export const prepareForDeploy = internalMutation({ args: { sourceId: v.id('catalogSources') }, handler: async (ctx, args) => {
  const source = await ctx.db.get(args.sourceId);
  if (!source || source.ownerId) throw new Error('Unknown public source');
  return begin(ctx, source);
} });
export const context = internalQuery({ args: { sourceId: v.id('catalogSources') }, handler: async (ctx, args) => ctx.db.get(args.sourceId) });
export const progress = internalMutation({
  args: { sourceId: v.id('catalogSources'), attempt: v.number(), externalRunId: v.optional(v.string()), externalRunTerminal: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.attempt !== args.attempt || !['queued', 'running'].includes(source.status)) return false;
    const { sourceId, attempt, ...fields } = args;
    await ctx.db.patch(sourceId, { ...fields, status: 'running', updatedAt: Date.now() });
    return true;
  },
});
export const complete = internalMutation({
  args: { sourceId: v.id('catalogSources'), attempt: v.number(), key: v.string(), checksum: v.string(), size: v.number(), mimeType: v.string(), extension: v.string(), durationUs: v.number() },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.attempt !== args.attempt || !['queued', 'running'].includes(source.status)) return false;
    const { sourceId, attempt, ...fields } = args;
    await ctx.db.patch(sourceId, { ...fields, status: 'ready', updatedAt: Date.now(), error: undefined, uploadKey: undefined });
    if (source.ownerId) {
      const entry = await entryFor(ctx, source.ownerId, sourceId);
      if (!entry) await ctx.db.insert('catalogEntries', { ownerId: source.ownerId, sourceId, kind: source.kind, title: source.title, description: '', searchText: source.title, sortOrder: -Date.now() });
    }
    return true;
  },
});
export const fail = internalMutation({ args: { sourceId: v.id('catalogSources'), attempt: v.number(), error: v.string(), detail: v.optional(v.string()) }, handler: async (ctx, args) => {
  const source = await ctx.db.get(args.sourceId);
  if (source && source.attempt === args.attempt && source.status !== 'ready') await ctx.db.patch(source._id, { status: 'failed', error: args.error.slice(0, 300), errorDetail: args.detail?.slice(0, 500), updatedAt: Date.now() });
} });
export const save = mutation({
  args: { sourceId: v.id('catalogSources'), title: v.optional(v.string()), description: v.optional(v.string()), sourceRange: v.optional(v.union(catalogSourceRange, v.null())) },
  handler: async (ctx, args) => {
    const ownerId = await owner(ctx);
    const source = await sourceFor(ctx, args.sourceId, ownerId);
    if (source.status !== 'ready') throw new ConvexError('Prepare the audio before saving it');
    if (args.sourceRange) validateRange(args.sourceRange, source.durationUs);
    const existing = await entryFor(ctx, ownerId, source._id);
    const curated = await entryFor(ctx, CURATED, source._id);
    const title = (args.title ?? existing?.title ?? curated?.title ?? source.title).trim();
    const description = args.description ?? existing?.description ?? curated?.description ?? '';
    if (!title || title.length > 160 || description.length > 1000) throw new ConvexError('Title or description is too long');
    const sourceRange = args.sourceRange === null ? undefined : args.sourceRange ?? existing?.sourceRange;
    const fields = { ownerId, sourceId: source._id, kind: source.kind, title, description, sourceRange, sortOrder: existing?.sortOrder ?? -Date.now(), searchText: `${title} ${description}` };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert('catalogEntries', fields);
    return source._id;
  },
});
export const remove = mutation({ args: { sourceId: v.id('catalogSources') }, handler: async (ctx, args) => {
  const ownerId = await owner(ctx);
  const source = await sourceFor(ctx, args.sourceId, ownerId);
  const entry = await entryFor(ctx, ownerId, source._id);
  if (entry) await ctx.db.delete(entry._id);
  if (source.ownerId) {
    await ctx.db.delete(source._id);
    await ctx.scheduler.runAfter(0, internal.catalog_actions.deleteObjects, { keys: [source.key, source.uploadKey].filter((key): key is string => !!key) });
  }
} });
export const createUpload = mutation({ args: { title: v.string(), kind: catalogKind, size: v.number(), mimeType: v.string() }, handler: async (ctx, args) => {
  const ownerId = await owner(ctx);
  await rateLimit(ctx, ownerId);
  if (!Number.isSafeInteger(args.size) || args.size < 1 || args.size > MAX_CATALOG_UPLOAD_BYTES || !(CATALOG_UPLOAD_TYPES as readonly string[]).includes(args.mimeType) || !args.title.trim() || args.title.length > 160) throw new ConvexError('Upload an MP3, M4A or WAV file up to 100 MiB');
  const sourceId = await ctx.db.insert('catalogSources', { ...args, title: args.title.trim(), provider: 'upload', externalId: crypto.randomUUID(), ownerId, status: 'uploading', attempt: 0, updatedAt: Date.now() });
  const key = `library-staging/${sourceId}/original`;
  await ctx.db.patch(sourceId, { uploadKey: key });
  return { sourceId, key };
} });
export const finishUpload = mutation({ args: { sourceId: v.id('catalogSources') }, handler: async (ctx, args) => {
  const source = await sourceFor(ctx, args.sourceId, await owner(ctx));
  if (source.provider !== 'upload') throw new ConvexError('Not an upload');
  if (source.status === 'uploading') {
    await ctx.db.patch(source._id, { status: 'queued' });
    return begin(ctx, { ...source, status: 'queued' });
  }
  return begin(ctx, source);
} });

export const startSearch = mutation({ args: { kind: catalogKind, query: v.string() }, handler: async (ctx, args) => {
  const ownerId = await owner(ctx);
  const query = args.query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (query.length < 2 || query.length > 120) throw new ConvexError('Enter 2–120 characters to search');
  const key = `${args.kind}:US:en:v1:${query}`;
  const old = await ctx.db.query('catalogSearches').withIndex('by_key', q => q.eq('key', key)).unique();
  if (old && old.expiresAt > Date.now() && old.status !== 'failed') return old._id;
  await rateLimit(ctx, ownerId);
  if (old) await ctx.db.delete(old._id);
  const id = await ctx.db.insert('catalogSearches', { key, kind: args.kind, query, status: 'running', sourceIds: [], expiresAt: Date.now() + LEASE_MS });
  await ctx.scheduler.runAfter(0, internal.catalog_actions.searchProvider, { searchId: id });
  return id;
} });
export const searchContext = internalQuery({ args: { searchId: v.id('catalogSearches') }, handler: async (ctx, args) => ctx.db.get(args.searchId) });
export const finishSearch = internalMutation({
  args: { searchId: v.id('catalogSearches'), items: v.optional(v.array(discoveredCatalogItem)), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const search = await ctx.db.get(args.searchId);
    if (!search || search.status !== 'running') return;
    const sourceIds: Id<'catalogSources'>[] = [];
    for (const item of (args.items ?? []).slice(0, 20)) sourceIds.push(await ensureSource(ctx, search.kind === 'music' ? 'youtube' : 'myinstants', search.kind, item.externalId, item.title, item.durationUs));
    await ctx.db.patch(search._id, { status: args.error ? 'failed' : 'ready', sourceIds, error: args.error?.slice(0, 300), expiresAt: Date.now() + 24 * 3_600_000 });
  },
});
export const searchResult = query({ args: { searchId: v.id('catalogSearches') }, handler: async (ctx, args) => {
  const ownerId = await owner(ctx);
  const search = await ctx.db.get(args.searchId);
  if (!search) throw new ConvexError('Search expired. Search again.');
  const items: CatalogItem[] = [];
  for (const id of search.sourceIds) {
    const source = await ctx.db.get(id);
    if (source && !source.ownerId) items.push(await itemFor(ctx, source, ownerId));
  }
  return { status: search.status, items, error: search.error };
} });

export const publish = internalMutation({
  args: { revision: v.string(), items: v.array(v.object({ sourceId: v.id('catalogSources'), title: v.string(), description: v.string(), sourceRange: v.optional(catalogSourceRange) })) },
  handler: async (ctx, args) => {
    // One transaction publishes the complete ready revision; failures leave the previous set intact.
    const current = await ctx.db.query('catalogEntries').withIndex('by_owner_source', q => q.eq('ownerId', CURATED)).collect();
    const retained = new Set<string>();
    for (const [sortOrder, item] of args.items.entries()) {
      const source = await ctx.db.get(item.sourceId);
      if (!source || source.ownerId || source.status !== 'ready') throw new Error(`Audio not ready: ${item.title}`);
      if (item.sourceRange) validateRange(item.sourceRange, source.durationUs);
      const fields = { ...item, ownerId: CURATED, kind: source.kind, sortOrder, revision: args.revision, searchText: `${item.title} ${item.description}` };
      const existing = current.find(entry => entry.sourceId === item.sourceId);
      if (existing) await ctx.db.patch(existing._id, { ...fields, sourceRange: item.sourceRange });
      else await ctx.db.insert('catalogEntries', fields);
      retained.add(item.sourceId);
    }
    for (const entry of current) if (!retained.has(entry.sourceId)) await ctx.db.delete(entry._id);
    return { count: args.items.length, revision: args.revision };
  },
});
export const publishedRevision = internalQuery({ args: {}, handler: async ctx => {
  const entry = await ctx.db.query('catalogEntries').withIndex('by_owner_source', q => q.eq('ownerId', CURATED)).first();
  return entry?.revision ?? null;
} });
export const removeForUser = internalMutation({ args: { ownerId: v.string() }, handler: async (ctx, args) => {
  const entries = await ctx.db.query('catalogEntries').withIndex('by_owner_source', q => q.eq('ownerId', args.ownerId)).take(100);
  const sources = await ctx.db.query('catalogSources').withIndex('by_owner', q => q.eq('ownerId', args.ownerId)).take(100);
  for (const entry of entries) await ctx.db.delete(entry._id);
  for (const source of sources) {
    await ctx.db.delete(source._id);
    await ctx.scheduler.runAfter(0, internal.catalog_actions.deleteObjects, { keys: [source.key, source.uploadKey].filter((key): key is string => !!key) });
  }
  const rate = await ctx.db.query('catalogRateLimits').withIndex('by_owner', q => q.eq('ownerId', args.ownerId)).unique();
  if (rate) await ctx.db.delete(rate._id);
  if (entries.length === 100 || sources.length === 100) await ctx.scheduler.runAfter(0, internal.catalog.removeForUser, args);
} });
export const expire = internalMutation({ args: {}, handler: async (ctx) => {
  const searches = await ctx.db.query('catalogSearches').withIndex('by_expiry', q => q.lt('expiresAt', Date.now())).take(100);
  for (const search of searches) await ctx.db.delete(search._id);
  for (const status of ['uploading', 'failed'] as const) {
    const sources = await ctx.db.query('catalogSources').withIndex('by_provider_status_updated', q => q.eq('provider', 'upload').eq('status', status).lt('updatedAt', Date.now() - 86400000)).take(100);
    for (const source of sources) if (source.ownerId && !source.key) {
      await ctx.db.delete(source._id);
      if (source.uploadKey) await ctx.scheduler.runAfter(0, internal.catalog_actions.deleteObjects, { keys: [source.uploadKey] });
    }
  }
} });
