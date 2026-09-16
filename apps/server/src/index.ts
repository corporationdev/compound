import { DEEPGRAM_MODEL, GEMINI_MODEL } from '@compound/config/models';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@compound/backend/convex/_generated/api';
import { originalKeyFor, proxyKeyFor, PROXY_MIME_TYPE } from '@compound/backend/assets-key';
import { ConvexError } from 'convex/values';
import type { Id } from '@compound/backend/convex/_generated/dataModel';
import { AwsClient } from 'aws4fetch';
import { z } from 'zod';
import { analyze, transcribe } from './providers';
import { CATALOG_OPERATIONS, catalogRequest } from './catalog';
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
// Library originals are whole source files; R2 takes up to 5 GiB in one PUT.
const MAX_ASSET_BYTES = 4 * 1024 * 1024 * 1024;
const ASSET_OPERATIONS = ['asset-upload-url', 'asset-upload-finish', 'asset-download-url', 'asset-proxy-upload-url', 'asset-proxy-upload-finish'] as const;
const organizationId = z.string().min(1).max(100);
const sampleId = z.string().regex(/^[0-9a-f]{16}$/);
const assetRegisterSchema = z
  .object({
    organizationId,
    sampleId,
    size: z.number().int().min(1).max(MAX_ASSET_BYTES),
    // Parameters (`; codecs="…"`) are dropped: the object is signed and
    // served by its type alone.
    mimeType: z
      .string()
      .transform((type) => type.split(';')[0]!.trim().toLowerCase())
      .pipe(z.string().regex(/^[\w.+-]+\/[\w.+-]+$/)),
    name: z.string().min(1).max(255).refine((name) => !/[/\\\0]/.test(name)),
  })
  .strict();
const assetFinishSchema = z
  .object({ assetId: z.string().min(1).max(100).transform((id) => id as Id<'assets'>) })
  .strict();
const assetLookupSchema = z
  .object({ organizationId, sampleId, variant: z.enum(['original', 'proxy']).default('original') })
  .strict();
const proxyRegisterSchema = z
  .object({
    assetId: z.string().min(1).max(100).transform((id) => id as Id<'assets'>),
    size: z.number().int().min(1).max(MAX_ASSET_BYTES),
  })
  .strict();
