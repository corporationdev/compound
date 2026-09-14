import { test, expect, beforeEach, afterAll, jest } from 'bun:test';
import { convexTest } from 'convex-test';
import { resolve, dirname } from 'node:path';
import schema from '../convex/schema';
import { api, internal, components } from '../convex/_generated/api';

const componentDir = resolve(
  dirname(import.meta.resolve('@convex-dev/better-auth/package.json').replace('file://', '')),
  'src/component',
);
const componentSchema = (await import(`${componentDir}/schema.ts`)).default;
function modules(dir: string) {
  return Object.fromEntries(
    [...new Bun.Glob('**/*.ts').scanSync(dir)].map((path) => [`${dir}/${path}`, () => import(`${dir}/${path}`)]),
  );
}
function setup() {
  const t = convexTest(schema, modules(resolve(import.meta.dirname, '../convex')));
  t.registerComponent('betterAuth', componentSchema, modules(componentDir));
  return t;
}
async function identity(t: ReturnType<typeof setup>, email: string) {
  const now = Date.now();
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: { model: 'user', data: { name: 'Test', email, emailVerified: true, createdAt: now, updatedAt: now } },
  });
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'session',
      data: { userId: user!._id, token: crypto.randomUUID(), expiresAt: now + 86_400_000, createdAt: now, updatedAt: now },
    },
  });
  return { user: user!, authenticated: t.withIdentity({ subject: user!._id, sessionId: session!._id }) };
}

// A fake Zernio posts API that remembers what it was sent.
type Call = { method: string; url: URL; body?: Record<string, unknown>; headers: Headers };
let calls: Call[] = [];
let providerPosts: Record<string, Record<string, unknown>> = {};
let nextStatus = 'published';
let createFailure: { status: number; body: Record<string, unknown> } | null = null;
const originalFetch = globalThis.fetch;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
beforeEach(() => {
  jest.useFakeTimers();
  process.env.ZERNIO_API_KEY = 'zernio-test-key';
  process.env.ZERNIO_WEBHOOK_SECRET = 'whsec';
  process.env.CONVEX_SITE_URL = 'https://test.convex.site';
  process.env.SERVER_URL = 'https://server.example';
  process.env.SITE_URL = 'http://localhost:5173';
  calls = [];
  providerPosts = {};
  nextStatus = 'published';
  createFailure = null;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url, headers, body });
    if (url.pathname.endsWith('/tiktok/creator-info'))
      return json({ privacyLevels: [{ value: 'PUBLIC_TO_EVERYONE' }], postingLimits: { interactionSettings: { allow_comment: { enabled: true } } } });
    if (url.pathname === '/api/v1/posts' && method === 'POST') {
      if (createFailure) return json(createFailure.body, createFailure.status);
      const id = `zp_${Object.keys(providerPosts).length + 1}`;
      const platform = (body!.platforms as Record<string, unknown>[])[0]!;
      providerPosts[id] = {
        _id: id,
        content: body!.content,
        mediaItems: body!.mediaItems,
        status: nextStatus,
        platforms: [{ ...platform, status: nextStatus, platformPostUrl: nextStatus === 'published' ? `https://platform.example/${id}` : undefined }],
      };
      return json({ post: providerPosts[id] });
    }
    const single = /^\/api\/v1\/posts\/([^/]+)$/.exec(url.pathname);
    if (single && method === 'GET') return providerPosts[single[1]!] ? json({ post: providerPosts[single[1]!] }) : json({ error: 'nf' }, 404);
    if (single && method === 'DELETE') {
      delete providerPosts[single[1]!];
      return json({ ok: true });
    }
    if (url.pathname === '/api/v1/posts' && method === 'GET') return json({ posts: Object.values(providerPosts) });
    return json({ error: `Unexpected ${method} ${url.pathname}` }, 500);
  }) as typeof fetch;
});
afterAll(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
});

