import { api } from '@compound/backend/convex/_generated/api';
import type { Id } from '@compound/backend/convex/_generated/dataModel';
import { ConvexHttpClient } from 'convex/browser';
import { z } from 'zod';

// Social posting media: the Worker owns R2 signing, Convex owns the rows.
// Uploads go through `/upload/*` (see upload.ts) into `social/<id>`, outside
// the 24h `media/` lifecycle; Zernio reads through a capability URL that
// redirects to a short-lived signed GET.

export const SOCIAL_OPERATIONS = ['media-url'] as const;
export type SocialOperation = (typeof SOCIAL_OPERATIONS)[number];

const mediaIdSchema = z.object({ mediaId: z.string().min(1).max(100) }).strict();

export class SocialError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export type SocialEnv = { MEDIA: R2Bucket; CONVEX_URL: string };
/** A signed, short-lived GET for an object key. */
export type Signer = (key: string) => Promise<string>;

/** `media-url`: an owner preview of a ready object. */
export async function socialRequest(client: ConvexHttpClient, sign: Signer, operation: SocialOperation, body: unknown): Promise<unknown> {
  if (operation !== 'media-url') throw new SocialError(404, 'Unknown operation');
  const { mediaId } = mediaIdSchema.parse(body);
  const media = await client.query(api.social_media.get, { id: mediaId as Id<'socialMedia'> });
  if (!media.ready) throw new SocialError(409, 'Media is not ready yet');
  return { url: await sign(media.key), contentType: media.contentType };
}

/**
 * `GET|HEAD /social/media/:targetId/:kind?token=` — what Zernio fetches. No
 * session: the token is the credential, checked by a public Convex query.
 * Redirects to a signed R2 URL so Range requests and HEAD land on R2 itself.
 */
export async function socialMediaResponse(env: SocialEnv, sign: Signer, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const [, , , targetId, kind] = url.pathname.split('/');
  const token = url.searchParams.get('token');
  const headers = { 'Cache-Control': 'no-store' };
  if (!targetId || !token || (kind !== 'video' && kind !== 'cover') || !/^[a-f0-9-]{36}$/.test(token))
    return new Response('Not found', { status: 404, headers });
  try {
    const client = new ConvexHttpClient(env.CONVEX_URL);
    const media = await client.query(api.social_media.resolve, { targetId, token, kind });
    if (!media) return new Response('Not found', { status: 404, headers });
    const object = await env.MEDIA.head(media.key);
    if (!object) return new Response('Not found', { status: 404, headers });
    return new Response(null, { status: 307, headers: { ...headers, Location: await sign(media.key) } });
  } catch {
    return new Response('Media temporarily unavailable', { status: 503, headers: { ...headers, 'Retry-After': '30' } });
  }
}
