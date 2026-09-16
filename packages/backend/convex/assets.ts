import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server';
import { requireMember } from './lib/membership';
import { originalKeyFor } from '../assets-key';

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
