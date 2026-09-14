import { test, expect, beforeEach, afterAll, jest } from 'bun:test';
import { convexTest } from 'convex-test';
import { resolve, dirname } from 'node:path';
import schema from '../convex/schema';
import { api, internal, components } from '../convex/_generated/api';
import { validateReturnUrl } from '../convex/social_connections';
import { callbackPage } from '../convex/social_http';

const componentDir = resolve(
  dirname(import.meta.resolve('@convex-dev/better-auth/package.json').replace('file://', '')),
  'src/component',
);
const componentSchema = (await import(`${componentDir}/schema.ts`)).default;
function modules(dir: string) {
  return Object.fromEntries(
    [...new Bun.Glob('**/*.ts').scanSync(dir)].map((path) => [
      `${dir}/${path}`,
      () => import(`${dir}/${path}`),
    ]),
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
    input: {
      model: 'user',
      data: { name: 'Test', email, emailVerified: true, createdAt: now, updatedAt: now },
    },
  });
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'session',
      data: {
        userId: user!._id,
        token: crypto.randomUUID(),
        expiresAt: now + 60000,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return { user: user!, authenticated: t.withIdentity({ subject: user!._id, sessionId: session!._id }) };
}

// A fake Zernio: records every call and answers with the documented shapes.
const originalFetch = globalThis.fetch;
type Call = { method: string; url: URL; body?: unknown; headers: Headers };
let calls: Call[] = [];
let accounts: Record<string, unknown>[] = [];
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
beforeEach(() => {
  jest.useFakeTimers();
  process.env.ZERNIO_API_KEY = 'zernio-test-key';
  process.env.CONVEX_SITE_URL = 'https://test.convex.site';
  process.env.SITE_URL = 'http://localhost:5173';
  calls = [];
  accounts = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({ method, url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (headers.get('Authorization') !== 'Bearer zernio-test-key') return json({ error: 'Unauthorized' }, 401);
    if (url.pathname === '/api/v1/profiles' && method === 'POST') return json({ profile: { _id: 'prof_1', name: (init!.body as string) } });
    if (url.pathname.startsWith('/api/v1/connect/'))
      return json({ authUrl: `https://provider.example/oauth?platform=${url.pathname.split('/').pop()}` });
    if (url.pathname === '/api/v1/accounts' && method === 'GET') return json({ accounts });
    if (url.pathname.startsWith('/api/v1/accounts/') && method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.split('/').pop()!);
      const before = accounts.length;
      accounts = accounts.filter((a) => a._id !== id);
      return before === accounts.length ? json({ error: 'Not found' }, 404) : json({ ok: true });
    }
    return json({ error: `Unexpected ${method} ${url.pathname}` }, 500);
  }) as typeof fetch;
});
afterAll(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
});

