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
type S3Handler = (request: { method: string; url: URL; body: string }) => { status?: number; body?: string };
const s3Calls: { method: string; url: URL; body: string }[] = [];
let s3Handler: S3Handler = () => ({ status: 500, body: '<Error><Message>no S3 fake</Message></Error>' });
function backend(handlers: Handlers, s3?: S3Handler) {
  const calls: { path: string; args: unknown }[] = [];
  s3Calls.length = 0;
  if (s3) s3Handler = s3;
  globalThis.fetch = (async (_url, init) => {
    const url = new URL(_url instanceof Request ? _url.url : String(_url));
    if (url.hostname.endsWith('r2.cloudflarestorage.com')) {
      const body = init?.body ? String(init.body) : _url instanceof Request ? await _url.text() : '';
      const request = { method: (init?.method ?? (_url instanceof Request ? _url.method : 'GET')).toUpperCase(), url, body };
      s3Calls.push(request);
      const reply = s3Handler(request);
      return new Response(reply.body ?? '', { status: reply.status ?? 200 });
    }
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

test('multipart: start creates or resumes an upload, part URLs are signed per part, and complete verifies the object', async () => {
  const KEY_URL = `/compound-media-dev/${KEY}`;
  // Start, with nothing under way: R2 is asked for an upload id, which is recorded on the asset.
  let calls = backend({ 'assets:describe': asset, 'assets:setMultipart': null }, ({ method, url }) =>
    method === 'POST' && url.searchParams.has('uploads') ? { body: '<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>' } : { status: 500 });
  let response = await worker.fetch(request('asset-multipart-start', { assetId: 'asset-1' }), env);
  expect((await response.json()) as unknown).toEqual({ done: false, uploadId: 'up-1', partSize: 64 * 1024 * 1024, parts: [] });
  expect(s3Calls[0]?.url.pathname).toBe(KEY_URL);
  expect(calls.find((call) => call.path === 'assets:setMultipart')?.args).toEqual({ assetId: 'asset-1', uploadId: 'up-1' });

  // Start again with an upload recorded: the parts R2 holds come back, so the client skips them.
  const inFlight = { ...asset, multipartUploadId: 'up-1' };
  backend({ 'assets:describe': inFlight }, ({ method, url }) =>
    method === 'GET' && url.searchParams.get('uploadId') === 'up-1'
      ? { body: '<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag><Size>1000</Size></Part></ListPartsResult>' }
      : { status: 500 });
  response = await worker.fetch(request('asset-multipart-start', { assetId: 'asset-1' }), env);
  expect((await response.json()) as unknown).toEqual({ done: false, uploadId: 'up-1', partSize: 64 * 1024 * 1024, parts: [{ partNumber: 1, etag: '"e1"', size: 1000 }] });

  // A recorded upload R2 no longer knows is replaced.
  calls = backend({ 'assets:describe': inFlight, 'assets:setMultipart': null }, ({ method, url }) =>
    method === 'GET' ? { status: 404, body: '<Error><Code>NoSuchUpload</Code></Error>' }
      : method === 'POST' && url.searchParams.has('uploads') ? { body: '<r><UploadId>up-2</UploadId></r>' } : { status: 500 });
  response = await worker.fetch(request('asset-multipart-start', { assetId: 'asset-1' }), env);
  expect(((await response.json()) as { uploadId: string }).uploadId).toBe('up-2');

  // Part URLs are signed for this upload only, with the part's length bound.
  backend({ 'assets:describe': inFlight });
  response = await worker.fetch(request('asset-multipart-part-url', { assetId: 'asset-1', uploadId: 'up-1', partNumber: 2, size: 500 }), env);
  const signed = new URL(((await response.json()) as { uploadUrl: string }).uploadUrl);
  expect(signed.pathname).toBe(KEY_URL);
  expect(signed.searchParams.get('partNumber')).toBe('2');
  expect(signed.searchParams.get('uploadId')).toBe('up-1');
  expect(signed.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
  expect((await worker.fetch(request('asset-multipart-part-url', { assetId: 'asset-1', uploadId: 'other', partNumber: 2, size: 500 }), env)).status).toBe(409);

  // Complete sends the parts in order, then the object is checked and the asset finished.
  calls = backend({ 'assets:describe': inFlight, 'assets:finish': null }, ({ method, url, body }) =>
    method === 'POST' && url.searchParams.get('uploadId') === 'up-1' && body.includes('<PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag>')
      ? { body: '<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>' } : { status: 500 });
  response = await worker.fetch(request('asset-multipart-complete', { assetId: 'asset-1', uploadId: 'up-1', parts: [{ partNumber: 2, etag: '"e2"' }, { partNumber: 1, etag: '"e1"' }] }), { ...env, MEDIA: { head: async () => ({ size: asset.size }) } as unknown as R2Bucket });
  expect((await response.json()) as unknown).toEqual({ ok: true });
  expect(s3Calls[0]?.body.indexOf('<PartNumber>1</PartNumber>')).toBeLessThan(s3Calls[0]!.body.indexOf('<PartNumber>2</PartNumber>'));
  expect(calls.find((call) => call.path === 'assets:finish')?.args).toEqual({ assetId: 'asset-1', originalKey: KEY });

  // A size that does not match what was declared never finishes the asset.
  calls = backend({ 'assets:describe': inFlight, 'assets:finish': null }, () => ({ body: '<CompleteMultipartUploadResult/>' }));
  expect((await worker.fetch(request('asset-multipart-complete', { assetId: 'asset-1', uploadId: 'up-1', parts: [{ partNumber: 1, etag: '"e1"' }] }), { ...env, MEDIA: { head: async () => ({ size: 1 }) } as unknown as R2Bucket })).status).toBe(400);
  expect(calls.some((call) => call.path === 'assets:finish')).toBe(false);
});
