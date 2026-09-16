import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server';
import { requireMember } from './lib/membership';
import { originalKeyFor, proxyKeyFor } from '../assets-key';

export const MAX_ASSET_BYTES = 4 * 1024 * 1024 * 1024;

function validate(args: { sampleId: string; size: number; mimeType: string; name: string }) {
  if (!/^[0-9a-f]{16}$/.test(args.sampleId)) throw new ConvexError('Sample id must be 16 hex characters');
  if (!Number.isSafeInteger(args.size) || args.size < 1 || args.size > MAX_ASSET_BYTES)
    throw new ConvexError('Asset size must be between 1 byte and 4 GiB');
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(args.mimeType)) throw new ConvexError('Unsupported MIME type');
  if (!args.name || args.name.length > 255 || /[/\\\0]/.test(args.name))
    throw new ConvexError('Asset name must be a file name of at most 255 characters');
}

/**
 * Registers an original per (organization, sampleId). Idempotent: a second
 * call returns the same asset. `uploadNeeded` is true until the Worker marks
 * the object ready, so a client can resume an interrupted upload.
 */
export const register = mutation({
  args: {
    organizationId: v.string(),
    sampleId: v.string(),
    size: v.number(),
    mimeType: v.string(),
    name: v.string(),
  },
  handler: async (ctx, { organizationId, ...args }) => {
    const { user } = await requireMember(ctx, organizationId);
    validate(args);
    const existing = await ctx.db
      .query('assets')
      .withIndex('by_org_sample', (q) => q.eq('organizationId', organizationId).eq('sampleId', args.sampleId))
      .unique();
    if (existing) {
      return {
        assetId: existing._id,
        state: existing.originalState,
        uploadNeeded: existing.originalState === 'uploading',
      };
    }
    const now = Date.now();
    const assetId = await ctx.db.insert('assets', {
      organizationId,
      ...args,
      originalState: 'uploading',
      uploadedBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
    return { assetId, state: 'uploading' as const, uploadNeeded: true };
  },
});

/**
 * Every asset of an organization, without keys: what a machine subscribes to
 * so it learns when an original or proxy it is waiting on becomes ready, and
 * which of its own originals still need sending.
 */
export const list = query({
  args: { organizationId: v.string() },
  handler: async (ctx, { organizationId }) => {
    await requireMember(ctx, organizationId);
    const assets = await ctx.db
      .query('assets')
      .withIndex('by_org_sample', (q) => q.eq('organizationId', organizationId))
      .collect();
    return assets.map((asset) => ({
      assetId: asset._id,
      sampleId: asset.sampleId,
      name: asset.name,
      mimeType: asset.mimeType,
      size: asset.size,
      originalState: asset.originalState,
      proxyState: asset.proxyState ?? null,
      proxySize: asset.proxySize ?? null,
      updatedAt: asset.updatedAt,
    }));
  },
});

/**
 * Registers a proxy for an asset whose original this member owns or shares.
 * Idempotent like `register`: a ready proxy needs no upload. The proxy is
 * re-registered (size replaced) only while it is still uploading.
 */
export const registerProxy = mutation({
  args: { assetId: v.id('assets'), size: v.number() },
  handler: async (ctx, { assetId, size }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset) throw new ConvexError('Asset not found');
    await requireMember(ctx, asset.organizationId);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ASSET_BYTES)
      throw new ConvexError('Proxy size must be between 1 byte and 4 GiB');
    if (asset.proxyState === 'ready') return { state: 'ready' as const, uploadNeeded: false };
    await ctx.db.patch(assetId, { proxySize: size, proxyState: 'uploading', updatedAt: Date.now() });
    return { state: 'uploading' as const, uploadNeeded: true };
  },
});

/** Marks the proxy ready once the Worker has seen it in R2, at the key the asset implies. */
export const finishProxy = mutation({
  args: { assetId: v.id('assets'), proxyKey: v.string() },
  handler: async (ctx, { assetId, proxyKey }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset) throw new ConvexError('Asset not found');
    await requireMember(ctx, asset.organizationId);
    if (proxyKey !== proxyKeyFor(asset)) throw new ConvexError('Proxy key does not match the asset');
    if (asset.proxyState !== 'uploading') throw new ConvexError('No proxy upload is in progress');
    await ctx.db.patch(assetId, { proxyKey, proxyState: 'ready', updatedAt: Date.now() });
  },
});

export const get = query({
  args: { organizationId: v.string(), sampleId: v.string() },
  handler: async (ctx, { organizationId, sampleId }) => {
    await requireMember(ctx, organizationId);
    return await ctx.db
      .query('assets')
      .withIndex('by_org_sample', (q) => q.eq('organizationId', organizationId).eq('sampleId', sampleId))
      .unique();
  },
});

/** An asset by id, for a member of its organization; what the Worker needs to sign its key. */
export const describe = query({
  args: { assetId: v.id('assets') },
  handler: async (ctx, { assetId }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset) throw new ConvexError('Asset not found');
    await requireMember(ctx, asset.organizationId);
    return asset;
  },
});

/**
 * Marks an original ready, on a member's behalf, once the Worker has seen
 * the object in R2. The key must be the one this asset's identity implies:
 * nothing a client sends can point an asset at other bytes.
 */
export const finish = mutation({
  args: { assetId: v.id('assets'), originalKey: v.string() },
  handler: async (ctx, { assetId, originalKey }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset) throw new ConvexError('Asset not found');
    await requireMember(ctx, asset.organizationId);
    if (originalKey !== originalKeyFor(asset)) throw new ConvexError('Original key does not match the asset');
    if (asset.originalState === 'ready') return;
    await ctx.db.patch(assetId, { originalKey, originalState: 'ready', updatedAt: Date.now() });
  },
});

/** Called by the Worker after it has verified the object exists in R2. */
export const markReady = internalMutation({
  args: { assetId: v.id('assets'), originalKey: v.string() },
  handler: async (ctx, { assetId, originalKey }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset) throw new ConvexError('Asset not found');
    await ctx.db.patch(assetId, { originalKey, originalState: 'ready', updatedAt: Date.now() });
  },
});
