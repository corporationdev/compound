import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { dirname, resolve } from 'node:path';
import schema from '../convex/schema';
import { api, internal, components } from '../convex/_generated/api';
import { internalAction } from '../convex/_generated/server';
import { v } from 'convex/values';
import { mergeCatalogItems } from '../catalog';
import { PUBLIC_CATALOG } from '../catalog_manifest';
import { catalogManifestSource, validatePublicCatalog } from '../convex/catalog_manifest';
import type { Id } from '../convex/_generated/dataModel';

function modules(dir: string) {
  return Object.fromEntries([...new Bun.Glob('**/*.ts').scanSync(dir)].map(path => [`${dir}/${path}`, () => import(`${dir}/${path}`)]));
}
const authDir = resolve(dirname(import.meta.resolve('@convex-dev/better-auth/package.json').replace('file://', '')), 'src/component');
const authSchema = (await import(`${authDir}/schema.ts`)).default;
function setup(realArtwork = false) {
  jest.useFakeTimers();
  const dir = resolve(import.meta.dirname, '../convex');
  const t = convexTest(schema, {
    ...modules(dir),
    [`${dir}/catalog_actions.ts`]: async () => ({
      ...(realArtwork ? { artwork: (await import('../convex/catalog_actions')).artwork } : {}),
      prepareSource: internalAction({ args: { sourceId: v.id('catalogSources'), attempt: v.number() }, handler: async () => null }),
      searchProvider: internalAction({ args: { searchId: v.id('catalogSearches') }, handler: async () => null }),
      deleteObjects: internalAction({ args: { keys: v.array(v.string()) }, handler: async () => null }),
    }),
  });
  t.registerComponent('betterAuth', authSchema, modules(authDir));
  return t;
}
async function user(t: ReturnType<typeof setup>, email: string) {
  const now = Date.now();
  const u = await t.mutation(components.betterAuth.adapter.create, { input: { model: 'user', data: { name: 'Test', email, emailVerified: true, createdAt: now, updatedAt: now } } });
  const session = await t.mutation(components.betterAuth.adapter.create, { input: { model: 'session', data: { userId: u!._id, token: crypto.randomUUID(), expiresAt: now + 864000000, createdAt: now, updatedAt: now } } });
  return t.withIdentity({ subject: u!._id, sessionId: session!._id });
}
async function publicSource(t: ReturnType<typeof setup>, externalId = 'JuSsvM8B4Jc') {
  return t.mutation(internal.catalog.ensureForDeploy, { provider: 'youtube', externalId, kind: 'music', title: 'Original title' });
}
async function ready(t: ReturnType<typeof setup>, sourceId: Id<'catalogSources'>, attempt = 1) {
  return t.mutation(internal.catalog.complete, { sourceId, attempt, key: `library/catalog/${sourceId}/${attempt}.m4a`, checksum: 'a'.repeat(64), size: 42, mimeType: 'audio/mp4', extension: 'm4a', durationUs: 60_000_000 });
}
const page = { kind: 'music' as const, paginationOpts: { numItems: 20, cursor: null } };
afterEach(() => jest.useRealTimers());

test('artwork is authenticated, cached independently, and never starts audio preparation', async () => {
  const t = setup(true), alice = await user(t, 'artwork@test.com');
  const sourceId = await publicSource(t);
  expect((await alice.query(api.catalog.get, { sourceId })).artworkAvailable).toBe(true);
  await expect(t.query(api.catalog.artworkSource, { sourceId })).rejects.toThrow();
  const keys = ['CLOUDFLARE_ACCOUNT_ID', 'MEDIA_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const before = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = 'artwork-test';
  const fetchTarget: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } = globalThis;
  const fetcher = spyOn(fetchTarget, 'fetch').mockImplementation(async input => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname === 'i.ytimg.com') return new Response(new Uint8Array([255, 216, 255, 224]));
    expect(input instanceof Request && input.method).toBe('PUT');
    expect(url).toContain(`/library/artwork/${sourceId}.jpg`);
    return new Response(null, { status: 200 });
  });
  try {
    const first = await alice.action(api.catalog_actions.artwork, { sourceId });
    expect(first.url).toContain(`/library/artwork/${sourceId}.jpg`);
    await alice.action(api.catalog_actions.artwork, { sourceId });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const source = await t.query(internal.catalog.context, { sourceId });
    expect(source?.status).toBe('queued'); expect(source?.attempt).toBe(0);
    const upload = await alice.mutation(api.catalog.createUpload, { kind: 'music', title: 'Private', size: 42, mimeType: 'audio/mpeg' });
    expect((await alice.query(api.catalog.get, { sourceId: upload.sourceId })).artworkAvailable).toBe(false);
    expect(await alice.action(api.catalog_actions.artwork, { sourceId: upload.sourceId })).toEqual({ url: null });
    await expect(t.query(api.catalog.artworkSource, { sourceId: upload.sourceId })).rejects.toThrow();
  } finally {
    fetcher.mockRestore();
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
  }
});

