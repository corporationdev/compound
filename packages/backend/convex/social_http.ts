import { ConvexError } from 'convex/values';
import { internal } from './_generated/api';
import { httpAction } from './_generated/server';
import { SOCIAL_PLATFORM_LABELS, isSocialPlatform } from './social_model';
import { record, string } from './social_provider';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
/**
 * The page the browser lands on after the provider redirect. The connection
 * is already saved by the time it renders, so the app's live query has the
 * new account whether or not the user follows the return link. The
 * `returnUrl` (desktop deep link or our own site) only brings the app back
 * to the front.
 */
export function callbackPage(input: { ok: true; platform: string; username: string; returnUrl?: string } | { ok: false; message: string }): string {
  const platform = input.ok && isSocialPlatform(input.platform) ? SOCIAL_PLATFORM_LABELS[input.platform] : input.ok ? input.platform : '';
  const title = input.ok ? 'Connected' : 'Connection failed';
  const body = input.ok
    ? `<strong>@${escapeHtml(input.username)}</strong> on ${escapeHtml(platform)} is connected to Compound.`
    : escapeHtml(input.message);
  const returnUrl = input.ok ? input.returnUrl : undefined;
  const refresh = returnUrl ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(returnUrl)}">` : '';
  const action = returnUrl
    ? `<a class="button" href="${escapeHtml(returnUrl)}">Return to Compound</a><p class="hint">Returning automatically… You can close this tab.</p>`
    : `<p class="hint">${input.ok ? 'You can close this tab and return to Compound.' : 'Return to Compound and try again from Settings.'}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh}
<title>${title} · Compound</title>
<style>
  html { background: #0f0f0f; color: #f5f5f4; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { max-width: 26rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.4rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0 0 1.25rem; color: #d4d4d4; }
  .hint { color: #8a8a8a; font-size: 0.85rem; margin-top: 1rem; }
  .button { display: inline-block; padding: 0.6rem 1.1rem; border-radius: 0.5rem; background: #f5f5f4; color: #0f0f0f; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>${body}</p>
  ${action}
</main>
</body>
</html>`;
}
export const callback = httpAction(async (ctx, request) => {
  const params = new URL(request.url).searchParams;
  const state = params.get('state');
  let page: string;
  try {
    if (!state || params.get('error')) throw new Error('Connection was cancelled. Try again from Settings.');
    const result = await ctx.runAction(internal.social_connections.complete, {
      state,
      accountId: params.get('accountId') ?? undefined,
      profileId: params.get('profileId') ?? undefined,
    });
    let returnUrl = result.returnUrl;
    if (returnUrl) {
      const url = new URL(returnUrl);
      url.searchParams.set('platform', result.platform);
      url.searchParams.set('username', result.username);
      returnUrl = url.toString();
    }
    page = callbackPage({ ok: true, platform: result.platform, username: result.username, returnUrl });
  } catch (error) {
    const message =
      error instanceof ConvexError && typeof error.data === 'string'
        ? error.data
        : error instanceof Error
          ? error.message
          : 'Connection failed';
    page = callbackPage({ ok: false, message: message.slice(0, 300) });
  }
  return new Response(page, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Referrer-Policy': 'no-referrer',
    },
  });
});

const HEX_SIGNATURE = /^[a-f0-9]{64}$/;
/**
 * Zernio post events. The signature is the lowercase hex HMAC-SHA256 of the
 * raw body. The event's contents are never trusted: it only wakes the
 * matching targets, and dispatch re-fetches live state from Zernio.
 */
export const webhook = httpAction(async (ctx, request) => {
  const signature = (request.headers.get('x-zernio-signature') ?? '').toLowerCase();
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  if (!(secret && HEX_SIGNATURE.test(signature))) return new Response('Unauthorized', { status: 401 });
  if (Number(request.headers.get('content-length') ?? 0) > 256_000) return new Response('Too large', { status: 413 });
  const raw = await request.text();
  const bytes = new TextEncoder().encode(raw);
  if (bytes.byteLength > 256_000) return new Response('Too large', { status: 413 });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sig = Uint8Array.from(signature.match(/.{2}/g) ?? [], (hex) => Number.parseInt(hex, 16));
  if (!(await crypto.subtle.verify('HMAC', key, sig, bytes))) return new Response('Unauthorized', { status: 401 });
  let event: Record<string, unknown>;
  try {
    event = record(JSON.parse(raw));
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  const eventId = string(event.id) ?? string(request.headers.get('x-zernio-event-id'));
  if (!eventId) return new Response('Missing event ID', { status: 400 });
  const post = record(event.post ?? record(event.data).post);
  const providerPostId = string(post._id) ?? string(post.id) ?? string(event.postId) ?? string(record(event.data).postId);
  if (providerPostId) await ctx.runMutation(internal.social_jobs.recordEvent, { eventId, providerPostId });
  return Response.json({ accepted: true });
});
