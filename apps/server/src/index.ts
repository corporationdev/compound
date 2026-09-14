import { DEEPGRAM_MODEL, GEMINI_MODEL } from '@compound/config/models';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@compound/backend/convex/_generated/api';
import { ConvexError } from 'convex/values';
import type { Id } from '@compound/backend/convex/_generated/dataModel';
import { AwsClient } from 'aws4fetch';
import { z } from 'zod';
import { analyze, transcribe } from './providers';
import { CATALOG_OPERATIONS, catalogRequest } from './catalog';
import { SOCIAL_OPERATIONS, SocialError, socialMediaResponse, socialRequest } from './social';
import { MultipartStore, UPLOAD_OPERATIONS, uploadRequest, type UploadOperation } from './upload';
import { HttpError } from './errors';
export interface Env {
  CONVEX_URL: string;
  CORS_ORIGIN: string;
  MEDIA: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID: string;
  MEDIA_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  DEEPGRAM_API_KEY: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
}
const MAX_BYTES = 100 * 1024 * 1024;
const operationSchema = z
  .object({
    uploadId: z.string().min(1).max(100),
    language: z
      .string()
      .regex(/^[a-zA-Z-]{2,20}$/)
      .optional(),
    prompt: z.string().max(12000).optional(),
  })
  .strict();
