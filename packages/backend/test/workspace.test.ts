import { test, expect, afterEach } from 'bun:test';
import { convexTest } from 'convex-test';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import schema from '../convex/schema';
import { api, internal, components } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';

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
type T = ReturnType<typeof setup>;
/** Inserts user and session rows directly; no personal organization is created this way. */
async function identity(t: T, email: string) {
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
  return { user: user!, as: t.withIdentity({ subject: user!._id, sessionId: session!._id }) };
}
/** A member with their personal organization, whose workspace the files tests write into. */
async function member(t: T, email: string) {
  const who = await identity(t, email);
  const { id: organizationId } = await who.as.mutation(api.organizations.ensurePersonal, {});
  return { ...who, organizationId };
}
async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function file(path: string, text: string) {
  return { path, text, hash: await sha256(text) };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('sign-up through email OTP creates a personal organization owned by the user', async () => {
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
  expect((await auth('email-otp/send-verification-otp', { email: 'fresh@example.com', type: 'sign-in' })).status).toBe(200);
  const verified = await auth('sign-in/email-otp', { email: 'fresh@example.com', otp });
  expect(verified.status).toBe(200);
  const jwt = (await (await auth('convex/token', undefined, verified.headers.get('set-auth-token')!)).json()) as { token: string };
  const claims = JSON.parse(Buffer.from(jwt.token.split('.')[1]!, 'base64url').toString());
  const me = t.withIdentity({ subject: claims.sub, sessionId: claims.sessionId });
  const mine = await me.query(api.organizations.listMine, {});
  expect(mine).toEqual([
    { id: expect.any(String), name: 'fresh', slug: `personal-${claims.sub}`, role: 'owner' },
  ]);
  // ensurePersonal is a no-op once an organization exists.
  expect((await me.mutation(api.organizations.ensurePersonal, {})).id).toBe(mine[0]!.id);
  expect((await me.query(api.organizations.listMine, {})).length).toBe(1);
});

test('ensurePersonal backfills accounts that predate organizations', async () => {
  const t = setup();
  const alice = await identity(t, 'alice@example.com');
  expect(await alice.as.query(api.organizations.listMine, {})).toEqual([]);
  const { id } = await alice.as.mutation(api.organizations.ensurePersonal, {});
  expect(await alice.as.query(api.organizations.listMine, {})).toEqual([
    { id, name: 'alice', slug: `personal-${alice.user._id}`, role: 'owner' },
  ]);
  expect((await alice.as.mutation(api.organizations.ensurePersonal, {})).id).toBe(id);
  await expect(t.query(api.organizations.listMine, {})).rejects.toThrow('Unauthenticated');
});

test('organizations.create makes the caller owner of a new organization', async () => {
  process.env.BETTER_AUTH_SECRET = 'test-only-secret-with-at-least-32-characters';
  const t = setup();
  const alice = await identity(t, 'alice@example.com');
  const { id } = await alice.as.action(api.organizations.create, { name: 'Acme Studio' });
  const mine = await alice.as.query(api.organizations.listMine, {});
  expect(mine).toEqual([{ id, name: 'Acme Studio', slug: expect.stringMatching(/^acme-studio-[0-9a-f]{8}$/), role: 'owner' }]);
  await expect(alice.as.action(api.organizations.create, { name: '  ' })).rejects.toThrow('1-100');
});

test('non-members cannot list, get or write; members can', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const bob = await identity(t, 'bob@example.com');
  const organizationId = alice.organizationId;
  const denied = 'Not a member of this organization';
  await expect(bob.as.query(api.files.list, { organizationId })).rejects.toThrow(denied);
  await expect(bob.as.query(api.files.get, { organizationId, path: 'index.tsx' })).rejects.toThrow(denied);
  await expect(
    bob.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...(await file('index.tsx', 'x')) }),
  ).rejects.toThrow(denied);
  await expect(
    bob.as.mutation(api.files.writeMany, { organizationId, files: [await file('index.tsx', 'x')] }),
  ).rejects.toThrow(denied);
  await expect(bob.as.mutation(api.files.remove, { organizationId, path: 'index.tsx', expectedVersion: 1 })).rejects.toThrow(denied);
  await expect(t.query(api.files.list, { organizationId })).rejects.toThrow('Unauthenticated');

  const written = await alice.as.mutation(api.files.write, {
    organizationId,
    expectedVersion: null,
    ...(await file('projects/demo/index.tsx', 'export default 1')),
  });
  expect(written).toEqual({ status: 'ok', version: 1 });
  expect((await alice.as.query(api.files.list, { organizationId })).map((f) => f.path)).toEqual(['projects/demo/index.tsx']);
  // Another organization's workspace is another table: nothing of alice's shows there.
  const carol = await member(t, 'carol@example.com');
  expect(await carol.as.query(api.files.list, { organizationId: carol.organizationId })).toEqual([]);
});

