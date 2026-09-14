import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server';
import { authComponent } from './auth';
import { MAX_SOCIAL_BYTES, socialMediaKind } from './social_model';

const VIDEO_TYPES = ['video/mp4'];
const COVER_TYPES = ['image/jpeg', 'image/png'];

/**
 * Register a rendered video or cover before its bytes go to R2. The Worker
 * calls this from `/upload/begin`, then opens a multipart upload on `key`.
 * Nothing reads the object until `markReady`, which the Worker calls from
 * `/upload/complete` after assembling the parts and checking the object
 * really exists with the declared size and type.
 */
export const create = mutation({
  args: {
    kind: socialMediaKind,
    contentType: v.string(),
    size: v.number(),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    projectId: v.optional(v.string()),
    projectName: v.optional(v.string()),
    sceneId: v.optional(v.string()),
    contentHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    if (args.contentHash !== undefined && !/^[a-f0-9]{64}$/.test(args.contentHash)) throw new ConvexError('Invalid content hash');
    const types = args.kind === 'video' ? VIDEO_TYPES : COVER_TYPES;
    if (!Number.isSafeInteger(args.size) || args.size < 1 || args.size > MAX_SOCIAL_BYTES || !types.includes(args.contentType))
      throw new ConvexError(
        args.kind === 'video'
          ? 'Post videos must be MP4 files up to 300 MiB.'
          : 'Covers must be JPEG or PNG images up to 300 MiB.',
      );
    const id = await ctx.db.insert('socialMedia', {
      ...args,
      ownerId: user._id,
      key: '',
      ready: false,
      createdAt: Date.now(),
    });
    await ctx.db.patch(id, { key: `social/${id}` });
    return (await ctx.db.get(id))!;
  },
});
/** A ready upload with the same render hash, so the same bytes are never uploaded twice. */
export const findByHash = query({
  args: { contentHash: v.string(), kind: socialMediaKind },
  handler: async (ctx, { contentHash, kind }) => {
    const user = await authComponent.getAuthUser(ctx);
    const rows = await ctx.db
      .query('socialMedia')
      .withIndex('by_owner_hash', (q) => q.eq('ownerId', user._id).eq('contentHash', contentHash))
      .order('desc')
      .take(10);
    const media = rows.find((row) => row.kind === kind && row.ready);
    return media ? { id: media._id } : null;
  },
});
export const get = query({
  args: { id: v.id('socialMedia') },
  handler: async (ctx, { id }) => {
    const user = await authComponent.getAuthUser(ctx);
    const media = await ctx.db.get(id);
    if (!media || media.ownerId !== user._id) throw new ConvexError('Media not found');
    return media;
  },
});
export const markReady = mutation({
  args: { id: v.id('socialMedia'), sha256: v.optional(v.string()) },
  handler: async (ctx, { id, sha256 }) => {
    const user = await authComponent.getAuthUser(ctx);
    const media = await ctx.db.get(id);
    if (!media || media.ownerId !== user._id) throw new ConvexError('Media not found');
    await ctx.db.patch(id, { ready: true, ...(sha256 ? { sha256 } : {}) });
    return null;
  },
});
/**
 * Resolve the capability URL Zernio fetches. The token is the whole
 * credential (122 bits of randomness per target), so this is a public query.
 * A cancelled target or a mismatched token yields nothing.
 */
export const resolve = query({
  args: { targetId: v.string(), token: v.string(), kind: socialMediaKind },
  handler: async (ctx, args): Promise<{ key: string; contentType: string; size: number } | null> => {
    const id = ctx.db.normalizeId('socialPostTargets', args.targetId);
    if (!id) return null;
    const target = await ctx.db.get(id);
    if (!target || target.status === 'cancelled') return null;
    if (target.mediaToken !== args.token && target.requestedMediaToken !== args.token) return null;
    const snapshot =
      target.requestedMediaToken === args.token ? (target.requestedSnapshot ?? target.snapshot) : target.snapshot;
    let mediaId;
    if (args.kind === 'video') mediaId = snapshot.mediaId;
    else if (snapshot.cover && 'mediaId' in snapshot.cover) mediaId = snapshot.cover.mediaId;
    if (!mediaId) return null;
    const media = await ctx.db.get(mediaId);
    if (!media?.ready) return null;
    return { key: media.key, contentType: media.contentType, size: media.size };
  },
});
export const removeForUser = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    const rows = await ctx.db.query('socialMedia').withIndex('by_owner', (q) => q.eq('ownerId', ownerId)).collect();
    for (const row of rows) await ctx.db.delete(row._id);
    // R2 objects under `social/` are removed by the bucket lifecycle rule.
    return null;
  },
});
