import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, mutation, type MutationCtx, query, type QueryCtx } from './_generated/server';
import { authComponent } from './auth';
import {
  MAX_POSTS_LISTED,
  MAX_TARGETS,
  socialCover,
  validatePostText,
  validateSchedule,
} from './social_model';

// A post is its own row (Compound projects are local folders, so nothing
// ties a post to a project row). The Posts tab lists them; the composer
// edits one; submitting freezes one target per account.

async function ownedPost(ctx: QueryCtx | MutationCtx, postId: Id<'socialPosts'>, ownerId: string): Promise<Doc<'socialPosts'>> {
  const post = await ctx.db.get(postId);
  if (!post || post.ownerId !== ownerId) throw new ConvexError('Post not found');
  return post;
}
async function ownedMedia(ctx: QueryCtx | MutationCtx, id: Id<'socialMedia'>, ownerId: string, kind: 'video' | 'cover') {
  const media = await ctx.db.get(id);
  if (!media || media.ownerId !== ownerId || media.kind !== kind) throw new ConvexError(kind === 'video' ? 'Video not found' : 'Cover not found');
  return media;
}
function targetsOf(ctx: QueryCtx | MutationCtx, postId: Id<'socialPosts'>) {
  return ctx.db.query('socialPostTargets').withIndex('by_post', (q) => q.eq('postId', postId)).take(MAX_TARGETS);
}
async function present(ctx: QueryCtx | MutationCtx, post: Doc<'socialPosts'>) {
  const targets = await targetsOf(ctx, post._id);
  const media = post.mediaId ? await ctx.db.get(post.mediaId) : null;
  const cover = post.cover && 'mediaId' in post.cover ? await ctx.db.get(post.cover.mediaId) : null;
  return {
    id: post._id,
    caption: post.caption,
    title: post.title ?? null,
    cover: post.cover,
    coverReady: cover?.ready ?? false,
    media: media
      ? {
          id: media._id,
          ready: media.ready,
          size: media.size,
          durationMs: media.durationMs ?? null,
          width: media.width ?? null,
          height: media.height ?? null,
          contentHash: media.contentHash ?? null,
        }
      : null,
    accountIds: post.accountIds,
    scheduledFor: post.scheduledFor,
    timezone: post.timezone,
    projectId: post.projectId ?? null,
    projectName: post.projectName ?? null,
    sceneId: post.sceneId ?? null,
    status: post.status,
    version: post.version,
    hasChanges: post.submittedVersion !== undefined && post.version !== post.submittedVersion,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    targets: targets.map((t) => ({
      id: t._id,
      accountId: t.accountId,
      platform: t.platform,
      username: t.username,
      status: t.status,
      error: t.error ?? null,
      postUrl: t.postUrl ?? null,
      scheduledFor: t.snapshot.scheduledFor,
      timezone: t.snapshot.timezone,
      updatedAt: t.updatedAt,
    })),
  };
}
export type PresentedPost = Awaited<ReturnType<typeof present>>;

