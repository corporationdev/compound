import { test, expect, afterEach } from 'bun:test';
import worker, { type Env } from '../src/index';

// Library originals: the Worker signs a PUT for an asset the backend has
// registered, marks it ready once the bytes are in R2, and signs a GET for
// a ready one. Convex is faked on the wire, keyed by the function path.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const env = {
  CONVEX_URL: 'https://test.convex.cloud',
  CORS_ORIGIN: 'https://app.example.com',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  MEDIA_BUCKET_NAME: 'compound-media-dev',
  R2_ACCESS_KEY_ID: 'test-id',
  R2_SECRET_ACCESS_KEY: 'test-secret',
} as Env;
const request = (path: string, body: unknown) =>
  new Request(`https://worker.example/media/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-jwt' },
    body: JSON.stringify(body),
  });
const NOT_MEMBER = { status: 'error', errorMessage: 'Not a member', errorData: 'Not a member of this organization' };
const asset = {
  _id: 'asset-1',
  organizationId: 'org-1',
  sampleId: '0123456789abcdef',
  size: 1234,
  mimeType: 'video/mp4',
  name: 'clip.mp4',
  originalState: 'uploading',
};
const KEY = 'assets/org-1/0123456789abcdef/clip.mp4';
type Handlers = Record<string, unknown | (() => unknown)>;
function backend(handlers: Handlers) {
  const calls: { path: string; args: unknown }[] = [];
  globalThis.fetch = (async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    calls.push({ path: input.path, args: Array.isArray(input.args) ? input.args[0] : input.args });
    if (input.path === 'auth:getCurrentUser') return Response.json({ status: 'success', value: { id: 'user' } });
    if (!(input.path in handlers)) return Response.json({ status: 'error', errorMessage: `Unexpected ${input.path}` });
    const handler = handlers[input.path];
    const value = typeof handler === 'function' ? (handler as () => unknown)() : handler;
    if (value && typeof value === 'object' && 'status' in value) return Response.json(value);
    return Response.json({ status: 'success', value });
  }) as typeof fetch;
  return calls;
}
const register = { organizationId: 'org-1', sampleId: asset.sampleId, size: asset.size, mimeType: asset.mimeType, name: asset.name };

test('asset-upload-url signs a PUT at the asset key bound to declared type and size', async () => {
  const calls = backend({
    'assets:register': { assetId: 'asset-1', state: 'uploading', uploadNeeded: true },
    'assets:describe': asset,
  });
  const response = await worker.fetch(request('asset-upload-url', register), env);
  expect(response.status).toBe(200);
  const data = (await response.json()) as { assetId: string; uploadUrl: string };
  expect(data.assetId).toBe('asset-1');
  const signed = new URL(data.uploadUrl);
  expect(signed.pathname).toBe(`/compound-media-dev/${KEY}`);
  expect(signed.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
  expect(signed.searchParams.get('X-Amz-Expires')).toBe('900');
  expect(calls.find((call) => call.path === 'assets:register')?.args).toEqual(register);
});

test('asset-upload-url registers a probed type with codecs as its bare media type', async () => {
  const calls = backend({
    'assets:register': { assetId: 'asset-1', state: 'uploading', uploadNeeded: true },
    'assets:describe': asset,
  });
  const probed = { ...register, mimeType: 'Video/MP4; codecs="avc1.64001f, mp4a.40.2"' };
  expect((await worker.fetch(request('asset-upload-url', probed), env)).status).toBe(200);
  expect(calls.find((call) => call.path === 'assets:register')?.args).toEqual(register);
});

test('asset-upload-url returns no URL for an original that is already in the cloud', async () => {
  backend({ 'assets:register': { assetId: 'asset-1', state: 'ready', uploadNeeded: false } });
  const response = await worker.fetch(request('asset-upload-url', register), env);
  expect((await response.json()) as unknown).toEqual({ assetId: 'asset-1', uploadUrl: null });
});

test('asset-upload-url validates its input and refuses non-members', async () => {
  backend({ 'assets:register': NOT_MEMBER });
  expect((await worker.fetch(request('asset-upload-url', register), env)).status).toBe(403);
  expect((await worker.fetch(request('asset-upload-url', { ...register, sampleId: 'nope' }), env)).status).toBe(400);
  expect((await worker.fetch(request('asset-upload-url', { ...register, size: 4 * 1024 * 1024 * 1024 + 1 }), env)).status).toBe(400);
  expect((await worker.fetch(request('asset-upload-url', { ...register, name: '../escape.mp4' }), env)).status).toBe(400);
  expect((await worker.fetch(request('asset-upload-url', { ...register, extra: true }), env)).status).toBe(400);
});

test('asset-upload-finish checks the object size in R2 before marking the asset ready', async () => {
  const heads: string[] = [];
  const media = (size: number) =>
    ({ head: async (key: string) => { heads.push(key); return { size }; } }) as unknown as R2Bucket;
  const calls = backend({ 'assets:describe': asset, 'assets:finish': null });
  const ok = await worker.fetch(request('asset-upload-finish', { assetId: 'asset-1' }), { ...env, MEDIA: media(asset.size) });
  expect((await ok.json()) as unknown).toEqual({ ok: true });
  expect(heads).toEqual([KEY]);
  expect(calls.find((call) => call.path === 'assets:finish')?.args).toEqual({ assetId: 'asset-1', originalKey: KEY });

  const short = backend({ 'assets:describe': asset, 'assets:finish': null });
  const bad = await worker.fetch(request('asset-upload-finish', { assetId: 'asset-1' }), { ...env, MEDIA: media(asset.size - 1) });
  expect(bad.status).toBe(400);
  expect(short.some((call) => call.path === 'assets:finish')).toBe(false);

  const missing = backend({ 'assets:describe': asset });
  const gone = await worker.fetch(request('asset-upload-finish', { assetId: 'asset-1' }), {
    ...env,
    MEDIA: { head: async () => null } as unknown as R2Bucket,
  });
  expect(gone.status).toBe(400);
  expect(missing.some((call) => call.path === 'assets:finish')).toBe(false);
});

test('asset-upload-finish is idempotent for a ready asset and refuses non-members', async () => {
  const calls = backend({ 'assets:describe': { ...asset, originalState: 'ready', originalKey: KEY } });
  const response = await worker.fetch(request('asset-upload-finish', { assetId: 'asset-1' }), {
    ...env,
    MEDIA: { head: async () => { throw new Error('should not HEAD'); } } as unknown as R2Bucket,
  });
  expect((await response.json()) as unknown).toEqual({ ok: true });
  expect(calls.some((call) => call.path === 'assets:finish')).toBe(false);

  backend({ 'assets:describe': NOT_MEMBER });
  expect((await worker.fetch(request('asset-upload-finish', { assetId: 'asset-1' }), env)).status).toBe(403);
  backend({ 'assets:describe': { status: 'error', errorMessage: 'Asset not found', errorData: 'Asset not found' } });
  expect((await worker.fetch(request('asset-upload-finish', { assetId: 'asset-1' }), env)).status).toBe(404);
});

test('asset-download-url signs a GET for a ready original and 404s otherwise', async () => {
  backend({ 'assets:get': { ...asset, originalState: 'ready', originalKey: KEY } });
  const response = await worker.fetch(request('asset-download-url', { organizationId: 'org-1', sampleId: asset.sampleId }), env);
  expect(response.status).toBe(200);
  const data = (await response.json()) as { url: string; size: number; mimeType: string; name: string };
  expect(data).toMatchObject({ size: asset.size, mimeType: asset.mimeType, name: asset.name });
  const signed = new URL(data.url);
  expect(signed.pathname).toBe(`/compound-media-dev/${KEY}`);
  expect(signed.searchParams.get('X-Amz-Expires')).toBe('600');

  backend({ 'assets:get': asset });
  expect((await worker.fetch(request('asset-download-url', { organizationId: 'org-1', sampleId: asset.sampleId }), env)).status).toBe(404);
  backend({ 'assets:get': null });
  expect((await worker.fetch(request('asset-download-url', { organizationId: 'org-1', sampleId: asset.sampleId }), env)).status).toBe(404);
  backend({ 'assets:get': NOT_MEMBER });
  expect((await worker.fetch(request('asset-download-url', { organizationId: 'org-1', sampleId: asset.sampleId }), env)).status).toBe(403);
  backend({ 'assets:get': { status: 'error', errorMessage: 'Asset not found', errorData: 'Asset not found' } });
  expect((await worker.fetch(request('asset-download-url', { organizationId: 'org-1', sampleId: asset.sampleId }), env)).status).toBe(404);
});

test('proxy upload signs a PUT at the proxy key, finish checks its size, and download serves the proxy variant', async () => {
  const PROXY_KEY = 'assets/org-1/0123456789abcdef/proxy.mp4';
  const calls = backend({ 'assets:registerProxy': { state: 'uploading', uploadNeeded: true }, 'assets:describe': asset });
  const response = await worker.fetch(request('asset-proxy-upload-url', { assetId: 'asset-1', size: 100 }), env);
  expect(response.status).toBe(200);
  const signed = new URL(((await response.json()) as { uploadUrl: string }).uploadUrl);
  expect(signed.pathname).toBe(`/compound-media-dev/${PROXY_KEY}`);
  expect(calls.find((call) => call.path === 'assets:registerProxy')?.args).toEqual({ assetId: 'asset-1', size: 100 });

  backend({ 'assets:registerProxy': { state: 'ready', uploadNeeded: false } });
  expect((await (await worker.fetch(request('asset-proxy-upload-url', { assetId: 'asset-1', size: 100 }), env)).json()) as unknown).toEqual({ uploadUrl: null });

  const uploading = { ...asset, proxyState: 'uploading', proxySize: 100 };
  const finished = backend({ 'assets:describe': uploading, 'assets:finishProxy': null });
  const ok = await worker.fetch(request('asset-proxy-upload-finish', { assetId: 'asset-1' }), { ...env, MEDIA: { head: async () => ({ size: 100 }) } as unknown as R2Bucket });
  expect((await ok.json()) as unknown).toEqual({ ok: true });
  expect(finished.find((call) => call.path === 'assets:finishProxy')?.args).toEqual({ assetId: 'asset-1', proxyKey: PROXY_KEY });
  backend({ 'assets:describe': uploading, 'assets:finishProxy': null });
  expect((await worker.fetch(request('asset-proxy-upload-finish', { assetId: 'asset-1' }), { ...env, MEDIA: { head: async () => ({ size: 99 }) } as unknown as R2Bucket })).status).toBe(400);

  const lookup = { organizationId: 'org-1', sampleId: asset.sampleId, variant: 'proxy' };
  backend({ 'assets:get': { ...asset, proxyState: 'ready', proxyKey: PROXY_KEY, proxySize: 100 } });
  const download = await worker.fetch(request('asset-download-url', lookup), env);
  expect(download.status).toBe(200);
  const data = (await download.json()) as { url: string; size: number; mimeType: string; name: string };
  expect(data).toMatchObject({ size: 100, mimeType: 'video/mp4', name: '0123456789abcdef.mp4' });
  expect(new URL(data.url).pathname).toBe(`/compound-media-dev/${PROXY_KEY}`);
  backend({ 'assets:get': { ...asset, originalState: 'ready', originalKey: KEY } });
  expect((await worker.fetch(request('asset-download-url', lookup), env)).status).toBe(404);
});