async function connectedAccount(t: ReturnType<typeof setup>, ownerId: string, platform: 'instagram' | 'tiktok' | 'youtube' = 'instagram') {
  await t.mutation(internal.social_connections.syncRows, {
    ownerId,
    profileId: 'prof_1',
    accounts: [{ providerId: `acc_${platform}`, platform, username: `me_${platform}`, active: true }],
  });
  const accounts = await t.withIdentity({ subject: ownerId }).query(api.social_connections.list, {});
  return accounts.find((a) => a.platform === platform)!;
}
async function readyVideo(_t: ReturnType<typeof setup>, owner: Awaited<ReturnType<typeof identity>>) {
  const media = await owner.authenticated.mutation(api.social_media.create, {
    kind: 'video',
    contentType: 'video/mp4',
    size: 1234,
    durationMs: 15_000,
    projectName: 'Demo',
  });
  expect(media.key).toBe(`social/${media._id}`);
  await owner.authenticated.mutation(api.social_media.markReady, { id: media._id, sha256: 'a'.repeat(64) });
  return media;
}
const drain = (t: ReturnType<typeof setup>) => t.finishAllScheduledFunctions(() => jest.advanceTimersByTime(1000));

test('post now: draft → submit → dispatch → published, with the media capability URL', async () => {
  const t = setup();
  const alice = await identity(t, 'alice@example.com');
  const bob = await identity(t, 'bob@example.com');
  const instagram = await connectedAccount(t, alice.user._id, 'instagram');
  const youtube = await connectedAccount(t, alice.user._id, 'youtube');
  const media = await readyVideo(t, alice);

  const postId = await alice.authenticated.mutation(api.social_posts.create, { timezone: 'America/Los_Angeles', projectName: 'Demo', sceneId: 'main' });
  expect(await alice.authenticated.mutation(api.social_posts.save, { postId, caption: 'Hello world\nsecond line', accountIds: [instagram.id, youtube.id], mediaId: media._id })).toBe(1);
  await expect(bob.authenticated.mutation(api.social_posts.save, { postId, caption: 'x' })).rejects.toThrow('not found');
  await expect(alice.authenticated.mutation(api.social_posts.save, { postId, caption: 'x'.repeat(2201) })).rejects.toThrow('2200');
  await expect(alice.authenticated.mutation(api.social_posts.submit, { postId, expectedVersion: 0 })).rejects.toThrow('changed');

  await alice.authenticated.mutation(api.social_posts.submit, { postId, expectedVersion: 1 });
  let post = (await alice.authenticated.query(api.social_posts.get, { postId }))!;
  expect(post.status).toBe('submitting');
  expect(post.targets.map((x) => x.platform).sort()).toEqual(['instagram', 'youtube']);

  await drain(t);
  post = (await alice.authenticated.query(api.social_posts.get, { postId }))!;
  expect(post.status).toBe('published');
  expect(post.targets.every((x) => x.status === 'published' && x.postUrl?.startsWith('https://platform.example/'))).toBe(true);

  // One Zernio post per target, idempotent request id, media through the Worker capability URL.
  const creates = calls.filter((c) => c.method === 'POST' && c.url.pathname === '/api/v1/posts');
  expect(creates).toHaveLength(2);
  for (const c of creates) {
    expect(c.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.body!.publishNow).toBe(true);
    expect(c.body!.timezone).toBe('America/Los_Angeles');
    const url = new URL((c.body!.mediaItems as { url: string }[])[0]!.url);
    expect(url.origin).toBe('https://server.example');
    expect(url.pathname).toMatch(/^\/social\/media\/[a-z0-9]+\/video$/);
    // The capability resolves to the R2 key for exactly this token.
    const targetId = url.pathname.split('/')[3]!;
    const resolved = await t.query(api.social_media.resolve, { targetId, token: url.searchParams.get('token')!, kind: 'video' });
    expect(resolved).toEqual({ key: media.key, contentType: 'video/mp4', size: 1234 });
    expect(await t.query(api.social_media.resolve, { targetId, token: 'wrong', kind: 'video' })).toBeNull();
    expect(await t.query(api.social_media.resolve, { targetId: 'garbage', token: 'x', kind: 'video' })).toBeNull();
  }
  const yt = creates.find((c) => (c.body!.platforms as { platform: string }[])[0]!.platform === 'youtube')!;
  expect((yt.body!.platforms as { platformSpecificData: { title: string } }[])[0]!.platformSpecificData.title).toBe('Hello world');
  const ig = creates.find((c) => (c.body!.platforms as { platform: string }[])[0]!.platform === 'instagram')!;
  expect((ig.body!.platforms as { platformSpecificData: unknown }[])[0]!.platformSpecificData).toEqual({ shareToFeed: true, thumbOffset: 0 });

  // Finished posts are read-only, listed, and deletable.
  await expect(alice.authenticated.mutation(api.social_posts.save, { postId, caption: 'late edit' })).rejects.toThrow('finished');
  expect((await alice.authenticated.query(api.social_posts.list, {})).map((p) => p.id)).toEqual([postId]);
  expect(await bob.authenticated.query(api.social_posts.list, {})).toEqual([]);
  await alice.authenticated.mutation(api.social_posts.remove, { postId });
  expect(await alice.authenticated.query(api.social_posts.list, {})).toEqual([]);
});