test('starter manifest retains 18 songs, 10 SFX and exact URL identities', () => {
  validatePublicCatalog(PUBLIC_CATALOG, ['music', 'sfx']);
  expect(PUBLIC_CATALOG.filter(item => catalogManifestSource(item.sourceUrl).kind === 'music')).toHaveLength(18);
  expect(PUBLIC_CATALOG.filter(item => catalogManifestSource(item.sourceUrl).kind === 'sfx')).toHaveLength(10);
  expect(catalogManifestSource('https://youtu.be/JuSsvM8B4Jc?t=15')).toEqual(catalogManifestSource('https://music.youtube.com/watch?v=JuSsvM8B4Jc&list=anything'));
  for (const url of ['https://youtube.com/playlist?list=x', 'https://youtube.com.evil.test/watch?v=JuSsvM8B4Jc', 'https://user:secret@youtube.com/watch?v=JuSsvM8B4Jc']) expect(() => catalogManifestSource(url)).toThrow();
});
test('browse requires auth and private audio is inaccessible to another account', async () => {
  const t = setup(), alice = await user(t, 'alice@test.com'), bob = await user(t, 'bob@test.com');
  await expect(t.query(api.catalog.page, { ...page, scope: 'curated' })).rejects.toThrow();
  const upload = await alice.mutation(api.catalog.createUpload, { kind: 'music', title: 'My song', size: 42, mimeType: 'audio/mpeg' });
  expect(upload.key).toStartWith('library-staging/');
  await expect(bob.query(api.catalog.get, { sourceId: upload.sourceId })).rejects.toThrow('not found');
  await expect(bob.mutation(api.catalog.prepare, { sourceId: upload.sourceId })).rejects.toThrow('not found');
  await expect(bob.mutation(api.catalog.remove, { sourceId: upload.sourceId })).rejects.toThrow('not found');
  await alice.mutation(api.catalog.finishUpload, { sourceId: upload.sourceId });
  await ready(t, upload.sourceId);
  expect((await alice.query(api.catalog.page, { ...page, scope: 'personal' })).items).toHaveLength(1);
  expect((await bob.query(api.catalog.page, { ...page, scope: 'personal' })).items).toHaveLength(0);
  await expect(bob.query(api.catalog.media, { sourceId: upload.sourceId })).rejects.toThrow('not found');
  jest.setSystemTime(Date.now() + 2 * 86400000);
  await t.mutation(internal.catalog.expire, {});
  expect((await alice.query(api.catalog.media, { sourceId: upload.sourceId })).item.title).toBe('My song');
});
test('source preparation is single-flight, stale completions cannot replace a retry', async () => {
  const t = setup(), alice = await user(t, 'alice@test.com');
  const sourceId = await publicSource(t);
  await alice.mutation(api.catalog.prepare, { sourceId });
  await alice.mutation(api.catalog.prepare, { sourceId });
  expect((await t.query(internal.catalog.context, { sourceId }))?.attempt).toBe(1);
  await t.mutation(internal.catalog.progress, { sourceId, attempt: 1, externalRunId: 'persisted-apify-run' });
  await t.mutation(internal.catalog.fail, { sourceId, attempt: 1, error: 'temporary failure' });
  await alice.mutation(api.catalog.prepare, { sourceId });
  expect((await t.query(internal.catalog.context, { sourceId }))?.externalRunId).toBe('persisted-apify-run');
  expect(await ready(t, sourceId, 1)).toBe(false);
  expect(await ready(t, sourceId, 2)).toBe(true);
  await t.mutation(internal.catalog.fail, { sourceId, attempt: 1, error: 'stale failure' });
  expect((await alice.query(api.catalog.get, { sourceId })).status).toBe('ready');
  expect((await alice.query(api.catalog.get, { sourceId })).inUserLibrary).toBe(false);
});
test('curation, personal ranges and external results converge on one source', async () => {
  const t = setup(), alice = await user(t, 'alice@test.com');
  const sourceId = await publicSource(t);
  await t.mutation(internal.catalog.prepareForDeploy, { sourceId }); await ready(t, sourceId);
  const sourceRange = { sourceStartUs: 10_000_000, sourceEndUs: 30_000_000 };
  await t.mutation(internal.catalog.publish, { revision: 'one', items: [{ sourceId, title: 'Quiet piano', description: 'A warm bed', sourceRange }] });
  expect((await alice.query(api.catalog.get, { sourceId })).sourceRange).toEqual(sourceRange);
  await alice.mutation(api.catalog.save, { sourceId, title: 'My quiet piano', sourceRange: { sourceStartUs: 0, sourceEndUs: 60_000_000 } });
  const curated = await alice.query(api.catalog.page, { ...page, scope: 'curated' });
  const personal = await alice.query(api.catalog.page, { ...page, scope: 'personal' });
  expect(mergeCatalogItems(curated.items, personal.items)).toHaveLength(1);
  expect(personal.items[0].title).toBe('My quiet piano');
  expect(personal.items[0].sourceRange?.sourceStartUs).toBe(0);
  await alice.mutation(api.catalog.save, { sourceId, sourceRange: null });
  expect((await alice.query(api.catalog.get, { sourceId })).sourceRange).toEqual(sourceRange);
  await expect(alice.mutation(api.catalog.save, { sourceId, sourceRange: { sourceStartUs: 0, sourceEndUs: 70_000_000 } })).rejects.toThrow();
  await alice.mutation(api.catalog.remove, { sourceId });
  expect((await alice.query(api.catalog.get, { sourceId })).inGlobalLibrary).toBe(true);
  expect((await alice.query(api.catalog.get, { sourceId })).inUserLibrary).toBe(false);
});
test('a failed catalog revision leaves the old selection and metadata published', async () => {
  const t = setup(), alice = await user(t, 'alice@test.com');
  const first = await publicSource(t); await t.mutation(internal.catalog.prepareForDeploy, { sourceId: first }); await ready(t, first);
  await t.mutation(internal.catalog.publish, { revision: 'old', items: [{ sourceId: first, title: 'Old title', description: 'Old description' }] });
  const missing = await publicSource(t, 'new-source');
  await expect(t.mutation(internal.catalog.publish, { revision: 'new', items: [{ sourceId: first, title: 'New title', description: '' }, { sourceId: missing, title: 'Unavailable', description: '' }] })).rejects.toThrow('not ready');
  expect(await t.query(internal.catalog.publishedRevision, {})).toBe('old');
  expect((await alice.query(api.catalog.get, { sourceId: first })).title).toBe('Old title');
});
test('external search is cached without personal metadata or library membership', async () => {
  const t = setup(), alice = await user(t, 'alice@test.com'), bob = await user(t, 'bob@test.com');
  const searchId = await alice.mutation(api.catalog.startSearch, { kind: 'music', query: 'Quiet Piano' });
  expect(await bob.mutation(api.catalog.startSearch, { kind: 'music', query: 'quiet   piano' })).toBe(searchId);
  await t.mutation(internal.catalog.finishSearch, { searchId, items: [{ externalId: 'JuSsvM8B4Jc', title: 'Public result' }] });
  const result = await alice.query(api.catalog.searchResult, { searchId });
  expect(result.status).toBe('ready');
  expect(result.items[0].inUserLibrary).toBe(false);
  expect((await alice.query(api.catalog.page, { ...page, scope: 'personal' })).items).toHaveLength(0);
});
