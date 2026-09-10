import { test, expect } from 'bun:test';
import { convexTest } from 'convex-test';
import { resolve } from 'node:path';
import schema from '../convex/schema';
import { internal } from '../convex/_generated/api';
import { buildWavBase64 } from '../lib/transcription/audio';

test('replaying provider actions reads their saved artifacts instead of paying for providers again', async () => {
  const originalFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'test',
    MEDIA_BUCKET_NAME: 'test',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
    DEEPGRAM_API_KEY: 'test',
    GOOGLE_GENERATIVE_AI_API_KEY: 'test',
  };
  Object.assign(process.env, env);
  const dir = resolve(import.meta.dirname, '../convex');
  const modules = Object.fromEntries(
    [...new Bun.Glob('**/*.ts').scanSync(dir)].map((path) => [
      `${dir}/${path}`,
      () => import(`${dir}/${path}`),
    ]),
  );
  const t = convexTest(schema, modules);
  const wav = Buffer.from(
    buildWavBase64(new Uint8Array(32000), 0, 1e6),
    'base64',
  );
  const artifacts = new Map<string, string>();
  let deepgramCalls = 0,
    geminiCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = new URL(String(url));
    if (address.hostname === 'api.deepgram.com') {
      deepgramCalls++;
      return Response.json({
        results: {
          channels: [
            {
              detected_language: 'en',
              alternatives: [
                {
                  transcript: 'Hello.',
                  words: [
                    {
                      word: 'hello',
                      punctuated_word: 'Hello.',
                      start: 0,
                      end: 1,
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
    }
    if (address.hostname === 'generativelanguage.googleapis.com') {
      geminiCalls++;
      return Response.json({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: '{"verbatim":"Hello."}' }] },
          },
        ],
      });
    }
    if (init?.method === 'HEAD')
      return new Response(null, {
        headers: {
          'Content-Length': String(wav.length),
          'Content-Type': 'audio/wav',
        },
      });
    if (init?.method === 'PUT') {
      artifacts.set(address.pathname, String(init.body));
      return new Response(null);
    }
    const range = new Headers(init?.headers).get('Range');
    if (range) {
      const match = /bytes=(\d+)-(\d+)/.exec(range)!;
      const bytes = wav.subarray(Number(match[1]), Number(match[2]) + 1);
      return new Response(bytes, {
        status: 206,
        headers: {
          'Content-Length': String(bytes.length),
          'Content-Range': `${range.replace('=', ' ')}/${wav.length}`,
        },
      });
    }
    const artifact = artifacts.get(address.pathname);
    return artifact
      ? new Response(artifact)
      : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  try {
    const jobId = await t.run(async (ctx) => {
      const uploadId = await ctx.db.insert('uploads', {
        ownerId: 'owner',
        key: 'media/audio',
        size: wav.length,
        contentType: 'audio/wav',
        calls: 1,
        expiresAt: Date.now() + 60000,
      });
      return await ctx.db.insert('transcriptionJobs', {
        ownerId: 'owner',
        uploadId,
        options: 'test',
        attempt: 1,
        status: 'running',
        stage: 'transcribing',
        updatedAt: Date.now(),
        expiresAt: Date.now() + 60000,
      });
    });
    const args = { jobId, attempt: 1 };
    expect(await t.action(internal.asset_transcription.prepare, args)).toEqual({
      enhance: true,
      pieces: 1,
    });
    await t.action(internal.asset_transcription.prepare, args);
    await t.action(internal.asset_transcription.correctPiece, {
      ...args,
      index: 0,
    });
    await t.action(internal.asset_transcription.correctPiece, {
      ...args,
      index: 0,
    });
    expect(deepgramCalls).toBe(1);
    expect(geminiCalls).toBe(1);
    expect(await t.action(internal.asset_transcription.mergeWords, args)).toBe(
      1,
    );
    await t.action(internal.asset_transcription.mergeWords, args);
    expect(geminiCalls).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(env)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});
