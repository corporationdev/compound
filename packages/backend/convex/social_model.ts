import { v } from 'convex/values';

/**
 * Platforms Compound lets a user connect. The values are Zernio's own slugs
 * (`/connect/{platform}` and the `platform` field on accounts), so X is
 * `twitter` on the wire even though the UI says X.
 */
export const SOCIAL_PLATFORMS = [
  'instagram',
  'tiktok',
  'youtube',
  'twitter',
  'linkedin',
  'facebook',
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const socialPlatform = v.union(...SOCIAL_PLATFORMS.map((p) => v.literal(p)));
export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}
export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  twitter: 'X',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
};
/** The desktop deep link the OAuth callback page returns to. Focus only; the connection is already saved by then. */
export const SOCIAL_RETURN_SCHEME = 'compound:';
export const SOCIAL_RETURN_HOST = 'social-connected';

// ---------------------------------------------------------------------------
// Posts

export const socialMediaKind = v.union(v.literal('video'), v.literal('cover'));
/** The cover: a frame of the video by offset, an uploaded image, or the platform's default. */
export const socialCover = v.union(
  v.null(),
  v.object({ offsetMs: v.number() }),
  v.object({ mediaId: v.id('socialMedia') }),
);
export const SOCIAL_STATUSES = [
  'draft',
  'uploading',
  'queued',
  'submitting',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'partial',
  'checking',
  'cancelling',
  'cancelled',
] as const;
export type SocialStatus = (typeof SOCIAL_STATUSES)[number];
export const socialStatus = v.union(...SOCIAL_STATUSES.map((s) => v.literal(s)));
export const socialOperation = v.union(
  v.literal('create'),
  v.literal('update'),
  v.literal('cancel'),
  v.literal('retry'),
  v.literal('poll'),
);
/** What a target delivers: frozen at submit so later draft edits never leak into a live schedule. */
export const socialSnapshot = v.object({
  caption: v.string(),
  title: v.optional(v.string()),
  cover: socialCover,
  mediaId: v.id('socialMedia'),
  scheduledFor: v.union(v.null(), v.number()),
  timezone: v.string(),
});
export const MAX_SOCIAL_BYTES = 300 * 1024 * 1024;
export const MAX_CAPTION_LENGTH = 2200;
export const MAX_TITLE_LENGTH = 100;
export const MAX_TARGETS = 10;
export const LEASE_MS = 180_000;
export const REQUEST_WINDOW_MS = 4 * 60_000;
export const MAX_POSTS_LISTED = 200;
/** Statuses that mean a target still has work or attention pending. */
export const PENDING_STATUSES: readonly SocialStatus[] = [
  'uploading',
  'queued',
  'submitting',
  'scheduled',
  'publishing',
  'failed',
  'partial',
  'checking',
  'cancelling',
];

export function aggregateSocialStatus(statuses: SocialStatus[]): SocialStatus {
  if (!statuses.length) return 'draft';
  if (statuses.every((s) => s === 'cancelled')) return 'cancelled';
  if (statuses.every((s) => s === 'published' || s === 'cancelled')) return 'published';
  if (statuses.some((s) => s === 'cancelling')) return 'cancelling';
  if (statuses.some((s) => s === 'checking')) return 'checking';
  if (statuses.some((s) => s === 'uploading')) return 'uploading';
  if (statuses.some((s) => s === 'submitting' || s === 'queued')) return 'submitting';
  if (statuses.some((s) => s === 'publishing')) return 'publishing';
  if (statuses.every((s) => s === 'scheduled')) return 'scheduled';
  if (statuses.some((s) => s === 'failed'))
    return statuses.every((s) => s === 'failed' || s === 'cancelled') ? 'failed' : 'partial';
  return 'partial';
}
export function validatePostText(caption: string, title?: string): void {
  if ([...caption].length > MAX_CAPTION_LENGTH)
    throw new Error(`Caption must be ${MAX_CAPTION_LENGTH} characters or fewer.`);
  if (title !== undefined && [...title].length > MAX_TITLE_LENGTH)
    throw new Error(`Title must be ${MAX_TITLE_LENGTH} characters or fewer.`);
}
export function validateSchedule(scheduledFor: number | null, timezone: string, now: number): void {
  if (scheduledFor !== null && (!Number.isFinite(scheduledFor) || scheduledFor < now + 60_000))
    throw new Error('Choose a scheduled time at least one minute in the future.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(now);
  } catch {
    throw new Error('Choose a valid timezone.');
  }
}
export function retryDelay(attempt: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5));
}
