import { test, expect, afterEach } from 'bun:test';
import { convexTest } from 'convex-test';
import { resolve } from 'node:path';
import schema from '../convex/schema';
import { api, internal, components } from '../convex/_generated/api';

// The Better Auth component is installed locally under convex/betterAuth.
const componentDir = resolve(import.meta.dirname, '../convex/betterAuth');
const componentSchema = (await import(`${componentDir}/schema.ts`)).default;
function modules(dir: string, ignore: string[] = []) {
  return Object.fromEntries(
    [...new Bun.Glob('**/*.ts').scanSync(dir)]
      .filter((path) => !ignore.some((prefix) => path.startsWith(prefix)))
      .map((path) => [`${dir}/${path}`, () => import(`${dir}/${path}`)]),
  );
}
function setup() {
  const t = convexTest(schema, modules(resolve(import.meta.dirname, '../convex'), ['betterAuth/']));
  t.registerComponent('betterAuth', componentSchema, modules(componentDir));
  return t;
}
async function identity(t: ReturnType<typeof setup>, email: string, expired = false) {
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
        expiresAt: now + (expired ? -1000 : 60000),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return {
    user: user!,
    authenticated: t.withIdentity({ subject: user!._id, sessionId: session!._id }),
  };
}
test('upload ownership, expired sessions, bounded calls, and cleanup', async () => {
  const t = setup();
  const alice = await identity(t, 'alice@example.com');
  const bob = await identity(t, 'bob@example.com');
  const expired = await identity(t, 'expired@example.com', true);
  await expect(
    t.mutation(api.uploads.create, { contentType: 'audio/ogg', size: 12 }),
  ).rejects.toThrow();
  await expect(
    expired.authenticated.mutation(api.uploads.create, { contentType: 'audio/ogg', size: 12 }),
  ).rejects.toThrow();
  const upload = (await alice.authenticated.mutation(api.uploads.create, {
    contentType: 'audio/ogg',
    size: 12,
  }))!;
  expect(upload.key).toBe(`media/${upload._id}`);
  expect((await alice.authenticated.query(api.uploads.get, { id: upload._id })).ownerId).toBe(
    alice.user._id,
  );
  await expect(bob.authenticated.query(api.uploads.get, { id: upload._id })).rejects.toThrow(
    'Upload not found',
  );
  await expect(bob.authenticated.mutation(api.uploads.claim, { id: upload._id })).rejects.toThrow(
    'Upload not found',
  );
  for (let i = 0; i < 10; i++)
    await alice.authenticated.mutation(api.uploads.claim, { id: upload._id });
  await expect(alice.authenticated.mutation(api.uploads.claim, { id: upload._id })).rejects.toThrow(
    'limit',
  );
  await t.mutation(internal.uploads.removeForUser, { ownerId: alice.user._id });
  expect(await t.run((ctx) => ctx.db.get(upload._id))).toBeNull();
});
test('expired upload records cannot hide active quota entries', async () => {
  const t = setup();
  const { user, authenticated } = await identity(t, 'quota@example.com');
  await t.run(async (ctx) => {
    for (let i = 0; i < 105; i++)
      await ctx.db.insert('uploads', {
        ownerId: user._id,
        key: `media/old${i}`,
        size: 1,
        contentType: 'audio/ogg',
        calls: 0,
        expiresAt: Date.now() - 1,
      });
    for (let i = 0; i < 100; i++)
      await ctx.db.insert('uploads', {
        ownerId: user._id,
        key: `media/new${i}`,
        size: 1,
        contentType: 'audio/ogg',
        calls: 0,
        expiresAt: Date.now() + 60000,
      });
  });
  await expect(
    authenticated.mutation(api.uploads.create, { contentType: 'audio/ogg', size: 1 }),
  ).rejects.toThrow('limit');
  await t.mutation(internal.uploads.expire, {});
  expect((await t.run((ctx) => ctx.db.query('uploads').collect())).length).toBe(100);
});
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test('email OTP creates signed native session, rejects bad codes, and revokes it on account deletion', async () => {
  process.env.CONVEX_SITE_URL = 'https://test.convex.site';
  process.env.SITE_URL = 'http://localhost:5173';
  process.env.BETTER_AUTH_SECRET = 'test-only-secret-with-at-least-32-characters';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.RESEND_FROM_EMAIL = 'Compound <test@example.com>';
  const t = setup();
  let otp = '';
  globalThis.fetch = (async (url, init) => {
    if (String(url) !== 'https://api.resend.com/emails')
      throw new Error('Unexpected network request in test');
    otp = JSON.parse(String(init?.body)).text.match(/\d{6}/)[0];
    return Response.json({ id: 'test-email' });
  }) as typeof fetch;
  const auth = (path: string, body?: unknown, token?: string) =>
    t.fetch(`/api/auth/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: 'compound://',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const sent = await auth('email-otp/send-verification-otp', {
    email: 'new@example.com',
    type: 'sign-in',
  });
  expect(sent.status).toBe(200);
  expect(otp.length).toBe(6);
  expect(
    (
      await auth('sign-in/email-otp', {
        email: 'new@example.com',
        otp: otp === '000000' ? '111111' : '000000',
      })
    ).status,
  ).toBe(400);
  const verified = await auth('sign-in/email-otp', { email: 'new@example.com', otp });
  expect(verified.status).toBe(200);
  const signed = verified.headers.get('set-auth-token');
  expect(signed).toContain('.');
  expect(((await (await auth('get-session', undefined, signed!)).json()) as any).user.email).toBe(
    'new@example.com',
  );
  expect((await auth('get-session', undefined, 'forged-raw-token')).status).toBe(200);
  expect(await (await auth('get-session', undefined, 'forged-raw-token')).json()).toBeNull();
  const jwtResponse = await auth('convex/token', undefined, signed!);
  expect(jwtResponse.status).toBe(200);
  const jwt = (await jwtResponse.json()) as { token: string };
  const claims = JSON.parse(Buffer.from(jwt.token.split('.')[1]!, 'base64url').toString());
  expect(claims.sub).toBeTruthy();
  expect(claims.sessionId).toBeTruthy();
  const owner = t.withIdentity({ subject: claims.sub, sessionId: claims.sessionId });
  const uploaded = await owner.mutation(api.uploads.create, { contentType: 'audio/ogg', size: 12 });
  expect((await auth('delete-user', {}, signed!)).status).toBe(200);
  expect(await t.run((ctx) => ctx.db.get(uploaded!._id))).toBeNull();
  expect(await (await auth('get-session', undefined, signed!)).json()).toBeNull();
});