test('create semantics: null expectedVersion conflicts on a live row and succeeds on a tombstone', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const organizationId = alice.organizationId;
  const first = await file('a.tsx', 'one');
  expect(await alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...first })).toEqual({ status: 'ok', version: 1 });
  const again = await alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...(await file('a.tsx', 'two')) });
  expect(again).toEqual({
    status: 'conflict',
    current: { ...first, version: 1, deleted: false, updatedAt: expect.any(Number), updatedBy: alice.user._id },
  });
  expect(await alice.as.mutation(api.files.remove, { organizationId, path: 'a.tsx', expectedVersion: 1 })).toEqual({ status: 'ok', version: 2 });
  expect(await alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...(await file('a.tsx', 'three')) })).toEqual({ status: 'ok', version: 3 });
});

test('version conflicts return the current row, or null when the file never existed', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const organizationId = alice.organizationId;
  const v1 = await file('b.tsx', 'v1');
  await alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...v1 });
  const stale = await alice.as.mutation(api.files.write, { organizationId, expectedVersion: 0, ...(await file('b.tsx', 'stale')) });
  expect(stale.status).toBe('conflict');
  expect(stale.status === 'conflict' && stale.current).toMatchObject({ ...v1, version: 1, deleted: false });
  expect(await alice.as.mutation(api.files.write, { organizationId, expectedVersion: 1, ...(await file('b.tsx', 'v2')) })).toEqual({ status: 'ok', version: 2 });
  expect(await alice.as.mutation(api.files.write, { organizationId, expectedVersion: 3, ...(await file('missing.tsx', 'x')) })).toEqual({ status: 'conflict', current: null });
  expect(await alice.as.mutation(api.files.remove, { organizationId, path: 'missing.tsx', expectedVersion: 1 })).toEqual({ status: 'conflict', current: null });
  expect(await alice.as.mutation(api.files.remove, { organizationId, path: 'b.tsx', expectedVersion: 1 })).toMatchObject({ status: 'conflict', current: { version: 2 } });
});

test('getMany answers the rows asked for, in order, to members only, and caps the paths per call', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const bob = await identity(t, 'bob@example.com');
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  await alice.as.mutation(api.files.writeMany, { organizationId: alice.organizationId, files: [
    { path: 'b.md', text: 'B', hash: sha('B') },
    { path: 'a.md', text: 'A', hash: sha('A') },
  ] });
  const rows = await alice.as.query(api.files.getMany, { organizationId: alice.organizationId, paths: ['a.md', 'missing.md', 'b.md'] });
  expect(rows.map((row) => [row.path, row.text])).toEqual([['a.md', 'A'], ['b.md', 'B']]);
  await expect(bob.as.query(api.files.getMany, { organizationId: alice.organizationId, paths: ['a.md'] })).rejects.toThrow('Not a member');
  await expect(alice.as.query(api.files.getMany, { organizationId: alice.organizationId, paths: Array.from({ length: 65 }, (_, i) => `${i}.md`) })).rejects.toThrow('At most 64');
});

