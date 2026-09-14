import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { type ActionCtx, internalAction } from './_generated/server';
import { REQUEST_WINDOW_MS, retryDelay, type SocialStatus } from './social_model';
import { ProviderError, providerId, record, string, zernio } from './social_provider';

// Ported from PostBob's social_dispatch.ts. One Zernio post per target, a
// stable request id and frozen body for the create, and reconciliation by
// caption + media URL when a response was lost.

type Target = Doc<'socialPostTargets'>;

/** The capability URL Zernio fetches media from: the Worker checks the token and redirects to a signed R2 GET. */
export function mediaUrl(target: Target, kind: 'video' | 'cover'): string {
  const server = process.env.SERVER_URL;
  if (!server) throw new Error('Missing SERVER_URL');
  const url = new URL(`/social/media/${target._id}/${kind}`, server);
  url.searchParams.set('token', target.mediaToken);
  return url.toString();
}
export function matchesTarget(post: Record<string, unknown>, target: Target): boolean {
  const platforms = Array.isArray(post.platforms) ? post.platforms.map(record) : [];
  return (
    platforms.length === 1 &&
    providerId(platforms[0]?.accountId) === target.providerAccountId &&
    platforms[0]?.platform === target.platform
  );
}
export function matchesSubmission(post: Record<string, unknown>, target: Target): boolean {
  const media = Array.isArray(post.mediaItems) ? post.mediaItems.map(record) : [];
  return (
    matchesTarget(post, target) &&
    post.content === target.snapshot.caption &&
    media.some((item) => item.url === mediaUrl(target, 'video'))
  );
}
function desiredTarget(target: Target): Target {
  return target.requestedSnapshot
    ? { ...target, snapshot: target.requestedSnapshot, mediaToken: target.requestedMediaToken ?? target.mediaToken }
    : target;
}
function allowsInteraction(settings: Record<string, unknown>, interaction: 'comment' | 'duet' | 'stitch'): boolean {
  // Live creator-info uses allow_* objects; the API docs show bare booleans.
  const setting = settings[`allow_${interaction}`];
  if (setting !== undefined) return record(setting).enabled === true;
  return settings[interaction] === true;
}
function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}
/**
 * The Zernio create/update body for one target. Platform quirks live here:
 * Instagram takes a thumbnail offset, TikTok needs creator info and explicit
 * consent flags, YouTube wants a title, Facebook video posts as a Reel.
 */
