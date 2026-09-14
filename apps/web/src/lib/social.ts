/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { api } from '@compound/backend/convex/_generated/api';
import {
  MAX_CAPTION_LENGTH,
  MAX_TITLE_LENGTH,
  SOCIAL_PLATFORMS,
  SOCIAL_PLATFORM_LABELS,
  SOCIAL_RETURN_HOST,
  SOCIAL_RETURN_SCHEME,
  type SocialPlatform,
  type SocialStatus,
} from '@compound/backend/convex/social_model';
import { MAIN_CHANNELS } from '@desktop/main-channels';

import { convex, getToken, requireBrowserConfig } from './auth-client';
import { mainBridge } from './ipc';
import { uploadToCloud, type UploadProgress } from './upload';

import type { PresentedPost } from '@compound/backend/convex/social_posts';
import type { Id } from '@compound/backend/convex/_generated/dataModel';
import type { FunctionArgs } from 'convex/server';

export { MAX_CAPTION_LENGTH, MAX_TITLE_LENGTH, SOCIAL_PLATFORMS, SOCIAL_PLATFORM_LABELS };
export type { SocialPlatform, SocialStatus, PresentedPost };
export type { UploadProgress };
export type SocialPost = PresentedPost;
export type SocialTarget = PresentedPost['targets'][number];

export const socialAccountsQuery = api.social_connections.list;
export const socialPostsQuery = api.social_posts.list;
export const socialPostQuery = api.social_posts.get;
export type SocialAccount = {
  id: Id<'socialAccounts'>;
  platform: SocialPlatform;
  username: string;
  avatarUrl: string | null;
  updatedAt: number;
};

/** Icon file under `assets/icons` for a platform; X keeps Zernio's `twitter` slug on the wire only. */
export function socialPlatformIcon(platform: SocialPlatform): string {
  return `social.${platform === 'twitter' ? 'x' : platform}`;
}

/** The desktop deep link the callback page returns to once the connection is saved. */
export const SOCIAL_RETURN_URL = `${SOCIAL_RETURN_SCHEME}//${SOCIAL_RETURN_HOST}`;

function returnUrl(): string {
  if (window.desktop) return SOCIAL_RETURN_URL;
  return new URL('/?dashboard=settings', window.location.origin).toString();
}
function client() {
  if (!window.desktop) requireBrowserConfig();
  if (!convex) throw new Error('Cloud is not configured.');
  return convex;
}

// ---------------------------------------------------------------------------
// Connections

/**
 * Start connecting an account: the backend registers a single-use attempt
 * and returns the provider's sign-in URL, which opens in the system browser.
 * Completion is observed through the accounts query, never through the
 * return trip, so a closed browser tab or a missing protocol handler cannot
 * lose the connection.
 */
export async function connectSocialAccount(platform: SocialPlatform): Promise<void> {
  const { url } = await client().action(api.social_connections.connect, { platform, returnUrl: returnUrl() });
  if (window.desktop) await mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url });
  else window.location.assign(url);
}
export async function disconnectSocialAccount(accountId: Id<'socialAccounts'>): Promise<void> {
  await client().action(api.social_connections.disconnect, { accountId });
}
export async function refreshSocialAccounts(): Promise<void> {
  await client().action(api.social_connections.refresh, {});
}

// ---------------------------------------------------------------------------
// Posts

export const systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export type CreatePostInput = Omit<FunctionArgs<typeof api.social_posts.create>, 'timezone'>;
export async function createPost(input: CreatePostInput = {}): Promise<Id<'socialPosts'>> {
  return await client().mutation(api.social_posts.create, { ...input, timezone: systemTimezone() });
}
/** The one open draft for a scene: reused when it exists, created when not. */
export async function openDraft(input: { projectId: string; sceneId: string; projectName?: string }): Promise<{ postId: Id<'socialPosts'>; created: boolean }> {
  return await client().mutation(api.social_posts.openDraft, { ...input, timezone: systemTimezone() });
}
export async function readPost(postId: Id<'socialPosts'>): Promise<SocialPost | null> {
  return await client().query(api.social_posts.get, { postId });
}
/** Delete the draft if nothing was ever put into it. */
export async function removePostIfEmpty(postId: Id<'socialPosts'>): Promise<boolean> {
  return await client().mutation(api.social_posts.removeIfEmpty, { postId });
}
export async function pruneEmptyDrafts(): Promise<number> {
  return await client().mutation(api.social_posts.pruneEmptyDrafts, {});
}
export type SavePostInput = Omit<FunctionArgs<typeof api.social_posts.save>, 'postId'>;
export async function savePost(postId: Id<'socialPosts'>, input: SavePostInput): Promise<number> {
  return await client().mutation(api.social_posts.save, { postId, ...input });
}
export async function submitPost(postId: Id<'socialPosts'>, expectedVersion: number): Promise<void> {
  await client().mutation(api.social_posts.submit, { postId, expectedVersion });
}
export async function cancelPost(postId: Id<'socialPosts'>): Promise<void> {
  await client().mutation(api.social_posts.cancel, { postId });
}
export async function retryTarget(targetId: Id<'socialPostTargets'>): Promise<void> {
  await client().mutation(api.social_posts.retry, { targetId });
}
export async function removePost(postId: Id<'socialPosts'>): Promise<void> {
  await client().mutation(api.social_posts.remove, { postId });
}