test('removeMany tombstones each path against its version in one call, answering conflicts per path', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  await alice.as.mutation(api.files.writeMany, { organizationId: alice.organizationId, files: [
    { path: 'p/a.md', text: 'A', hash: sha('A') },
    { path: 'p/b.md', text: 'B', hash: sha('B') },
  ] });
  const results = await alice.as.mutation(api.files.removeMany, { organizationId: alice.organizationId, paths: [
    { path: 'p/a.md', expectedVersion: 1 },
    { path: 'p/b.md', expectedVersion: 7 },
    { path: 'p/none.md', expectedVersion: 1 },
  ] });
  expect(results.map((r) => r.status)).toEqual(['ok', 'conflict', 'conflict']);
  const rows = await alice.as.query(api.files.list, { organizationId: alice.organizationId });
  expect(rows.map((r) => [r.path, r.deleted, r.version])).toEqual([['p/a.md', true, 2], ['p/b.md', false, 1]]);
});

test('remove creates a tombstone with a bumped version and list includes it', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const organizationId = alice.organizationId;
  await alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...(await file('z.tsx', 'z')) });
  await alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...(await file('a/b.tsx', 'ab')) });
  expect(await alice.as.mutation(api.files.remove, { organizationId, path: 'z.tsx', expectedVersion: 1 })).toEqual({ status: 'ok', version: 2 });
  const listed = await alice.as.query(api.files.list, { organizationId });
  expect(listed.map((f) => [f.path, f.version, f.deleted])).toEqual([
    ['a/b.tsx', 1, false],
    ['z.tsx', 2, true],
  ]);
  expect('text' in listed[0]!).toBe(false);
  expect(listed[1]!.hash).toBe(await sha256(''));
  expect(await alice.as.query(api.files.get, { organizationId, path: 'a/b.tsx' })).toMatchObject({ path: 'a/b.tsx', text: 'ab', version: 1 });
  expect(await alice.as.query(api.files.get, { organizationId, path: 'z.tsx' })).toMatchObject({ deleted: true, text: '' });
  expect(await alice.as.query(api.files.get, { organizationId, path: 'never.tsx' })).toBeNull();
  // Removing a tombstone again is a no-op success.
  expect(await alice.as.mutation(api.files.remove, { organizationId, path: 'z.tsx', expectedVersion: 2 })).toEqual({ status: 'ok', version: 2 });
});

test('writeMany forces writes, bumps versions and enforces limits', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const organizationId = alice.organizationId;
  await alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...(await file('index.tsx', 'old')) });
  await alice.as.mutation(api.files.writeMany, {
    organizationId,
    files: [await file('index.tsx', 'new'), await file('package.json', '{}')],
  });
  const listed = await alice.as.query(api.files.list, { organizationId });
  expect(listed.map((f) => [f.path, f.version, f.deleted])).toEqual([
    ['index.tsx', 2, false],
    ['package.json', 1, false],
  ]);
  expect((await alice.as.query(api.files.get, { organizationId, path: 'index.tsx' }))?.text).toBe('new');
  const many = await Promise.all(Array.from({ length: 65 }, (_, i) => file(`f${i}.tsx`, 'x')));
  await expect(alice.as.mutation(api.files.writeMany, { organizationId, files: many })).rejects.toThrow('At most 64');
  await expect(
    alice.as.mutation(api.files.writeMany, { organizationId, files: [await file('a.tsx', 'x'), await file('a.tsx', 'y')] }),
  ).rejects.toThrow('Duplicate');
  const big = 'x'.repeat(512 * 1024 + 1);
  await expect(alice.as.mutation(api.files.writeMany, { organizationId, files: [await file('big.tsx', big)] })).rejects.toThrow('512 KiB');
});