test('scheduling: Zernio holds the schedule, cancel confirms with the provider, disconnect is blocked meanwhile', async () => {
  const t = setup();
  const alice = await identity(t, 'alice@example.com');
  const tiktok = await connectedAccount(t, alice.user._id, 'tiktok');
  const media = await readyVideo(t, alice);
  nextStatus = 'scheduled';
  const when = Date.now() + 2 * 60 * 60_000;
  const postId = await alice.authenticated.mutation(api.social_posts.create, { timezone: 'UTC' });
  await expect(alice.authenticated.mutation(api.social_posts.save, { postId, scheduledFor: when, timezone: 'Mars/Olympus' })).rejects.toThrow('timezone');
  const version = await alice.authenticated.mutation(api.social_posts.save, { postId, caption: 'Soon', accountIds: [tiktok.id], mediaId: media._id, scheduledFor: when, cover: { offsetMs: 2500 } });
  await alice.authenticated.mutation(api.social_posts.submit, { postId, expectedVersion: version });
  await drain(t);
  let post = (await alice.authenticated.query(api.social_posts.get, { postId }))!;
  expect(post.status).toBe('scheduled');
  const create = calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/v1/posts')!;
  expect(create.body!.scheduledFor).toBe(new Date(when).toISOString());
  expect((create.body!.tiktokSettings as Record<string, unknown>).video_cover_timestamp_ms).toBe(2500);
  expect((create.body!.tiktokSettings as Record<string, unknown>).privacy_level).toBe('PUBLIC_TO_EVERYONE');

  await expect(alice.authenticated.action(api.social_connections.disconnect, { accountId: tiktok.id })).rejects.toThrow('pending');

  await alice.authenticated.mutation(api.social_posts.cancel, { postId });
  await drain(t);
  post = (await alice.authenticated.query(api.social_posts.get, { postId }))!;
  expect(post.status).toBe('cancelled');
  expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/api/v1/posts/zp_1')).toBe(true);
  // A cancelled post can be edited and submitted again.
  expect(post.version).toBeGreaterThan(version);
  await alice.authenticated.mutation(api.social_posts.save, { postId, scheduledFor: null });
  await alice.authenticated.action(api.social_connections.disconnect, { accountId: tiktok.id });
});

test('a missed schedule fails rather than posting late; a rejected create fails without a retry loop', async () => {
  const t = setup();
  const alice = await identity(t, 'alice@example.com');
  const instagram = await connectedAccount(t, alice.user._id, 'instagram');
  const media = await readyVideo(t, alice);

  const postId = await alice.authenticated.mutation(api.social_posts.create, { timezone: 'UTC' });
  const when = Date.now() + 90_000;
  const version = await alice.authenticated.mutation(api.social_posts.save, { postId, caption: 'late', accountIds: [instagram.id], mediaId: media._id, scheduledFor: when });
  await alice.authenticated.mutation(api.social_posts.submit, { postId, expectedVersion: version });
  // Nothing ran before the instant passed (the app was offline, say).
  jest.setSystemTime(when + 60_000);
  await t.action(internal.social_dispatch.sweep, {});
  await drain(t);
  const post = (await alice.authenticated.query(api.social_posts.get, { postId }))!;
  expect(post.status).toBe('failed');
  expect(post.targets[0]!.error).toContain('not posted late');
  expect(calls.filter((c) => c.method === 'POST' && c.url.pathname === '/api/v1/posts')).toHaveLength(0);

  createFailure = { status: 400, body: { error: 'Caption rejected by platform' } };
  const second = await alice.authenticated.mutation(api.social_posts.create, { timezone: 'UTC' });
  const v2 = await alice.authenticated.mutation(api.social_posts.save, { postId: second, caption: 'bad', accountIds: [instagram.id], mediaId: media._id });
  await alice.authenticated.mutation(api.social_posts.submit, { postId: second, expectedVersion: v2 });
  await drain(t);
  const failed = (await alice.authenticated.query(api.social_posts.get, { postId: second }))!;
  expect(failed.status).toBe('failed');
  expect(failed.targets[0]!.error).toBe('Caption rejected by platform');
  expect(calls.filter((c) => c.method === 'POST' && c.url.pathname === '/api/v1/posts')).toHaveLength(1);

  // Retry re-runs the create once the platform accepts it.
  createFailure = null;
  await alice.authenticated.mutation(api.social_posts.retry, { targetId: failed.targets[0]!.id });
  await drain(t);
  expect((await alice.authenticated.query(api.social_posts.get, { postId: second }))!.status).toBe('published');
});