test('connect, callback, live list, replay protection, and disconnect', async () => {
  const t = setup();
  const alice = await identity(t, 'alice@example.com');
  const bob = await identity(t, 'bob@example.com');

  await expect(t.action(api.social_connections.connect, { platform: 'instagram' })).rejects.toThrow();
  await expect(
    alice.authenticated.action(api.social_connections.connect, { platform: 'instagram', returnUrl: 'https://evil.example/' }),
  ).rejects.toThrow('not allowed');

  const { url } = await alice.authenticated.action(api.social_connections.connect, {
    platform: 'instagram',
    returnUrl: 'compound://social-connected',
  });
  expect(url).toBe('https://provider.example/oauth?platform=instagram');
  // One profile per user, named after the Compound user.
  const profile = calls.find((c) => c.url.pathname === '/api/v1/profiles')!;
  expect((profile.body as { name: string }).name).toBe(`Compound ${alice.user._id}`);
  const connect = calls.find((c) => c.url.pathname === '/api/v1/connect/instagram')!;
  expect(connect.url.searchParams.get('profileId')).toBe('prof_1');
  const redirect = new URL(connect.url.searchParams.get('redirect_url')!);
  expect(redirect.origin + redirect.pathname).toBe('https://test.convex.site/social/callback');
  const state = redirect.searchParams.get('state')!;
  expect(state.length).toBeGreaterThan(60);

  // Nothing is connected until the provider redirects back.
  expect(await alice.authenticated.query(api.social_connections.list, {})).toEqual([]);

  accounts = [
    { _id: 'acc_1', platform: 'instagram', username: 'isaac', profilePicture: 'https://cdn.example/a.jpg', isActive: true, profileId: 'prof_1' },
    { _id: 'acc_other', platform: 'pinterest', username: 'unsupported', isActive: true, profileId: 'prof_1' },
  ];
  const response = await t.fetch(`/social/callback?state=${state}&connected=instagram&profileId=prof_1&accountId=acc_1&username=isaac`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  const page = await response.text();
  expect(page).toContain('@isaac');
  expect(page).toContain('content="1;url=compound://social-connected?platform=instagram&#38;username=isaac"');

  // The account is visible through the query with no return trip needed; unsupported platforms are ignored.
  const list = await alice.authenticated.query(api.social_connections.list, {});
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ platform: 'instagram', username: 'isaac', avatarUrl: 'https://cdn.example/a.jpg' });
  expect(await bob.authenticated.query(api.social_connections.list, {})).toEqual([]);
  expect(await t.query(api.social_connections.list, {})).toEqual([]);

  // A state is single use.
  const replay = await (await t.fetch(`/social/callback?state=${state}&accountId=acc_1`)).text();
  expect(replay).toContain('Connection failed');
  expect(replay).toContain('expired');
  // A second connect reuses the profile.
  await alice.authenticated.action(api.social_connections.connect, { platform: 'tiktok' });
  expect(calls.filter((c) => c.url.pathname === '/api/v1/profiles')).toHaveLength(1);

  // Refresh drops accounts the provider no longer lists.
  accounts = [];
  await alice.authenticated.action(api.social_connections.refresh, {});
  expect(await alice.authenticated.query(api.social_connections.list, {})).toEqual([]);
  accounts = [{ _id: 'acc_1', platform: 'instagram', username: 'isaac', isActive: true }];
  await alice.authenticated.action(api.social_connections.refresh, {});
  const again = await alice.authenticated.query(api.social_connections.list, {});
  expect(again).toHaveLength(1);

  // Disconnect belongs to the owner and detaches at the provider.
  await expect(bob.authenticated.action(api.social_connections.disconnect, { accountId: again[0]!.id })).rejects.toThrow('not found');
  await alice.authenticated.action(api.social_connections.disconnect, { accountId: again[0]!.id });
  expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/api/v1/accounts/acc_1')).toBe(true);
  expect(await alice.authenticated.query(api.social_connections.list, {})).toEqual([]);

  // Account deletion removes every row and schedules provider cleanup.
  accounts = [{ _id: 'acc_2', platform: 'youtube', username: 'chan', isActive: true }];
  await alice.authenticated.action(api.social_connections.refresh, {});
  await t.mutation(internal.social_connections.removeForUser, { ownerId: alice.user._id });
  await t.finishAllScheduledFunctions(() => jest.advanceTimersByTime(100));
  expect(await alice.authenticated.query(api.social_connections.list, {})).toEqual([]);
  expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/api/v1/accounts/acc_2')).toBe(true);
  await t.run(async (ctx) => {
    expect(await ctx.db.query('socialProfiles').collect()).toEqual([]);
    expect(await ctx.db.query('socialConnections').collect()).toEqual([]);
  });
});

test('callback failures render a page instead of redirecting', async () => {
  const t = setup();
  const cancelled = await (await t.fetch('/social/callback?error=access_denied')).text();
  expect(cancelled).toContain('cancelled');
  expect(cancelled).not.toContain('http-equiv="refresh"');
  const unknown = await (await t.fetch('/social/callback?state=nope')).text();
  expect(unknown).toContain('expired');
});

test('return URLs are limited to the desktop deep link and our own site', () => {
  process.env.SITE_URL = 'https://app.compound.example';
  expect(validateReturnUrl(undefined)).toBeUndefined();
  expect(validateReturnUrl('compound://social-connected')).toBe('compound://social-connected');
  expect(validateReturnUrl('https://app.compound.example/?dashboard=settings')).toBe('https://app.compound.example/?dashboard=settings');
  expect(() => validateReturnUrl('compound://evil')).toThrow('not allowed');
  expect(() => validateReturnUrl('https://app.compound.example.evil.com/')).toThrow('not allowed');
  expect(() => validateReturnUrl('javascript:alert(1)')).toThrow();
  expect(() => validateReturnUrl('not a url')).toThrow('not valid');
});

test('callback page escapes provider-controlled text', () => {
  const page = callbackPage({ ok: true, platform: 'twitter', username: '<img src=x onerror=alert(1)>', returnUrl: 'compound://social-connected?username="x' });
  expect(page).not.toContain('<img');
  expect(page).toContain('&#60;img');
  expect(page).toContain('on X is connected');
  expect(page).toContain('url=compound://social-connected?username=&#34;x"');
});