test('write validates paths, text and hashes', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const organizationId = alice.organizationId;
  const ok = await file('ok.tsx', 'ok');
  for (const path of ['/abs.tsx', '../up.tsx', 'a/../b.tsx', 'a\\b.tsx', 'a\0b', '', 'a//b.tsx', 'x'.repeat(513)])
    await expect(alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...ok, path })).rejects.toThrow();
  await expect(alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...ok, hash: 'deadbeef' })).rejects.toThrow('64 lowercase hex');
  await expect(alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...ok, hash: await sha256('other') })).rejects.toThrow('does not match');
  await expect(alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...(await file('nul.tsx', 'a\0b')) })).rejects.toThrow('NUL');
  expect(await alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...(await file('deep/dir/.hidden', '')) })).toEqual({ status: 'ok', version: 1 });
});

test('assets.register is idempotent per organization and sample, and markReady flips state', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const bob = await identity(t, 'bob@example.com');
  const args = { organizationId: alice.organizationId, sampleId: '0123456789abcdef', size: 1234, mimeType: 'video/mp4', name: 'clip.mp4' };
  const first = await alice.as.mutation(api.assets.register, args);
  expect(first).toEqual({ assetId: expect.any(String), state: 'uploading', uploadNeeded: true });
  const second = await alice.as.mutation(api.assets.register, { ...args, name: 'renamed.mp4' });
  expect(second).toEqual({ assetId: first.assetId, state: 'uploading', uploadNeeded: true });
  await expect(bob.as.mutation(api.assets.register, args)).rejects.toThrow('Not a member');
  await expect(bob.as.query(api.assets.get, { organizationId: alice.organizationId, sampleId: args.sampleId })).rejects.toThrow('Not a member');
  await expect(alice.as.mutation(api.assets.register, { ...args, sampleId: 'nope' })).rejects.toThrow('16 hex');
  expect(await alice.as.query(api.assets.get, { organizationId: alice.organizationId, sampleId: 'ffffffffffffffff' })).toBeNull();

  await t.mutation(internal.assets.markReady, { assetId: first.assetId as Id<'assets'>, originalKey: `assets/${alice.organizationId}/${args.sampleId}/clip.mp4` });
  expect(await alice.as.mutation(api.assets.register, args)).toEqual({ assetId: first.assetId, state: 'ready', uploadNeeded: false });
  const asset = await alice.as.query(api.assets.get, { organizationId: alice.organizationId, sampleId: args.sampleId });
  expect(asset).toMatchObject({ organizationId: alice.organizationId, name: 'clip.mp4', originalState: 'ready', uploadedBy: alice.user._id });
});

test('assets.list shows every asset of the organization to members, and proxies register and finish at their own key', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const bob = await identity(t, 'bob@example.com');
  const args = { organizationId: alice.organizationId, sampleId: '0123456789abcdef', size: 1234, mimeType: 'video/mp4', name: 'clip.mp4' };
  const { assetId } = await alice.as.mutation(api.assets.register, args);
  const id = assetId as Id<'assets'>;
  await expect(bob.as.query(api.assets.list, { organizationId: alice.organizationId })).rejects.toThrow('Not a member');
  expect(await alice.as.query(api.assets.list, { organizationId: alice.organizationId })).toEqual([
    { assetId: id, sampleId: args.sampleId, name: 'clip.mp4', mimeType: 'video/mp4', size: 1234, originalState: 'uploading', proxyState: null, proxySize: null, updatedAt: expect.any(Number) },
  ]);

  await expect(bob.as.mutation(api.assets.registerProxy, { assetId: id, size: 100 })).rejects.toThrow('Not a member');
  expect(await alice.as.mutation(api.assets.registerProxy, { assetId: id, size: 100 })).toEqual({ state: 'uploading', uploadNeeded: true });
  await expect(alice.as.mutation(api.assets.finishProxy, { assetId: id, proxyKey: 'assets/elsewhere/proxy.mp4' })).rejects.toThrow('does not match');
  await alice.as.mutation(api.assets.finishProxy, { assetId: id, proxyKey: `assets/${alice.organizationId}/${args.sampleId}/proxy.mp4` });
  expect(await alice.as.mutation(api.assets.registerProxy, { assetId: id, size: 100 })).toEqual({ state: 'ready', uploadNeeded: false });
  const [listed] = await alice.as.query(api.assets.list, { organizationId: alice.organizationId });
  expect(listed).toMatchObject({ proxyState: 'ready', proxySize: 100 });
  await expect(alice.as.mutation(api.assets.finishProxy, { assetId: id, proxyKey: `assets/${alice.organizationId}/${args.sampleId}/proxy.mp4` })).rejects.toThrow('No proxy upload');
});

