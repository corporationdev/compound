import { UPLOAD_PART_BYTES } from '@compound/config/upload';
import { test, expect, afterEach } from 'bun:test';
import worker, { type Env } from '../src/index';
import { analyze, parseTranscript, transcribe } from '../src/providers';
const rawTranscript = {
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: 'Hello world.',
            words: [
              { word: 'hello', punctuated_word: 'Hello', start: 0, end: 0.4 },
              { word: 'world', punctuated_word: 'world.', start: 0.5, end: 1 },
            ],
          },
        ],
      },
    ],
  },
};
test('Deepgram timestamps and punctuation become local caption segments; silence is empty', async () => {
  expect(parseTranscript(rawTranscript)).toEqual([
    {
      text: 'Hello world.',
      words: [
        { text: 'Hello', start: 0, end: 0.4 },
        { text: 'world.', start: 0.5, end: 1 },
      ],
    },
  ]);
  expect(
    parseTranscript({ results: { channels: [{ alternatives: [{ transcript: '', words: [] }] }] } }),
  ).toEqual([]);
  let request!: Request;
  const result = await transcribe(
    {
      key: 'secret',
      model: 'nova-3',
      url: 'https://storage.example/audio',
      signal: new AbortController().signal,
    },
    (async (url, init) => {
      request = new Request(url, init);
      return Response.json(rawTranscript);
    }) as typeof fetch,
  );
  expect(result[0]!.text).toBe('Hello world.');
  expect(request.headers.get('Authorization')).toBe('Token secret');
  expect((await request.json()) as unknown).toEqual({ url: 'https://storage.example/audio' });
  expect(request.url).toContain('detect_language=true');
});
for (const fail of [false, true])
  test(`Gemini streams media and cleans up its temporary file on ${fail ? 'failure' : 'success'}`, async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const body = new Blob(['media']).stream();
    const fetcher = (async (url, init) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body });
      if (String(url).endsWith('/upload/v1beta/files'))
        return new Response(null, {
          headers: {
            'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload-session',
          },
        });
      if (String(url).endsWith('/upload-session')) {
        expect(init?.body).toBe(body);
        return Response.json({
          file: {
            name: 'files/test',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/test',
            state: 'ACTIVE',
          },
        });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      return fail
        ? new Response('provider secret details', { status: 503 })
        : Response.json({
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'hidden reasoning', thought: true },
                    { text: 'A person speaks.' },
                  ],
                },
              },
            ],
          });
    }) as typeof fetch;
    const result = analyze(
      {
        key: 'secret',
        model: 'configured-model',
        body,
        size: 5,
        contentType: 'video/mp4',
        prompt: 'What is happening?',
        signal: new AbortController().signal,
      },
      fetcher,
    );
    if (fail) await expect(result).rejects.toThrow('Gemini request failed');
    else expect(await result).toBe('A person speaks.');
    expect(calls.at(-1)).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/files/test',
      method: 'DELETE',
    });
    const payload = JSON.parse(
      calls.find((call) => call.url.includes('generateContent'))!.body as string,
    );
    expect(payload.contents[0].parts[1].text).toBe('What is happening?');
  });
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
  DEEPGRAM_API_KEY: 'test',
} as Env;
const request = (path: string, body: unknown, origin?: string, token = 'valid-jwt') =>
  new Request(`https://worker.example/${path.includes('/') ? path : `media/${path}`}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
type Storage = Record<string, (request: Request, body: string) => Response>;
function backend(user: unknown, upload: unknown = null, storage: Storage = {}) {
  const calls: Request[] = [];
  globalThis.fetch = (async (url, init) => {
    // aws4fetch signs a Request object; the Convex client passes url + init.
    const request = url instanceof Request ? url : new Request(url, init);
    const target = new URL(request.url);
    const body = await request.text();
    if (target.hostname.endsWith('r2.cloudflarestorage.com')) {
      calls.push(request);
      const key = `${request.method} ${target.search.split('&X-Amz')[0]}`;
      const handler = Object.entries(storage).find(([pattern]) => key.startsWith(pattern))?.[1];
      return handler ? handler(request, body) : new Response('<Error/>', { status: 500 });
    }
    const input = JSON.parse(body);
    const value = input.path === 'auth:getCurrentUser' ? user : upload;
    return Response.json({ status: 'success', value });
  }) as typeof fetch;
  return calls;
}
test('Worker requires a current session and exact browser origin before any upload', async () => {
  backend(null);
  expect((await worker.fetch(request('upload/begin', {}, undefined, ''), env)).status).toBe(401);
  expect((await worker.fetch(request('upload/begin', {}), env)).status).toBe(401);
  expect((await worker.fetch(request('upload/begin', {}, 'null'), env)).status).toBe(403);
  expect((await worker.fetch(request('upload/begin', {}, 'https://evil.example'), env)).status).toBe(
    403,
  );
  const cors = await worker.fetch(
    new Request('https://worker.example/upload/begin', {
      method: 'OPTIONS',
      headers: { Origin: env.CORS_ORIGIN },
    }),
    env,
  );
  expect(cors.headers.get('Access-Control-Allow-Origin')).toBe(env.CORS_ORIGIN);
  expect((await worker.fetch(request('upload-url', {}), env)).status).toBe(404);
});
test('Worker opens a multipart upload on a server-owned key and signs one URL per part', async () => {
  const size = UPLOAD_PART_BYTES + 1;
  const calls = backend(
    { id: 'owner' },
    { _id: 'owned-id', key: 'media/owned-id', contentType: 'audio/ogg', size },
    { 'POST ?uploads=': () => new Response('<InitiateMultipartUploadResult><UploadId>mp-1</UploadId></InitiateMultipartUploadResult>') },
  );
  const response = await worker.fetch(request('upload/begin', { purpose: 'media', contentType: 'audio/ogg', size }), env);
  expect(response.status).toBe(200);
  const data = (await response.json()) as { id: string; uploadId: string; partSize: number; urls: string[] };
  expect(data).toMatchObject({ id: 'owned-id', uploadId: 'mp-1', partSize: UPLOAD_PART_BYTES });
  expect(data.urls).toHaveLength(2);
  const signed = new URL(data.urls[1]!);
  expect(signed.pathname).toBe('/compound-media-dev/media/owned-id');
  expect(signed.searchParams.get('partNumber')).toBe('2');
  expect(signed.searchParams.get('uploadId')).toBe('mp-1');
  expect(signed.searchParams.get('X-Amz-Expires')).toBe('21600');
  expect(signed.searchParams.has('X-Amz-Signature')).toBe(true);
  expect(new URL(calls[0]!.url).pathname).toBe('/compound-media-dev/media/owned-id');
  expect(calls[0]!.headers.get('Content-Type')).toBe('audio/ogg');
  expect((await worker.fetch(request('upload/begin', { purpose: 'media', contentType: 'audio/ogg', size: 100 * 1024 * 1024 + 1 }), env)).status).toBe(400);
  expect((await worker.fetch(request('upload/begin', { purpose: 'social', kind: 'video', contentType: 'audio/ogg', size: 10 }), env)).status).toBe(400);
  expect((await worker.fetch(request('transcribe', { uploadId: 'owned-id', url: 'https://evil.example' }), env)).status).toBe(400);
  backend({ id: 'owner' });
  expect((await worker.fetch(request('transcribe', { uploadId: 'other-id' }), env)).status).toBe(404);
});
test('Worker completes an upload only when the parts R2 holds add up to the declared size', async () => {
  const size = UPLOAD_PART_BYTES + 1;
  const row = { _id: 'owned-id', key: 'media/owned-id', contentType: 'audio/ogg', size };
  const parts = (sizes: number[]) =>
    `<ListPartsResult>${sizes.map((s, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>&quot;e${i + 1}&quot;</ETag><Size>${s}</Size></Part>`).join('')}</ListPartsResult>`;
  let completed: string | undefined;
  let aborted = 0;
  const storage: Storage = {
    'GET ?uploadId=mp-1': () => new Response(parts([UPLOAD_PART_BYTES, 1])),
    'POST ?uploadId=mp-1': (_request, body) => {
      completed = body;
      return new Response('<CompleteMultipartUploadResult/>');
    },
    'DELETE ?uploadId=': () => {
      aborted++;
      return new Response(null, { status: 204 });
    },
  };
  backend({ id: 'owner' }, row, storage);
  const media = { head: async () => ({ size, httpMetadata: { contentType: 'audio/ogg' } }), delete: async () => {} } as unknown as R2Bucket;
  const ok = await worker.fetch(request('upload/complete', { purpose: 'media', id: 'owned-id', uploadId: 'mp-1' }), { ...env, MEDIA: media });
  expect(ok.status).toBe(200);
  expect(completed).toBe(
    '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag></Part></CompleteMultipartUpload>',
  );
  backend({ id: 'owner' }, row, { ...storage, 'GET ?uploadId=mp-1': () => new Response(parts([UPLOAD_PART_BYTES])) });
  const short = await worker.fetch(request('upload/complete', { purpose: 'media', id: 'owned-id', uploadId: 'mp-1' }), { ...env, MEDIA: media });
  expect(short.status).toBe(400);
  expect(aborted).toBe(1);
  backend({ id: 'owner' }, row, storage);
  const wrongType = { head: async () => ({ size, httpMetadata: { contentType: 'video/mp4' } }), delete: async () => {} } as unknown as R2Bucket;
  expect((await worker.fetch(request('upload/complete', { purpose: 'media', id: 'owned-id', uploadId: 'mp-1' }), { ...env, MEDIA: wrongType })).status).toBe(400);
  expect((await worker.fetch(request('upload/abort', { purpose: 'media', id: 'owned-id', uploadId: 'mp-1' }), { ...env, MEDIA: media })).status).toBe(200);
  expect(aborted).toBe(2);
});
test('Worker refuses incomplete uploads before provider calls', async () => {
  backend(
    { id: 'owner' },
    { _id: 'owned-id', key: 'media/owned-id', contentType: 'audio/ogg', size: 10 },
  );
  const media = {
    head: async () => ({ size: 11, httpMetadata: { contentType: 'audio/ogg' } }),
  } as unknown as R2Bucket;
  expect(
    (await worker.fetch(request('transcribe', { uploadId: 'owned-id' }), { ...env, MEDIA: media }))
      .status,
  ).toBe(400);
});
