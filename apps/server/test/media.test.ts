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
  new Request(`https://worker.example/media/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
function backend(user: unknown, upload: unknown = null) {
  globalThis.fetch = (async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    const value = input.path === 'auth:getCurrentUser' ? user : upload;
    return Response.json({ status: 'success', value });
  }) as typeof fetch;
}
test('Worker requires a current session and exact browser origin before any upload', async () => {
  backend(null);
  expect((await worker.fetch(request('upload-url', {}, undefined, ''), env)).status).toBe(401);
  expect((await worker.fetch(request('upload-url', {}), env)).status).toBe(401);
  expect((await worker.fetch(request('upload-url', {}, 'null'), env)).status).toBe(403);
  expect((await worker.fetch(request('upload-url', {}, 'https://evil.example'), env)).status).toBe(
    403,
  );
  const cors = await worker.fetch(
    new Request('https://worker.example/media/upload-url', {
      method: 'OPTIONS',
      headers: { Origin: env.CORS_ORIGIN },
    }),
    env,
  );
  expect(cors.headers.get('Access-Control-Allow-Origin')).toBe(env.CORS_ORIGIN);
});
test('Worker signs server-owned keys, binds declared bytes/type and rejects arbitrary references', async () => {
  backend(
    { id: 'owner' },
    { _id: 'owned-id', key: 'media/owned-id', contentType: 'audio/ogg', size: 10 },
  );
  const response = await worker.fetch(
    request('upload-url', { contentType: 'audio/ogg', size: 10 }),
    env,
  );
  expect(response.status).toBe(200);
  const data = (await response.json()) as { uploadUrl: string; uploadId: string };
  const signed = new URL(data.uploadUrl);
  expect(signed.pathname).toBe('/compound-media-dev/media/owned-id');
  expect(signed.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
  expect(data.uploadId).toBe('owned-id');
  expect(
    (
      await worker.fetch(
        request('upload-url', { contentType: 'audio/ogg', size: 100 * 1024 * 1024 + 1 }),
        env,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await worker.fetch(
        request('transcribe', { uploadId: 'owned-id', url: 'https://evil.example' }),
        env,
      )
    ).status,
  ).toBe(400);
  backend({ id: 'owner' });
  expect((await worker.fetch(request('transcribe', { uploadId: 'other-id' }), env)).status).toBe(
    404,
  );
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