test('assets.setMultipart records the upload an original arrives through, for members, until it is ready', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const bob = await identity(t, 'bob@example.com');
  const args = { organizationId: alice.organizationId, sampleId: '0123456789abcdef', size: 1234, mimeType: 'video/mp4', name: 'clip.mp4' };
  const { assetId } = await alice.as.mutation(api.assets.register, args);
  const id = assetId as Id<'assets'>;
  await expect(bob.as.mutation(api.assets.setMultipart, { assetId: id, uploadId: 'u1' })).rejects.toThrow('Not a member');
  await alice.as.mutation(api.assets.setMultipart, { assetId: id, uploadId: 'u1' });
  expect((await alice.as.query(api.assets.describe, { assetId: id })).multipartUploadId).toBe('u1');
  await alice.as.mutation(api.assets.finish, { assetId: id, originalKey: `assets/${alice.organizationId}/${args.sampleId}/clip.mp4` });
  expect((await alice.as.query(api.assets.describe, { assetId: id })).multipartUploadId).toBeUndefined();
  await expect(alice.as.mutation(api.assets.setMultipart, { assetId: id, uploadId: 'u2' })).rejects.toThrow('already in the cloud');
});

test('assets.describe and assets.finish are for members only, and finish binds the key to the asset', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const bob = await identity(t, 'bob@example.com');
  const args = { organizationId: alice.organizationId, sampleId: '0123456789abcdef', size: 1234, mimeType: 'video/mp4', name: 'clip.mp4' };
  const { assetId } = await alice.as.mutation(api.assets.register, args);
  const id = assetId as Id<'assets'>;
  const key = `assets/${alice.organizationId}/${args.sampleId}/clip.mp4`;
  expect(await alice.as.query(api.assets.describe, { assetId: id })).toMatchObject({ organizationId: alice.organizationId, sampleId: args.sampleId, name: 'clip.mp4', originalState: 'uploading' });
  await expect(bob.as.query(api.assets.describe, { assetId: id })).rejects.toThrow('Not a member');
  await expect(bob.as.mutation(api.assets.finish, { assetId: id, originalKey: key })).rejects.toThrow('Not a member');
  await expect(alice.as.mutation(api.assets.finish, { assetId: id, originalKey: `assets/${alice.organizationId}/${args.sampleId}/other.mp4` })).rejects.toThrow('does not match');
  await alice.as.mutation(api.assets.finish, { assetId: id, originalKey: key });
  expect(await alice.as.query(api.assets.describe, { assetId: id })).toMatchObject({ originalKey: key, originalState: 'ready' });
  // Finishing twice is harmless.
  await alice.as.mutation(api.assets.finish, { assetId: id, originalKey: key });
});

test('addMemberByEmail requires owner/admin and an existing account, then grants access', async () => {
  process.env.BETTER_AUTH_SECRET = 'test-only-secret-with-at-least-32-characters';
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const bob = await identity(t, 'bob@example.com');
  const carol = await identity(t, 'carol@example.com');
  const org = alice.organizationId;
  await expect(bob.as.action(api.organizations.addMemberByEmail, { organizationId: org, email: 'carol@example.com' })).rejects.toThrow('Not a member');
  await expect(alice.as.action(api.organizations.addMemberByEmail, { organizationId: org, email: 'nobody@example.com' })).rejects.toThrow('No account');
  await alice.as.action(api.organizations.addMemberByEmail, { organizationId: org, email: 'Bob@example.com' });
  expect(await bob.as.query(api.organizations.listMine, {})).toEqual([{ id: org, name: 'alice', slug: `personal-${alice.user._id}`, role: 'member' }]);
  expect(await bob.as.query(api.files.list, { organizationId: org })).toEqual([]);
  // A plain member cannot add others; an admin can.
  await expect(bob.as.action(api.organizations.addMemberByEmail, { organizationId: org, email: 'carol@example.com' })).rejects.toThrow('owners and admins');
  await expect(alice.as.action(api.organizations.addMemberByEmail, { organizationId: org, email: 'bob@example.com' })).rejects.toThrow();
  await alice.as.action(api.organizations.addMemberByEmail, { organizationId: org, email: 'carol@example.com', role: 'admin' });
  await expect(carol.as.action(api.organizations.addMemberByEmail, { organizationId: org, email: 'dave@example.com' })).rejects.toThrow('No account');
  expect((await carol.as.query(api.organizations.listMine, {}))[0]?.role).toBe('admin');
});