const uploadSchema = z
  .object({
    size: z.number().int().min(1).max(MAX_BYTES),
    contentType: z.enum(['audio/ogg', 'audio/wav', 'video/mp4']),
  })
  .strict();
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
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || 'body'))];
    throw new HttpError(400, `Invalid request: ${fields.join(', ')}`);
  }
  return result.data;
}
async function signedUrl(
  env: Env,
  key: string,
  method: 'PUT' | 'GET',
  contentType?: string,
  size?: number,
) {
  const signer = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const url = new URL(
    `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.MEDIA_BUCKET_NAME}/${key}`,
  );
  url.searchParams.set('X-Amz-Expires', method === 'PUT' ? '900' : '600');
  return (
    await signer.sign(url, {
      method,
      ...(contentType
        ? { headers: { 'Content-Type': contentType, 'Content-Length': String(size) } }
        : {}),
      aws: { signQuery: true, allHeaders: true },
    })
  ).url;
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
    try {
      if (origin && !allowed) throw new HttpError(403, 'Origin not allowed');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET') return json({ ok: true });
      if (!['/media/upload-url', '/media/transcribe', '/media/transcribe-status', '/media/transcribe-cancel', '/media/analyze', ...CATALOG_OPERATIONS.map(operation => `/media/${operation}`), ...ASSET_OPERATIONS.map(operation => `/media/${operation}`)].includes(path))
        throw new HttpError(404, 'Not found');
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
      if (!token) throw new HttpError(401, 'Sign in required');
      const client = new ConvexHttpClient(env.CONVEX_URL, { auth: token });
      const user = await client.query(api.auth.getCurrentUser, {}).catch(() => null);
      if (!user) throw new HttpError(401, 'Session expired. Sign in again.');
      const body = await readBody(request);
      if (path.startsWith('/media/catalog-')) {
        try { return json(await catalogRequest(client, path.slice('/media/'.length), body)); }
        catch (error) {
          if (error instanceof z.ZodError) throw new HttpError(400, 'Invalid library request');
          throw error;
        }
      }
      if (path === '/media/asset-upload-url') {
        const input = parseInput(assetRegisterSchema, body);
        const registered = await client.mutation(api.assets.register, input);
        if (registered.state === 'ready') return json({ assetId: registered.assetId, uploadUrl: null });
        // The key is the asset's identity (organization, sample, name) as the
        // backend recorded it, never the caller's spelling of it.
        const asset = await client.query(api.assets.describe, { assetId: registered.assetId });
        return json({
          assetId: asset._id,
          uploadUrl: await signedUrl(env, originalKeyFor(asset), 'PUT', asset.mimeType, asset.size),
        });
      }
      if (path === '/media/asset-upload-finish') {
        const { assetId } = parseInput(assetFinishSchema, body);
        const asset = await client.query(api.assets.describe, { assetId });
        const key = originalKeyFor(asset);
        if (asset.originalState !== 'ready') {
          const object = await env.MEDIA.head(key);
          if (!object) throw new HttpError(400, `Upload not found in the bucket at ${key}`);
          if (object.size !== asset.size)
            throw new HttpError(400, `Upload is ${object.size} bytes but the asset was declared as ${asset.size}`);
          await client.mutation(api.assets.finish, { assetId, originalKey: key });
        }
        return json({ ok: true });
      }
      if (path === '/media/asset-proxy-upload-url') {
        const input = parseInput(proxyRegisterSchema, body);
        const registered = await client.mutation(api.assets.registerProxy, input);
        if (registered.state === 'ready') return json({ uploadUrl: null });
        const asset = await client.query(api.assets.describe, { assetId: input.assetId });
        return json({ uploadUrl: await signedUrl(env, proxyKeyFor(asset), 'PUT', PROXY_MIME_TYPE, input.size) });
      }
      if (path === '/media/asset-proxy-upload-finish') {
        const { assetId } = parseInput(assetFinishSchema, body);
        const asset = await client.query(api.assets.describe, { assetId });
        if (asset.proxyState !== 'ready') {
          const key = proxyKeyFor(asset);
          const object = await env.MEDIA.head(key);
          if (!object) throw new HttpError(400, `Proxy upload not found in the bucket at ${key}`);
          if (object.size !== asset.proxySize)
            throw new HttpError(400, `Proxy upload is ${object.size} bytes but was declared as ${asset.proxySize}`);
          await client.mutation(api.assets.finishProxy, { assetId, proxyKey: key });
        }
        return json({ ok: true });
      }
      if (path === '/media/asset-download-url') {
        const { variant, ...lookup } = parseInput(assetLookupSchema, body);
        const asset = await client.query(api.assets.get, lookup);
        if (!asset) throw new HttpError(404, 'Original not available');
        if (variant === 'proxy') {
          if (asset.proxyState !== 'ready' || !asset.proxyKey || !asset.proxySize)
            throw new HttpError(404, 'Proxy not available');
          return json({
            url: await signedUrl(env, asset.proxyKey, 'GET'),
            size: asset.proxySize,
            mimeType: PROXY_MIME_TYPE,
            name: `${asset.sampleId}.mp4`,
          });
        }
        if (asset.originalState !== 'ready' || !asset.originalKey)
          throw new HttpError(404, 'Original not available');
        return json({
          url: await signedUrl(env, asset.originalKey, 'GET'),
          size: asset.size,
          mimeType: asset.mimeType,
          name: asset.name,
        });
      }
      if (path === '/media/upload-url') {
        const upload = await client.mutation(api.uploads.create, parseInput(uploadSchema, body));
        if (!upload) throw new Error('Could not register upload');
        return json({
          uploadId: upload._id,
          uploadUrl: await signedUrl(env, upload.key, 'PUT', upload.contentType, upload.size),
        });
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
            url: await signedUrl(env, upload.key, 'GET'),
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
      if (error instanceof ConvexError && error.data === 'Not a member of this organization')
        return json({ error: error.data }, 403);
      if (error instanceof ConvexError && (error.data === 'Project not found' || error.data === 'Asset not found'))
        return json({ error: error.data }, 404);
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
