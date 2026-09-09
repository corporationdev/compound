import { ConvexError, v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { authComponent } from './auth';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const create = mutation({
  args: { contentType: v.string(), size: v.number() },
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    if (
      !Number.isSafeInteger(args.size) ||
      args.size < 1 ||
      args.size > MAX_UPLOAD_BYTES ||
      !['audio/ogg', 'video/mp4'].includes(args.contentType)
    ) {
      throw new ConvexError('Unsupported upload. Use Ogg audio or MP4 video up to 100 MiB.');
    }
    const now = Date.now();
    const active = await ctx.db
      .query('uploads')
      .withIndex('by_owner', (q) => q.eq('ownerId', user._id).gt('expiresAt', now))
      .take(100);
    if (active.length >= 100) throw new ConvexError('Upload limit reached. Try again later.');
    const id = await ctx.db.insert('uploads', {
      ...args,
      ownerId: user._id,
      key: '',
      calls: 0,
      expiresAt: now + 24 * 60 * 60 * 1000,
    });
    await ctx.db.patch(id, { key: `media/${id}` });
    return await ctx.db.get(id);
  },
});
export const get = query({
  args: { id: v.id('uploads') },
  handler: async (ctx, { id }) => {
    const user = await authComponent.getAuthUser(ctx);
    const upload = await ctx.db.get(id);
    if (!upload || upload.ownerId !== user._id || upload.expiresAt <= Date.now())
      throw new ConvexError('Upload not found or expired');
    return upload;
  },
});
export const removeForUser = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    const uploads = await ctx.db
      .query('uploads')
      .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
      .collect();
    for (const upload of uploads) await ctx.db.delete(upload._id);
    // R2 lifecycle removes bytes after 24h; deleting these records immediately revokes API access.
  },
});
export const expire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db
      .query('uploads')
      .withIndex('by_expiry', (q) => q.lt('expiresAt', Date.now()))
      .take(500);
    for (const upload of expired) await ctx.db.delete(upload._id);
  },
});

/** Bound repeated provider calls without a job queue or billing ledger. */
export const claim = mutation({
  args: { id: v.id('uploads') },
  handler: async (ctx, { id }) => {
    const user = await authComponent.getAuthUser(ctx);
    const upload = await ctx.db.get(id);
    if (!upload || upload.ownerId !== user._id || upload.expiresAt <= Date.now())
      throw new ConvexError('Upload not found or expired');
    if (upload.calls >= 10) throw new ConvexError('Media request limit reached');
    await ctx.db.patch(id, { calls: upload.calls + 1 });
  },
});