test('member directory and removal enforce membership, protect owners, and revoke workspace access', async () => {
  process.env.BETTER_AUTH_SECRET = 'test-only-secret-with-at-least-32-characters';
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const bob = await identity(t, 'bob@example.com');
  const carol = await identity(t, 'carol@example.com');
  const outsider = await member(t, 'outsider@example.com');
  const organizationId = alice.organizationId;
  await expect(bob.as.query(api.organizations.listMembers, { organizationId })).rejects.toThrow('Not a member');
  await alice.as.action(api.organizations.addMemberByEmail, { organizationId, email: 'bob@example.com' });
  await alice.as.action(api.organizations.addMemberByEmail, { organizationId, email: 'carol@example.com', role: 'admin' });
  const members = await bob.as.query(api.organizations.listMembers, { organizationId });
  expect(members.map((m) => m.email).sort()).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
  const owner = members.find((m) => m.userId === alice.user._id)!;
  const regular = members.find((m) => m.userId === bob.user._id)!;
  const admin = members.find((m) => m.userId === carol.user._id)!;
  const remove = (memberId: string) => ({ organizationId, memberId });

  await expect(outsider.as.mutation(api.organizations.removeMember, remove(regular.id))).rejects.toThrow('Not a member');
  await expect(bob.as.mutation(api.organizations.removeMember, remove(admin.id))).rejects.toThrow('owners and admins');
  await expect(carol.as.mutation(api.organizations.removeMember, remove(owner.id))).rejects.toThrow('owners cannot be removed');
  await expect(alice.as.mutation(api.organizations.removeMember, remove(owner.id))).rejects.toThrow('owners cannot be removed');
  await expect(carol.as.mutation(api.organizations.removeMember, remove(admin.id))).rejects.toThrow('cannot remove yourself');
  const [foreignMember] = await outsider.as.query(api.organizations.listMembers, { organizationId: outsider.organizationId });
  await expect(alice.as.mutation(api.organizations.removeMember, remove(foreignMember!.id))).rejects.toThrow('Member not found');

  await carol.as.mutation(api.organizations.removeMember, remove(regular.id));
  expect(await bob.as.query(api.organizations.listMine, {})).toEqual([]);
  await expect(bob.as.query(api.files.list, { organizationId })).rejects.toThrow('Not a member');
  await expect(bob.as.query(api.organizations.listMembers, { organizationId })).rejects.toThrow('Not a member');
  await expect(carol.as.mutation(api.organizations.removeMember, remove(regular.id))).rejects.toThrow('Member not found');
  await alice.as.mutation(api.organizations.removeMember, remove(admin.id));
  expect(await alice.as.query(api.organizations.listMembers, { organizationId })).toHaveLength(1);
});

test('a create that differs from an existing path only by case is refused', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const organizationId = alice.organizationId;
  await alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...(await file('Index.tsx', 'a')) });
  await expect(
    alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...(await file('index.tsx', 'b')) }),
  ).rejects.toThrow('differing only in case');
  await expect(
    alice.as.mutation(api.files.writeMany, { organizationId, files: [await file('INDEX.tsx', 'c')] }),
  ).rejects.toThrow('differing only in case');
  // The same path again is not a collision with itself, and a tombstone frees the name.
  await alice.as.mutation(api.files.write, { organizationId, expectedVersion: 1, ...(await file('Index.tsx', 'a2')) });
  await alice.as.mutation(api.files.remove, { organizationId, path: 'Index.tsx', expectedVersion: 2 });
  await alice.as.mutation(api.files.write, { organizationId, expectedVersion: null, ...(await file('index.tsx', 'b')) });
});