test('submission waits for the upload, and a duplicate response adopts the original post', async () => {
  const t = setup();
  const alice = await identity(t, 'alice@example.com');
  const instagram = await connectedAccount(t, alice.user._id, 'instagram');
  const media = await alice.authenticated.mutation(api.social_media.create, { kind: 'video', contentType: 'video/mp4', size: 10 });
  const postId = await alice.authenticated.mutation(api.social_posts.create, {});
  const version = await alice.authenticated.mutation(api.social_posts.save, { postId, caption: 'wait', accountIds: [instagram.id], mediaId: media._id });
  await expect(alice.authenticated.mutation(api.social_posts.submit, { postId, expectedVersion: version })).rejects.toThrow('still uploading');
  await alice.authenticated.mutation(api.social_media.markReady, { id: media._id });

  // First create succeeds at Zernio but the response is lost; the retry gets a 409 naming the original.
  let first = true;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/api/v1/posts' && init?.method === 'POST') {
      if (first) {
        first = false;
        await inner(input, init);
        throw new TypeError('network dropped');
      }
      return json({ error: 'duplicate', existingPostId: 'zp_1' }, 409);
    }
    return inner(input, init);
  }) as typeof fetch;
  await alice.authenticated.mutation(api.social_posts.submit, { postId, expectedVersion: version });
  await drain(t);
  const post = (await alice.authenticated.query(api.social_posts.get, { postId }))!;
  expect(post.status).toBe('published');
  expect(Object.keys(providerPosts)).toEqual(['zp_1']);
  const creates = calls.filter((c) => c.method === 'POST' && c.url.pathname === '/api/v1/posts');
  expect(creates).toHaveLength(2);
  expect(creates[0]!.headers.get('x-request-id')).toBe(creates[1]!.headers.get('x-request-id'));
  expect(JSON.stringify(creates[0]!.body)).toBe(JSON.stringify(creates[1]!.body));
});

test('webhook: signature required, events deduplicated, matching targets woken', async () => {
  const t = setup();
  const alice = await identity(t, 'alice@example.com');
  const instagram = await connectedAccount(t, alice.user._id, 'instagram');
  const media = await readyVideo(t, alice);
  nextStatus = 'scheduled';
  const postId = await alice.authenticated.mutation(api.social_posts.create, {});
  const version = await alice.authenticated.mutation(api.social_posts.save, { postId, caption: 'hook', accountIds: [instagram.id], mediaId: media._id, scheduledFor: Date.now() + 3_600_000 });
  await alice.authenticated.mutation(api.social_posts.submit, { postId, expectedVersion: version });
  await drain(t);
  expect((await alice.authenticated.query(api.social_posts.get, { postId }))!.status).toBe('scheduled');

  const body = JSON.stringify({ id: 'evt_1', type: 'post.published', post: { _id: 'zp_1' } });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, '0')).join('');
  expect((await t.fetch('/webhooks/zernio', { method: 'POST', body })).status).toBe(401);
  expect((await t.fetch('/webhooks/zernio', { method: 'POST', body, headers: { 'x-zernio-signature': 'f'.repeat(64) } })).status).toBe(401);

  // Zernio published it; the event only triggers a fresh fetch of live state.
  providerPosts.zp_1!.status = 'published';
  (providerPosts.zp_1!.platforms as Record<string, unknown>[])[0]!.status = 'published';
  const accepted = await t.fetch('/webhooks/zernio', { method: 'POST', body, headers: { 'x-zernio-signature': signature } });
  expect(accepted.status).toBe(200);
  await drain(t);
  expect((await alice.authenticated.query(api.social_posts.get, { postId }))!.status).toBe('published');
  const before = calls.length;
  expect((await t.fetch('/webhooks/zernio', { method: 'POST', body, headers: { 'x-zernio-signature': signature } })).status).toBe(200);
  await drain(t);
  expect(calls.length).toBe(before);
});