function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'Invalid request');
  return result.data;
}
function awsClient(env: Env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
}
/** A short-lived signed GET for an object the Worker has already verified. */
async function signedUrl(env: Env, key: string) {
  const url = new URL(
    `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.MEDIA_BUCKET_NAME}/${key}`,
  );
  url.searchParams.set('X-Amz-Expires', '600');
  return (await awsClient(env).sign(url, { method: 'GET', aws: { signQuery: true } })).url;
}
async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'JSON body required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) {
      await reader.cancel();
      throw new HttpError(413, 'Request too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = origin === env.CORS_ORIGIN;
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
      ...(allowed
        ? {
            'Access-Control-Allow-Origin': origin!,
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
          }
        : {}),
    };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    const sign = (key: string) => signedUrl(env, key);
    try {
      const path = new URL(request.url).pathname;
      // Zernio fetches post media here with no session and no browser origin.
      if (path.startsWith('/social/media/') && (request.method === 'GET' || request.method === 'HEAD'))
        return await socialMediaResponse(env, sign, request);
      if (origin && !allowed) throw new HttpError(403, 'Origin not allowed');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (path === '/health' && request.method === 'GET') return json({ ok: true });
      if (!['/media/transcribe', '/media/transcribe-status', '/media/transcribe-cancel', '/media/analyze', ...CATALOG_OPERATIONS.map(operation => `/media/${operation}`), ...SOCIAL_OPERATIONS.map(operation => `/social/${operation}`), ...UPLOAD_OPERATIONS.map(operation => `/upload/${operation}`)].includes(path))
        throw new HttpError(404, 'Not found');
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
      if (!token) throw new HttpError(401, 'Sign in required');
      const client = new ConvexHttpClient(env.CONVEX_URL, { auth: token });
      const user = await client.query(api.auth.getCurrentUser, {}).catch(() => null);
      if (!user) throw new HttpError(401, 'Session expired. Sign in again.');
      const body = await readBody(request);
      if (path.startsWith('/upload/')) {
        try {
          return json(await uploadRequest(client, env, new MultipartStore(env, awsClient(env)), path.slice('/upload/'.length) as UploadOperation, body));
        } catch (error) {
          if (error instanceof z.ZodError) throw new HttpError(400, 'Invalid upload request');
          throw error;
        }
      }
      if (path.startsWith('/social/')) {
        try { return json(await socialRequest(client, sign, path.slice('/social/'.length) as (typeof SOCIAL_OPERATIONS)[number], body)); }
        catch (error) {
          if (error instanceof z.ZodError) throw new HttpError(400, 'Invalid post media request');
          if (error instanceof SocialError) throw new HttpError(error.status, error.message);
          throw error;
        }
      }
      if (path.startsWith('/media/catalog-')) {
        try { return json(await catalogRequest(client, path.slice('/media/'.length), body)); }
        catch (error) {
          if (error instanceof z.ZodError) throw new HttpError(400, 'Invalid library request');
          throw error;
        }
      }
      if (path === '/media/transcribe-status' || path === '/media/transcribe-cancel') {
        const input = parseInput(z.object({ jobId: z.string().min(1).max(100) }).strict(), body);
        const jobId = input.jobId as Id<'transcriptionJobs'>;
        if (path === '/media/transcribe-cancel') {
          await client.mutation(api.transcriptions.cancel, { jobId });
          return json({ ok: true });
        }
        const job = await client.query(api.transcriptions.get, { jobId });
        if (job.status === 'ready' && job.resultKey) {
          const result = await env.MEDIA.get(job.resultKey);
          if (!result) throw new HttpError(410, 'Transcription result expired');
          return json({ status: 'ready', segments: await result.json(), quality: job.quality });
        }
        return json({ status: job.status, stage: job.stage,
          ...(job.error ? { error: 'Transcription failed. Please try again.' } : {}),
        });
      }
      const input = parseInput(operationSchema, body);
      const upload = await client
        .query(api.uploads.get, { id: input.uploadId as Id<'uploads'> })
        .catch(() => null);
      if (!upload) throw new HttpError(404, 'Upload not found or expired');
      const object = await env.MEDIA.head(upload.key);
      if (
        !object ||
        object.size !== upload.size ||
        object.size > MAX_BYTES ||
        object.httpMetadata?.contentType !== upload.contentType
      )
        throw new HttpError(400, 'Upload is incomplete or does not match its declared size/type');
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(240000)]);
      if (path === '/media/transcribe') {
        if (upload.contentType === 'audio/wav') {
          return json(await client.mutation(api.transcriptions.start, { uploadId: upload._id, language: input.language }));
        }
        if (upload.contentType !== 'audio/ogg')
          throw new HttpError(400, 'Transcription requires audio');
        if (!env.DEEPGRAM_API_KEY) throw new HttpError(503, 'Transcription is not configured');
        await client.mutation(api.uploads.claim, { id: upload._id });
        return json({
          segments: await transcribe({
            key: env.DEEPGRAM_API_KEY,
            model: DEEPGRAM_MODEL,
            url: await signedUrl(env, upload.key),
            language: input.language,
            signal,
          }),
        });
      }
      if (!env.GOOGLE_GENERATIVE_AI_API_KEY) throw new HttpError(503, 'Analysis is not configured');
      await client.mutation(api.uploads.claim, { id: upload._id });
      const media = await env.MEDIA.get(upload.key);
      if (!media) throw new HttpError(404, 'Media not found');
      // Workers ignore a manually supplied Content-Length for an arbitrary stream.
      // This stream guarantees the length Gemini's resumable upload expects.
      const sized = new FixedLengthStream(object.size);
      const transferAbort = new AbortController();
      const transfer = media.body.pipeTo(sized.writable, {
        signal: AbortSignal.any([signal, transferAbort.signal]),
      });
      void transfer.catch(() => {});
      try {
        const result = await analyze({
          key: env.GOOGLE_GENERATIVE_AI_API_KEY,
          model: GEMINI_MODEL,
          body: sized.readable as unknown as ReadableStream,
          size: object.size,
          contentType: upload.contentType,
          prompt: input.prompt,
          signal,
        });
        await transfer;
        return json({ result });
      } finally {
        transferAbort.abort();
        await transfer.catch(() => {});
      }
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (
        error instanceof ConvexError &&
        (error.data === 'Media request limit reached' ||
          error.data === 'Upload limit reached. Try again later.')
      )
        return json({ error: error.data }, 429);
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
        return json(
          { error: 'Media request timed out or was cancelled. Try a shorter clip.' },
          504,
        );
      return json({ error: 'Media service request failed. Please try again.' }, 502);
    }
  },
};