test('migrations.projectsToWorkspace copies legacy rows under the desktop folder name, drops cloudProjectId, and skips what a desktop already pushed', async () => {
  const t = setup();
  const alice = await member(t, 'alice@example.com');
  const now = Date.now();
  const insertProject = (name: string, archived = false) =>
    t.run((ctx) =>
      ctx.db.insert('projects', { organizationId: alice.organizationId, name, entry: 'index.tsx', createdBy: alice.user._id, createdAt: now, updatedAt: now, ...(archived ? { archivedAt: now } : {}) }),
    );
  const insertRow = async (projectId: Id<'projects'>, path: string, text: string, deleted = false) =>
    t.run(async (ctx) => {
      await ctx.db.insert('projectFiles', { projectId, ...(await file(path, text)), version: 1, deleted, updatedAt: now, updatedBy: alice.user._id });
    });
  const legacyPackage = JSON.stringify({ name: 'film', projectId: 'p_film', cloudProjectId: 'legacy', main: 'index.tsx' }, null, 2) + '\n';

  const film = await insertProject('My Film: Cut 2');
  await insertRow(film, 'index.tsx', 'legacy');
  await insertRow(film, 'package.json', legacyPackage);
  await insertRow(film, 'gone.tsx', '', true);
  const archived = await insertProject('Old', true);
  await insertRow(archived, 'index.tsx', 'x');
  // A project the desktop already moved and pushed, under its on-disk name: skipped whole.
  const pushed = await insertProject('Pushed');
  await insertRow(pushed, 'index.tsx', 'stale');
  await insertRow(pushed, 'package.json', JSON.stringify({ projectId: 'p_pushed', cloudProjectId: 'legacy2' }, null, 2) + '\n');
  await alice.as.mutation(api.files.write, { organizationId: alice.organizationId, expectedVersion: null, ...(await file('projects/pushed-renamed/package.json', JSON.stringify({ projectId: 'p_pushed' }, null, 2) + '\n')) });
  // A path that differs only by case from what the workspace holds is left alone.
  await alice.as.mutation(api.files.write, { organizationId: alice.organizationId, expectedVersion: null, ...(await file('projects/my-film-cut-2/INDEX.tsx', 'theirs')) });

  expect(await t.mutation(internal.migrations.projectsToWorkspace, {})).toEqual({ projects: 3, copied: 1, skipped: 1, skippedProjects: 1 });
  const listed = await alice.as.query(api.files.list, { organizationId: alice.organizationId });
  expect(listed.map((f) => f.path).sort()).toEqual(['projects/my-film-cut-2/INDEX.tsx', 'projects/my-film-cut-2/package.json', 'projects/pushed-renamed/package.json']);
  const copied = await alice.as.query(api.files.get, { organizationId: alice.organizationId, path: 'projects/my-film-cut-2/package.json' });
  // Written the way the desktop writes package.json, so the two copies agree byte for byte.
  expect(copied?.text).toBe(JSON.stringify({ name: 'film', projectId: 'p_film', main: 'index.tsx' }, null, 2) + '\n');
  expect(copied?.hash).toBe(await sha256(copied!.text));
  // Running it again copies nothing.
  expect(await t.mutation(internal.migrations.projectsToWorkspace, {})).toEqual({ projects: 3, copied: 0, skipped: 0, skippedProjects: 2 });
});

test('sha256Hex matches the platform digest', async () => {
  const { sha256Hex } = await import('../convex/lib/sha256');
  for (const text of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'héllo wörld\n'.repeat(40)]) {
    expect(sha256Hex(text)).toBe(await sha256(text));
  }
});
