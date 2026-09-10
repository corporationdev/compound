import { test, expect, afterEach } from 'bun:test';
import { readArtifact } from '../lib/transcription/storage';
import { geminiVerbatim, deepgram } from '../lib/transcription/providers';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('Gemini listens independently and filters thought parts before tolerant JSON parsing', async () => {
  let body: any;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { thought: true, text: 'private reasoning' },
              { text: '{"verbatim":"so so— actually"}' },
            ],
          },
        },
      ],
    });
  }) as unknown as typeof fetch;
  expect(await geminiVerbatim('audio-bytes', 'test')).toBe('so so— actually');
  expect(body.contents[0].parts).toHaveLength(2);
  expect(body.contents[0].parts[0].text).toContain('Do not fix grammar');
  expect(body.contents[0].parts[1].inlineData.mimeType).toBe('audio/wav');
});

test('Deepgram retains detected language and filler word options', async () => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get('model')).toBe('nova-3');
    expect(parsed.searchParams.get('filler_words')).toBe('true');
    return Response.json({
      results: {
        channels: [
          {
            detected_language: 'en',
            alternatives: [
              {
                transcript: 'Um.',
                words: [
                  { word: 'um', punctuated_word: 'Um.', start: 0, end: 0.1 },
                ],
              },
            ],
          },
        ],
      },
    });
  }) as unknown as typeof fetch;
  expect(
    await deepgram('https://example.test/source.wav', 'test'),
  ).toMatchObject({
    language: 'en',
    words: [{ text: 'Um.', startUs: 0, endUs: 100000 }],
  });
});

test('R2 artifact reads accept streamed JSON without Content-Length and still enforce a byte limit', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      CLOUDFLARE_ACCOUNT_ID: 'test',
      MEDIA_BUCKET_NAME: 'test',
      R2_ACCESS_KEY_ID: 'test',
      R2_SECRET_ACCESS_KEY: 'test',
    });
    globalThis.fetch = (async () =>
      new Response('{"words":[]}')) as unknown as typeof fetch;
    expect(await readArtifact<{ words: string[] }>('media/test.json')).toEqual({ words: [] });
    globalThis.fetch = (async () =>
      new Response('{}', {
        headers: { 'Content-Length': String(17 * 1024 * 1024) },
      })) as unknown as typeof fetch;
    await expect(readArtifact('media/test.json')).rejects.toThrow('limit');
  } finally {
    for (const key of [
      'CLOUDFLARE_ACCOUNT_ID',
      'MEDIA_BUCKET_NAME',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