export const create = mutation({
  args: {
    timezone: v.optional(v.string()),
    projectId: v.optional(v.string()),
    projectName: v.optional(v.string()),
    sceneId: v.optional(v.string()),
    mediaId: v.optional(v.id('socialMedia')),
  },
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    if (args.mediaId) await ownedMedia(ctx, args.mediaId, user._id, 'video');
    const timezone = args.timezone ?? 'UTC';
    validateSchedule(null, timezone, Date.now());
    const now = Date.now();
    return await ctx.db.insert('socialPosts', {
      ownerId: user._id,
      caption: '',
      cover: null,
      mediaId: args.mediaId,
      accountIds: [],
      scheduledFor: null,
      timezone,
      projectId: args.projectId,
      projectName: args.projectName,
      sceneId: args.sceneId,
      status: 'draft',
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});
/**
 * The one open draft for a scene. Pressing Post in the editor comes here: an
 * unsubmitted draft for the same project and scene is reused, otherwise a
 * new one is created. Submitted posts are never reused, so publishing
 * naturally starts the next draft fresh.
 */
export const openDraft = mutation({
  args: {
    projectId: v.string(),
    sceneId: v.string(),
    projectName: v.optional(v.string()),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    const existing = await ctx.db
      .query('socialPosts')
      .withIndex('by_owner_project_scene', (q) => q.eq('ownerId', user._id).eq('projectId', args.projectId).eq('sceneId', args.sceneId))
      .order('desc')
      .take(20);
    const draft = existing.find((post) => post.status === 'draft');
    if (draft) {
      if (args.projectName && draft.projectName !== args.projectName) await ctx.db.patch(draft._id, { projectName: args.projectName });
      return { postId: draft._id, created: false };
    }
    const timezone = args.timezone ?? 'UTC';
    validateSchedule(null, timezone, Date.now());
    const now = Date.now();
    const postId = await ctx.db.insert('socialPosts', {
      ownerId: user._id,
      caption: '',
      cover: null,
      accountIds: [],
      scheduledFor: null,
      timezone,
      projectId: args.projectId,
      projectName: args.projectName,
      sceneId: args.sceneId,
      status: 'draft',
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { postId, created: true };
  },
});
const isEmptyDraft = (post: Doc<'socialPosts'>) =>
  post.status === 'draft' && !post.caption.trim() && !post.title?.trim() && post.accountIds.length === 0 && !post.mediaId && post.cover === null;
/** Delete a draft nothing was ever put into; closing the composer and cancelling a render call this. */
export const removeIfEmpty = mutation({
  args: { postId: v.id('socialPosts') },
  handler: async (ctx, { postId }) => {
    const user = await authComponent.getAuthUser(ctx);
    const post = await ctx.db.get(postId);
    if (!post || post.ownerId !== user._id || !isEmptyDraft(post)) return false;
    await ctx.db.delete(post._id);
    return true;
  },
});
/** Drop every empty draft the user has; the Posts tab runs this when it opens. */
export const pruneEmptyDrafts = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.getAuthUser(ctx);
    const posts = await ctx.db.query('socialPosts').withIndex('by_owner', (q) => q.eq('ownerId', user._id)).take(MAX_POSTS_LISTED);
    let removed = 0;
    for (const post of posts) {
      if (!isEmptyDraft(post)) continue;
      await ctx.db.delete(post._id);
      removed++;
    }
    return removed;
  },
});
/** Every post the user has, newest first. The Posts tab groups them client-side. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];
    const posts = await ctx.db
      .query('socialPosts')
      .withIndex('by_owner', (q) => q.eq('ownerId', user._id))
      .order('desc')
      .take(MAX_POSTS_LISTED);
    return await Promise.all(posts.map((post) => present(ctx, post)));
  },
});
export const get = query({
  args: { postId: v.id('socialPosts') },
  handler: async (ctx, { postId }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return null;
    const post = await ctx.db.get(postId);
    if (!post || post.ownerId !== user._id) return null;
    return await present(ctx, post);
  },
});
export const save = mutation({
  args: {
    postId: v.id('socialPosts'),
    expectedVersion: v.optional(v.number()),
    caption: v.optional(v.string()),
    title: v.optional(v.union(v.null(), v.string())),
    cover: v.optional(socialCover),
    mediaId: v.optional(v.id('socialMedia')),
    accountIds: v.optional(v.array(v.id('socialAccounts'))),
    scheduledFor: v.optional(v.union(v.null(), v.number())),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    const post = await ownedPost(ctx, args.postId, user._id);
    if (args.expectedVersion !== undefined && args.expectedVersion !== post.version)
      throw new ConvexError('The post changed elsewhere. Reload it before saving.');
    if (post.status === 'published' || post.status === 'cancelled')
      throw new ConvexError('This post is finished. Create a new post instead.');
    if (args.caption !== undefined || args.title !== undefined)
      validatePostText(args.caption ?? post.caption, args.title === null ? undefined : (args.title ?? post.title));
    if (args.cover && 'mediaId' in args.cover) await ownedMedia(ctx, args.cover.mediaId, user._id, 'cover');
    if (args.cover && 'offsetMs' in args.cover && (!Number.isFinite(args.cover.offsetMs) || args.cover.offsetMs < 0))
      throw new ConvexError('Choose a valid cover frame.');
    if (args.mediaId) await ownedMedia(ctx, args.mediaId, user._id, 'video');
    if (args.accountIds) {
      if (args.accountIds.length > MAX_TARGETS) throw new ConvexError(`Choose at most ${MAX_TARGETS} accounts`);
      for (const id of args.accountIds) {
        const account = await ctx.db.get(id);
        if (!account || account.ownerId !== user._id) throw new ConvexError('Account not found');
      }
    }
    if (args.timezone !== undefined) validateSchedule(null, args.timezone, Date.now());
    const { postId: _postId, expectedVersion: _expected, title, ...fields } = args;
    await ctx.db.patch(post._id, {
      ...fields,
      ...(title !== undefined ? { title: title ?? undefined } : {}),
      version: post.version + 1,
      updatedAt: Date.now(),
    });
    return post.version + 1;
  },
});
async function validateSubmission(ctx: MutationCtx, post: Doc<'socialPosts'>) {
  if (!post.mediaId) throw new ConvexError('Add a video before posting.');
  const media = await ownedMedia(ctx, post.mediaId, post.ownerId, 'video');
  if (!media.ready) throw new ConvexError('The video is still uploading.');
  if (post.cover && 'offsetMs' in post.cover && media.durationMs !== undefined && post.cover.offsetMs >= media.durationMs)
    throw new ConvexError('Choose a cover frame inside the video.');
  if (post.cover && 'mediaId' in post.cover) {
    const cover = await ownedMedia(ctx, post.cover.mediaId, post.ownerId, 'cover');
    if (!cover.ready) throw new ConvexError('The cover is still uploading.');
  }
  validatePostText(post.caption, post.title);
  validateSchedule(post.scheduledFor, post.timezone, Date.now());
  const accountIds = [...new Set(post.accountIds)];
  if (!accountIds.length) throw new ConvexError('Select at least one account to post to.');
  if (accountIds.length > MAX_TARGETS) throw new ConvexError(`Choose at most ${MAX_TARGETS} accounts`);
  const accounts: Doc<'socialAccounts'>[] = [];
  for (const id of accountIds) {
    const account = await ctx.db.get(id);
    if (!account || account.ownerId !== post.ownerId || !account.active)
      throw new ConvexError('Reconnect your selected accounts before posting.');
    accounts.push(account);
  }
  return { media, accountIds, accounts };
}
export const submit = mutation({
  args: { postId: v.id('socialPosts'), expectedVersion: v.number() },
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    const post = await ownedPost(ctx, args.postId, user._id);
    if (post.version !== args.expectedVersion) throw new ConvexError('The post changed. Review it before posting.');
    if (post.submittedVersion === post.version && post.status !== 'draft') return null;
    if (post.status !== 'draft' && post.status !== 'scheduled' && post.status !== 'cancelled')
      throw new ConvexError('This post is already being processed. Check its status.');
    const { media, accountIds, accounts } = await validateSubmission(ctx, post);
    const targets = await targetsOf(ctx, post._id);
    const isUpdate = post.status === 'scheduled';
    if (isUpdate) {
      if (targets.length !== accountIds.length || targets.some((t) => !accountIds.includes(t.accountId)))
        throw new ConvexError('Cancel the schedule before changing its accounts.');
      if (targets.some((t) => (t.leaseExpiresAt ?? 0) > Date.now()))
        throw new ConvexError('Checking the scheduled post. Try saving again in a moment.');
      if (post.scheduledFor === null) throw new ConvexError('Cancel the schedule before choosing Post now.');
    }
    const snapshot = {
      caption: post.caption,
      title: post.title,
      cover: post.cover,
      mediaId: media._id,
      scheduledFor: post.scheduledFor,
      timezone: post.timezone,
    };
    const now = Date.now();
    if (!isUpdate) for (const t of targets) await ctx.db.delete(t._id);
    for (const account of accounts) {
      const existing = isUpdate ? targets.find((t) => t.accountId === account._id) : undefined;
      if (existing) {
        await ctx.db.patch(existing._id, {
          requestedSnapshot: snapshot,
          requestedVersion: post.version,
          requestedMediaToken: crypto.randomUUID(),
          status: 'queued',
          operation: 'update',
          requestBody: undefined,
          attempts: 0,
          dueAt: now,
          leaseToken: undefined,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('socialPostTargets', {
          ownerId: post.ownerId,
          postId: post._id,
          accountId: account._id,
          platform: account.platform,
          username: account.username,
          providerAccountId: account.providerId,
          snapshot,
          snapshotVersion: post.version,
          mediaToken: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          status: 'queued',
          operation: 'create',
          attempts: 0,
          dueAt: now,
          updatedAt: now,
        });
      }
    }
    await ctx.db.patch(post._id, {
      submittedVersion: isUpdate ? post.submittedVersion : post.version,
      status: 'submitting',
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.social_dispatch.sweep, {});
    return null;
  },
});
export const cancel = mutation({
  args: { postId: v.id('socialPosts') },
  handler: async (ctx, { postId }) => {
    const user = await authComponent.getAuthUser(ctx);
    const post = await ownedPost(ctx, postId, user._id);
    if (post.status === 'draft' || post.status === 'cancelled') return null;
    const targets = await targetsOf(ctx, post._id);
    if (targets.some((t) => (t.leaseExpiresAt ?? 0) > Date.now()))
      throw new ConvexError('Posting is being checked right now. Try cancelling again in a moment.');
    const cancellable = targets.filter((t) => t.status !== 'published' && t.status !== 'publishing' && t.status !== 'cancelled');
    if (!cancellable.length) throw new ConvexError('These destinations are already publishing or published.');
    for (const t of cancellable)
      await ctx.db.patch(t._id, { operation: 'cancel', status: 'cancelling', dueAt: Date.now(), attempts: 0, updatedAt: Date.now() });
    await ctx.db.patch(post._id, { status: 'cancelling', updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.social_dispatch.sweep, {});
    return null;
  },
});
export const retry = mutation({
  args: { targetId: v.id('socialPostTargets') },
  handler: async (ctx, { targetId }) => {
    const user = await authComponent.getAuthUser(ctx);
    const target = await ctx.db.get(targetId);
    if (!target || target.ownerId !== user._id) throw new ConvexError('Post not found');
    if (target.status !== 'failed' && target.status !== 'checking') return null;
    const account = await ctx.db.get(target.accountId);
    if (!account?.active && target.operation !== 'cancel') throw new ConvexError('Reconnect this account first.');
    const retryOperation = target.providerPostId ? 'retry' : 'create';
    const nextOperation = target.requestedSnapshot ? 'update' : retryOperation;
    await ctx.db.patch(targetId, {
      status: 'checking',
      operation: target.operation === 'cancel' ? 'cancel' : nextOperation,
      dueAt: Date.now(),
      attempts: 0,
      error: undefined,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.social_dispatch.sweep, {});
    return null;
  },
});
/** Delete a post that is not mid-flight. Published history is kept unless the user removes it explicitly. */
export const remove = mutation({
  args: { postId: v.id('socialPosts') },
  handler: async (ctx, { postId }) => {
    const user = await authComponent.getAuthUser(ctx);
    const post = await ownedPost(ctx, postId, user._id);
    const targets = await targetsOf(ctx, post._id);
    if (targets.some((t) => (t.leaseExpiresAt ?? 0) > Date.now()))
      throw new ConvexError('Posting is being checked right now. Try again in a moment.');
    if (!['draft', 'published', 'cancelled', 'failed'].includes(post.status))
      throw new ConvexError('Cancel this post before deleting it.');
    for (const t of targets) await ctx.db.delete(t._id);
    await ctx.db.delete(post._id);
    return null;
  },
});
export const removeForUser = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    for (const table of ['socialPostTargets', 'socialPosts'] as const) {
      const rows = await ctx.db.query(table).withIndex('by_owner', (q) => q.eq('ownerId', ownerId)).collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    return null;
  },
});