export async function buildBody(target: Target): Promise<string> {
  const { cover, caption, title, scheduledFor, timezone } = target.snapshot;
  const customCover = cover !== null && 'mediaId' in cover;
  const offset = cover && 'offsetMs' in cover ? cover.offsetMs : 0;
  const platform: Record<string, unknown> = { accountId: target.providerAccountId, platform: target.platform };
  const body: Record<string, unknown> = {
    content: caption,
    mediaItems: [
      {
        type: 'video',
        url: mediaUrl(target, 'video'),
        mimeType: 'video/mp4',
        ...(customCover ? { thumbnail: mediaUrl(target, 'cover') } : {}),
      },
    ],
    platforms: [platform],
    timezone,
    ...(scheduledFor === null ? { publishNow: true } : { scheduledFor: new Date(scheduledFor).toISOString() }),
  };
  switch (target.platform) {
    case 'instagram':
      platform.platformSpecificData = {
        shareToFeed: true,
        ...(customCover ? { instagramThumbnail: mediaUrl(target, 'cover') } : { thumbOffset: offset }),
      };
      break;
    case 'tiktok': {
      const info = await zernio(`/accounts/${encodeURIComponent(target.providerAccountId)}/tiktok/creator-info?mediaType=video`);
      const privacyLevels = Array.isArray(info.privacyLevels) ? info.privacyLevels.map(record) : [];
      if (!privacyLevels.some((level) => level.value === 'PUBLIC_TO_EVERYONE'))
        throw new ProviderError('This TikTok account cannot publish publicly through Compound. Reconnect it in Settings.', 400, {});
      const interactions = record(record(info.postingLimits).interactionSettings);
      body.tiktokSettings = {
        privacy_level: 'PUBLIC_TO_EVERYONE',
        allow_comment: allowsInteraction(interactions, 'comment'),
        allow_duet: allowsInteraction(interactions, 'duet'),
        allow_stitch: allowsInteraction(interactions, 'stitch'),
        content_preview_confirmed: true,
        express_consent_given: true,
        ...(customCover ? { video_cover_image_url: mediaUrl(target, 'cover') } : { video_cover_timestamp_ms: offset }),
      };
      break;
    }
    case 'youtube':
      platform.platformSpecificData = {
        title: (title?.trim() || firstLine(caption) || 'Untitled video').slice(0, 100),
        visibility: 'public',
        madeForKids: false,
      };
      break;
    case 'facebook':
      platform.platformSpecificData = {
        contentType: 'reel',
        ...(title?.trim() ? { title: title.trim() } : {}),
      };
      break;
    case 'linkedin':
    case 'twitter':
      break;
  }
  return JSON.stringify(body);
}
async function getPost(id: string): Promise<Record<string, unknown>> {
  const response = await zernio(`/posts/${encodeURIComponent(id)}`);
  return record(response.post ?? response);
}
async function findExisting(target: Target): Promise<Record<string, unknown> | null> {
  for (let page = 1; page <= 3; page += 1) {
    const response = await zernio(
      `/posts?${new URLSearchParams({ accountId: target.providerAccountId, sortBy: 'created-desc', limit: '100', page: String(page) })}`,
    );
    if (!Array.isArray(response.posts)) throw new Error('Posting service did not return post status');
    for (const value of response.posts) {
      const post = record(value);
      if (matchesSubmission(post, target)) return post;
    }
    if (response.posts.length < 100) break;
  }
  return null;
}
async function settleProvider(ctx: ActionCtx, target: Target, post: Record<string, unknown>, appliedUpdate = false): Promise<void> {
  const id = providerId(post._id);
  if (!(id && matchesTarget(post, target))) throw new Error('Posting service returned a different destination. Checking status.');
  const destination = record((post.platforms as unknown[])[0]);
  const raw = string(destination.status) ?? string(post.status);
  let status: SocialStatus = 'publishing';
  if (raw === 'published' || post.status === 'published') status = 'published';
  else if (raw === 'failed' || post.status === 'failed') status = 'failed';
  else if (raw === 'scheduled' || post.status === 'scheduled') status = 'scheduled';
  const dueAt =
    status === 'scheduled'
      ? Math.min(Date.now() + 5 * 60_000, Math.max(Date.now() + 15_000, (target.snapshot.scheduledFor ?? Date.now()) + 5000))
      : Date.now() + 20_000;
  await ctx.runMutation(internal.social_jobs.settle, {
    id: target._id,
    leaseToken: target.leaseToken ?? '',
    status,
    appliedUpdate: appliedUpdate || Boolean(target.requestedSnapshot && matchesSubmission(post, desiredTarget(target))),
    providerPostId: id,
    postUrl: string(destination.platformPostUrl),
    error:
      status === 'failed'
        ? (string(destination.error) ?? string(record(destination.error).message) ?? string(post.error) ?? 'Posting failed. Check this account and retry.')
        : undefined,
    ...(status === 'publishing' || status === 'scheduled' ? { dueAt, operation: 'poll' as const } : {}),
  });
}
async function recoverDuplicate(error: ProviderError, target: Target): Promise<Record<string, unknown>> {
  const id = string(error.body.existingPostId);
  if (id) {
    const found = await getPost(id);
    if (matchesSubmission(found, target)) return found;
  }
  throw new Error('The service reported a duplicate. Checking the original post before trying again.');
}
async function createPost(target: Target, ctx: ActionCtx): Promise<Record<string, unknown>> {
  if (target.firstAttemptAt && Date.now() - target.firstAttemptAt >= REQUEST_WINDOW_MS) {
    const found = await findExisting(target);
    if (found) return found;
    // Exact-payload deduplication lasts 24h. Outside it, reconcile only.
    if (Date.now() - target.firstAttemptAt > 23 * 60 * 60_000)
      throw new Error('Still checking whether this post was accepted. Do not post it again yet.');
  }
  const body = target.requestBody ?? (await buildBody(target));
  const saved = await ctx.runMutation(internal.social_jobs.saveRequest, { id: target._id, leaseToken: target.leaseToken ?? '', body });
  if (!saved) throw new Error('Posting job changed. Checking status.');
  try {
    const response = await zernio('/posts', { method: 'POST', headers: { 'x-request-id': target.requestId }, body });
    const post = record(response.post ?? response.existingPost);
    if (!providerId(post._id)) throw new Error('Posting response was incomplete. Checking status.');
    return post;
  } catch (error) {
    if (error instanceof ProviderError && error.status === 409) return await recoverDuplicate(error, target);
    if (!target.firstAttemptAt && error instanceof ProviderError && !error.retryable)
      await ctx.runMutation(internal.social_jobs.rejectRequest, { id: target._id, leaseToken: target.leaseToken ?? '' });
    throw error;
  }
}
async function cancelTarget(ctx: ActionCtx, target: Target): Promise<void> {
  const leaseToken = target.leaseToken ?? '';
  let id = target.providerPostId;
  if (!id && target.firstAttemptAt) {
    const found = await findExisting(target);
    if (!found) throw new Error('Checking the original submission before confirming cancellation.');
    id = providerId(found._id);
  }
  if (id) {
    try {
      const current = await getPost(id);
      if (current.status === 'published' || current.status === 'publishing') {
        await settleProvider(ctx, target, current);
        return;
      }
      await zernio(`/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof ProviderError && error.status === 404)) throw error;
    }
  }
  await ctx.runMutation(internal.social_jobs.settle, { id: target._id, leaseToken, status: 'cancelled' });
}
async function deliver(ctx: ActionCtx, target: Target): Promise<void> {
  if (target.operation === 'cancel') {
    await cancelTarget(ctx, target);
    return;
  }
  const account = await ctx.runQuery(internal.social_jobs.account, { id: target.accountId });
  if (!account?.active) throw new ProviderError('Reconnect this account in Settings, then retry.', 401, {});
  if (!target.providerPostId) {
    await settleProvider(ctx, target, await createPost(target, ctx));
    return;
  }
  const id = encodeURIComponent(target.providerPostId);
  const current = await getPost(target.providerPostId);
  if (current.status === 'published' || current.status === 'publishing') {
    await settleProvider(ctx, target, current);
    return;
  }
  if (target.operation === 'update') {
    const response = await zernio(`/posts/${id}`, { method: 'PUT', body: await buildBody(desiredTarget(target)) });
    await settleProvider(ctx, target, record(response.post ?? (await getPost(target.providerPostId))), true);
  } else if (target.operation === 'retry' && current.status === 'failed') {
    const response = await zernio(`/posts/${id}/retry`, { method: 'POST' });
    await settleProvider(ctx, target, record(response.post ?? (await getPost(target.providerPostId))));
  } else {
    await settleProvider(ctx, target, current);
  }
}
export const run = internalAction({
  args: { id: v.id('socialPostTargets') },
  handler: async (ctx, args) => {
    const target = await ctx.runMutation(internal.social_jobs.claim, args);
    if (!target) return null;
    try {
      await deliver(ctx, target);
    } catch (error) {
      const transient = !(error instanceof ProviderError) || error.retryable;
      const uncertain = target.firstAttemptAt !== undefined || !(error instanceof ProviderError);
      const retrying = transient && (target.attempts < 8 || uncertain || target.operation === 'cancel');
      const delay = Math.max(retryDelay(target.attempts), error instanceof ProviderError ? Math.min(error.retryAfterMs, 60 * 60_000) : 0);
      await ctx.runMutation(internal.social_jobs.settle, {
        id: target._id,
        leaseToken: target.leaseToken ?? '',
        status: retrying ? 'checking' : 'failed',
        error: error instanceof Error ? error.message.slice(0, 400) : 'Could not check posting status',
        ...(retrying ? { dueAt: Date.now() + delay } : {}),
      });
    }
    return null;
  },
});
export const sweep = internalAction({
  args: {},
  handler: async (ctx) => {
    const ids = await ctx.runQuery(internal.social_jobs.due, {});
    for (const id of ids) await ctx.scheduler.runAfter(0, internal.social_dispatch.run, { id });
    return null;
  },
});
