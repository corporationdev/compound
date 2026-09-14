import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import { LEASE_MS, MAX_TARGETS, aggregateSocialStatus, socialOperation, socialStatus } from './social_model';

// Ported from PostBob's social_jobs.ts: a durable per-target queue with
// leases so a crashed action never leaves a target stuck, and a one-minute
// cron sweep that picks up anything due.

const NEVER = Number.MAX_SAFE_INTEGER;

/** Roll the targets' statuses up to the post, and release a fully cancelled post back to draft-editable state. */
export async function refreshPost(ctx: MutationCtx, id: Id<'socialPosts'>) {
  const targets = await ctx.db
    .query('socialPostTargets')
    .withIndex('by_post', (q) => q.eq('postId', id))
    .take(MAX_TARGETS);
  const post = await ctx.db.get(id);
  if (!post) return;
  const status = aggregateSocialStatus(targets.map((t) => t.status));
  await ctx.db.patch(id, {
    status,
    ...(targets.length && targets.every((t) => !t.requestedSnapshot && t.snapshotVersion === targets[0]?.snapshotVersion)
      ? { submittedVersion: targets[0]?.snapshotVersion }
      : {}),
    updatedAt: Date.now(),
    ...(status === 'cancelled' ? { submittedVersion: undefined, version: post.version + 1 } : {}),
  });
}
export const due = internalQuery({
  args: {},
  handler: async (ctx) => {
    const targets = await ctx.db
      .query('socialPostTargets')
      .withIndex('by_due', (q) => q.lte('dueAt', Date.now()))
      .take(30);
    return targets.map((t) => t._id);
  },
});
/** A scheduled instant that passed before the first submit never becomes an implicit "post now". */
async function handleMissedSchedule(
  ctx: MutationCtx,
  target: Doc<'socialPostTargets'>,
  snapshot: Doc<'socialPostTargets'>['snapshot'],
): Promise<boolean> {
  if (
    ((target.operation === 'create' && !target.firstAttemptAt) || target.operation === 'update') &&
    snapshot.scheduledFor !== null &&
    snapshot.scheduledFor <= Date.now()
  ) {
    const hasExistingPost = target.providerPostId !== undefined;
    await ctx.db.patch(target._id, {
      status: hasExistingPost ? 'checking' : 'failed',
      operation: hasExistingPost ? 'poll' : target.operation,
      error: 'The scheduled time passed before this post was ready. It was not posted late.',
      dueAt: hasExistingPost ? Date.now() : NEVER,
      updatedAt: Date.now(),
    });
    await refreshPost(ctx, target.postId);
    return true;
  }
  return false;
}
export const claim = internalMutation({
  args: { id: v.id('socialPostTargets') },
  handler: async (ctx, { id }): Promise<Doc<'socialPostTargets'> | null> => {
    const target = await ctx.db.get(id);
    if (!target || target.dueAt > Date.now() || (target.leaseExpiresAt ?? 0) > Date.now()) return null;
    if (target.status === 'published' || target.status === 'cancelled') {
      await ctx.db.patch(id, { dueAt: NEVER });
      return null;
    }
    const snapshot = target.requestedSnapshot ?? target.snapshot;
    const media = await ctx.db.get(snapshot.mediaId);
    const cover = snapshot.cover && 'mediaId' in snapshot.cover ? await ctx.db.get(snapshot.cover.mediaId) : null;
    if (
      target.operation !== 'cancel' &&
      target.operation !== 'poll' &&
      (!media?.ready || (snapshot.cover && 'mediaId' in snapshot.cover && !cover?.ready))
    ) {
      await ctx.db.patch(id, { status: 'uploading', dueAt: Date.now() + 15_000, updatedAt: Date.now() });
      await refreshPost(ctx, target.postId);
      return null;
    }
    if (await handleMissedSchedule(ctx, target, snapshot)) return null;
    const leaseToken = crypto.randomUUID();
    await ctx.db.patch(id, {
      leaseToken,
      leaseExpiresAt: Date.now() + LEASE_MS,
      dueAt: Date.now() + LEASE_MS,
      attempts: target.attempts + 1,
    });
    return { ...target, leaseToken, attempts: target.attempts + 1 };
  },
});
/** Freeze the exact create body before the first attempt so every retry replays it byte for byte. */
export const saveRequest = internalMutation({
  args: { id: v.id('socialPostTargets'), leaseToken: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.id);
    if (!target || target.leaseToken !== args.leaseToken || target.operation !== 'create' || (target.leaseExpiresAt ?? 0) <= Date.now())
      return false;
    await ctx.db.patch(args.id, {
      requestBody: target.requestBody ?? args.body,
      firstAttemptAt: target.firstAttemptAt ?? Date.now(),
    });
    return true;
  },
});
export const settle = internalMutation({
  args: {
    id: v.id('socialPostTargets'),
    leaseToken: v.string(),
    status: socialStatus,
    appliedUpdate: v.optional(v.boolean()),
    providerPostId: v.optional(v.string()),
    postUrl: v.optional(v.string()),
    error: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    operation: v.optional(socialOperation),
  },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.id);
    if (!target || target.leaseToken !== args.leaseToken) return null;
    await ctx.db.patch(args.id, {
      ...(args.appliedUpdate && target.requestedSnapshot
        ? {
            snapshot: target.requestedSnapshot,
            snapshotVersion: target.requestedVersion ?? target.snapshotVersion,
            mediaToken: target.requestedMediaToken ?? target.mediaToken,
            requestedSnapshot: undefined,
            requestedVersion: undefined,
            requestedMediaToken: undefined,
          }
        : {}),
      status: args.status,
      providerPostId: args.providerPostId ?? target.providerPostId,
      postUrl: args.postUrl ?? target.postUrl,
      error: args.error,
      dueAt: args.dueAt ?? NEVER,
      operation: args.operation ?? target.operation,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    await refreshPost(ctx, target.postId);
    return null;
  },
});
export const account = internalQuery({
  args: { id: v.id('socialAccounts') },
  handler: async (ctx, args): Promise<Doc<'socialAccounts'> | null> => await ctx.db.get(args.id),
});
/** A webhook only wakes the target; the sweep re-fetches live state so a stale event cannot regress a delivery. */
export const recordEvent = internalMutation({
  args: { eventId: v.string(), providerPostId: v.string() },
  handler: async (ctx, args) => {
    const old = await ctx.db.query('socialWebhookEvents').withIndex('by_event', (q) => q.eq('eventId', args.eventId)).unique();
    if (old) return null;
    await ctx.db.insert('socialWebhookEvents', { ...args, receivedAt: Date.now() });
    const targets = await ctx.db
      .query('socialPostTargets')
      .withIndex('by_provider_post', (q) => q.eq('providerPostId', args.providerPostId))
      .take(MAX_TARGETS);
    for (const target of targets) {
      if (target.status !== 'published' && target.status !== 'cancelled' && (target.leaseExpiresAt ?? 0) <= Date.now())
        await ctx.db.patch(target._id, { dueAt: Date.now() });
    }
    await ctx.scheduler.runAfter(0, internal.social_dispatch.sweep, {});
    return null;
  },
});
/** Only a definitive rejection of the first create attempt can clear the uncertainty about whether it landed. */
export const rejectRequest = internalMutation({
  args: { id: v.id('socialPostTargets'), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.id);
    if (target?.leaseToken === args.leaseToken)
      await ctx.db.patch(args.id, { firstAttemptAt: undefined, requestBody: undefined });
    return null;
  },
});