// ---------------------------------------------------------------------------
// Media

export type PostMediaMeta = {
  durationMs?: number;
  width?: number;
  height?: number;
  projectId?: string;
  projectName?: string;
  sceneId?: string;
  /** Render-input hash; a ready upload with the same hash is reused instead of uploading again. */
  contentHash?: string;
};
/** A ready video already uploaded from identical render inputs, if any. */
export async function findMediaByHash(contentHash: string): Promise<Id<'socialMedia'> | null> {
  const found = await client().query(api.social_media.findByHash, { contentHash, kind: 'video' });
  return found?.id ?? null;
}

async function socialRequest<T>(operation: 'media-url', body: Record<string, unknown>): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error('Sign in required');
  // The packaged desktop renderer has no browser origin the Worker accepts; main makes the call.
  if (window.desktop) return (await mainBridge.call(MAIN_CHANNELS.CLOUD_MEDIA, { path: `/social/${operation}`, body, token })) as T;
  const server = import.meta.env.VITE_SERVER_URL;
  if (!server) throw new Error('Media service is not configured');
  const response = await fetch(`${server}/social/${operation}`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((result as { error?: string }).error ?? 'Post media request failed');
  return result as T;
}

/**
 * Upload a post video from a file on disk (desktop) or a chosen File
 * (browser). Returns once the Worker has verified and marked the media ready.
 */
export async function uploadPostVideo(
  source: { path: string } | { file: File },
  meta: PostMediaMeta,
  options: { onProgress?: (progress: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<Id<'socialMedia'>> {
  if ('file' in source && source.file.type !== 'video/mp4') throw new Error('Choose an MP4 video.');
  const id = await uploadToCloud(
    { purpose: 'social', kind: 'video', contentType: 'video/mp4', ...meta },
    'path' in source ? { path: source.path } : { blob: source.file },
    options,
  );
  return id as Id<'socialMedia'>;
}
/** A short-lived signed URL for previewing an uploaded post video or cover. */
export async function postMediaUrl(mediaId: Id<'socialMedia'>): Promise<string> {
  return (await socialRequest<{ url: string }>('media-url', { mediaId })).url;
}
export async function pickVideoFile(): Promise<{ path: string; name: string } | null> {
  return await mainBridge.call(MAIN_CHANNELS.SOCIAL_PICK_VIDEO, undefined);
}
/** Duration and frame size of a local or remote MP4, read from the browser's decoder. */
export function probeVideo(src: string): Promise<{ durationMs: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      resolve({ durationMs: Math.round(video.duration * 1000), width: video.videoWidth, height: video.videoHeight });
      video.src = '';
    };
    video.onerror = () => reject(new Error('Could not read the video'));
    video.src = src;
  });
}

// ---------------------------------------------------------------------------
// Presentation

export const STATUS_LABELS: Record<SocialStatus, string> = {
  draft: 'Draft',
  uploading: 'Uploading',
  queued: 'Queued',
  submitting: 'Submitting',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Failed',
  partial: 'Partly failed',
  checking: 'Checking',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled',
};
export type StatusTone = 'neutral' | 'active' | 'success' | 'danger';
export function statusTone(status: SocialStatus): StatusTone {
  switch (status) {
    case 'published':
      return 'success';
    case 'failed':
    case 'partial':
      return 'danger';
    case 'draft':
    case 'cancelled':
      return 'neutral';
    default:
      return 'active';
  }
}
/** Posts tab grouping: attention first, then what is coming, then what is done. */
export type PostSection = 'attention' | 'upcoming' | 'progress' | 'published' | 'drafts';
export function postSection(post: SocialPost): PostSection {
  switch (post.status) {
    case 'failed':
    case 'partial':
    case 'checking':
      return 'attention';
    case 'scheduled':
      return 'upcoming';
    case 'uploading':
    case 'queued':
    case 'submitting':
    case 'publishing':
    case 'cancelling':
      return 'progress';
    case 'published':
      return 'published';
    default:
      return 'drafts';
  }
}
export function formatPostTime(instant: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(instant);
  } catch {
    return new Date(instant).toLocaleString();
  }
}
/** The value a `datetime-local` input shows for an instant in a zone, and back. */
export function toLocalInputValue(instant: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
}
export function fromLocalInputValue(value: string, timezone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as number[];
  // Find the UTC instant whose wall-clock time in `timezone` matches: start
  // from the naive UTC guess and correct by the zone's offset at that guess.
  let guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  for (let i = 0; i < 2; i++) {
    const shown = toLocalInputValue(guess, timezone);
    const [sy, smo, sd, sh, smi] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(shown)!.slice(1).map(Number) as number[];
    const shownUtc = Date.UTC(sy!, smo! - 1, sd!, sh!, smi!);
    guess += Date.UTC(y!, mo! - 1, d!, h!, mi!) - shownUtc;
  }
  return guess;
}
