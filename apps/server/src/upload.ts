import { api } from '@compound/backend/convex/_generated/api';
import type { Id } from '@compound/backend/convex/_generated/dataModel';
import { UPLOAD_LIMITS, UPLOAD_PART_BYTES, UPLOAD_URL_TTL_SECONDS, planParts, type UploadBegin, type UploadPurpose } from '@compound/config/upload';
import type { AwsClient } from 'aws4fetch';
import { ConvexError } from 'convex/values';
import type { ConvexHttpClient } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { z } from 'zod';
import { HttpError } from './errors';

// One upload flow for every object a client writes to R2. The Worker keeps
// the bucket credentials: it registers the row with Convex for the purpose,
// opens an S3 multipart upload, signs each part, and completes the upload
// itself after listing the parts R2 received. The client never sees a key,
// an ETag, or a credential, and cannot finish an object of the wrong size.

export const UPLOAD_OPERATIONS = ['begin', 'complete', 'abort'] as const;
export type UploadOperation = (typeof UPLOAD_OPERATIONS)[number];

const size = (purpose: UploadPurpose) => z.number().int().min(1).max(UPLOAD_LIMITS[purpose]);
const beginSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('media'), size: size('media'), contentType: z.enum(['audio/ogg', 'audio/wav', 'video/mp4']) }).strict(),
  z
    .object({ purpose: z.literal('library'), size: size('library'), kind: z.enum(['music', 'sfx']), title: z.string().min(1).max(160), mimeType: z.string().min(1).max(100) })
    .strict(),
  z
    .object({
      purpose: z.literal('social'),
      size: size('social'),
      kind: z.enum(['video', 'cover']),
      contentType: z.enum(['video/mp4', 'image/jpeg', 'image/png']),
      durationMs: z.number().int().min(0).optional(),
      width: z.number().int().min(1).max(16384).optional(),
      height: z.number().int().min(1).max(16384).optional(),
      projectId: z.string().min(1).max(100).optional(),
      projectName: z.string().min(1).max(200).optional(),
      sceneId: z.string().min(1).max(200).optional(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })
    .strict(),
]);
const finishSchema = z
  .object({ purpose: z.enum(['media', 'library', 'social']), id: z.string().min(1).max(100), uploadId: z.string().min(1).max(1024) })
  .strict();

type Target = { key: string; size: number; contentType: string };
type Purpose = {
  register: (client: ConvexHttpClient, input: Record<string, unknown>) => Promise<{ id: string } & Target>;
  target: (client: ConvexHttpClient, id: string) => Promise<Target>;
  finish?: (client: ConvexHttpClient, id: string) => Promise<unknown>;
};
const PURPOSES: Record<UploadPurpose, Purpose> = {
  media: {
    async register(client, input) {
      const row = await client.mutation(api.uploads.create, { contentType: input.contentType as string, size: input.size as number });
      if (!row) throw new Error('Could not register upload');
      return { id: row._id, key: row.key, size: row.size, contentType: row.contentType };
    },
    target: (client, id) => client.query(api.uploads.get, { id: id as Id<'uploads'> }),
  },
  library: {
    async register(client, input) {
      const { sourceId, key } = await client.mutation(api.catalog.createUpload, {
        title: input.title as string,
        kind: input.kind as 'music' | 'sfx',
        size: input.size as number,
        mimeType: input.mimeType as string,
      });
      return { id: sourceId, key, size: input.size as number, contentType: input.mimeType as string };
    },
    target: (client, id) => client.query(api.catalog.uploadTarget, { sourceId: id as Id<'catalogSources'> }),
    finish: (client, id) => client.mutation(api.catalog.finishUpload, { sourceId: id as Id<'catalogSources'> }),
  },
  social: {
    async register(client, input) {
      const { purpose: _purpose, ...args } = input;
      const row = await client.mutation(api.social_media.create, args as FunctionArgs<typeof api.social_media.create>);
      return { id: row._id, key: row.key, size: row.size, contentType: row.contentType };
    },
    target: (client, id) => client.query(api.social_media.get, { id: id as Id<'socialMedia'> }),
    finish: (client, id) => client.mutation(api.social_media.markReady, { id: id as Id<'socialMedia'> }),
  },
};

export type UploadEnv = { MEDIA: R2Bucket; CLOUDFLARE_ACCOUNT_ID: string; MEDIA_BUCKET_NAME: string };

/** The S3 side of one object: multipart create/list/complete/abort plus signed part URLs. */
export class MultipartStore {
  private readonly env: UploadEnv;
  private readonly signer: AwsClient;
  constructor(env: UploadEnv, signer: AwsClient) {
    this.env = env;
    this.signer = signer;
  }
  private url(key: string, query: Record<string, string>) {
    const url = new URL(`https://${this.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${this.env.MEDIA_BUCKET_NAME}/${key}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }
  private async call(method: string, url: URL, init: { headers?: Record<string, string>; body?: string } = {}) {
    const response = await this.signer.fetch(url.toString(), { method, ...init, signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    if (!response.ok) throw new HttpError(502, `Storage request failed (${response.status})`);
    return text;
  }
  async create(key: string, contentType: string): Promise<string> {
    const xml = await this.call('POST', this.url(key, { uploads: '' }), { headers: { 'Content-Type': contentType } });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
    if (!uploadId) throw new HttpError(502, 'Storage did not start the upload');
    return decodeXml(uploadId);
  }
  async signPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    const url = this.url(key, { partNumber: String(partNumber), uploadId, 'X-Amz-Expires': String(UPLOAD_URL_TTL_SECONDS) });
    return (await this.signer.sign(url.toString(), { method: 'PUT', aws: { signQuery: true } })).url;
  }
  async listParts(key: string, uploadId: string): Promise<{ partNumber: number; etag: string; size: number }[]> {
    const xml = await this.call('GET', this.url(key, { uploadId, 'max-parts': '1000' }));
    const parts: { partNumber: number; etag: string; size: number }[] = [];
    for (const part of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      const field = (name: string) => new RegExp(`<${name}>([^<]*)<\\/${name}>`).exec(part[1]!)?.[1];
      const partNumber = Number(field('PartNumber'));
      const etag = field('ETag');
      const size = Number(field('Size'));
      if (!Number.isInteger(partNumber) || !etag || !Number.isInteger(size)) throw new HttpError(502, 'Storage returned an unreadable part list');
      parts.push({ partNumber, etag: decodeXml(etag), size });
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }
  async complete(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    const body = `<CompleteMultipartUpload>${parts
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${encodeXml(p.etag)}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`;
    const xml = await this.call('POST', this.url(key, { uploadId }), { headers: { 'Content-Type': 'application/xml' }, body });
    // S3 may answer 200 with an error document.
    if (/<Error>/.test(xml)) throw new HttpError(502, 'Storage could not assemble the upload');
  }
  async abort(key: string, uploadId: string): Promise<void> {
    await this.call('DELETE', this.url(key, { uploadId })).catch(() => {});
  }
}
const decodeXml = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const encodeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function convex<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConvexError && typeof error.data === 'string') throw new HttpError(400, error.data);
    throw error;
  }
}

export async function uploadRequest(
  client: ConvexHttpClient,
  env: UploadEnv,
  store: MultipartStore,
  operation: UploadOperation,
  body: unknown,
): Promise<unknown> {
  if (operation === 'begin') {
    const input = beginSchema.parse(body);
    const purpose = PURPOSES[input.purpose];
    const row = await convex(() => purpose.register(client, input));
    const parts = planParts(row.size, UPLOAD_PART_BYTES);
    const uploadId = await store.create(row.key, row.contentType);
    const urls = await Promise.all(parts.map((_, i) => store.signPart(row.key, uploadId, i + 1)));
    const result: UploadBegin = { id: row.id, uploadId, partSize: UPLOAD_PART_BYTES, urls };
    return result;
  }
  const input = finishSchema.parse(body);
  const purpose = PURPOSES[input.purpose];
  const target = await convex(() => purpose.target(client, input.id)).catch((error) => {
    if (error instanceof HttpError && error.status === 400) throw new HttpError(404, error.message);
    throw error;
  });
  if (operation === 'abort') {
    await store.abort(target.key, input.uploadId);
    return { ok: true };
  }
  const expected = planParts(target.size, UPLOAD_PART_BYTES);
  const parts = await store.listParts(target.key, input.uploadId);
  const matches =
    parts.length === expected.length && parts.every((part, i) => part.partNumber === i + 1 && part.size === expected[i]!.end - expected[i]!.start);
  if (!matches) {
    await store.abort(target.key, input.uploadId);
    throw new HttpError(400, 'Upload is incomplete or does not match its declared size');
  }
  await store.complete(target.key, input.uploadId, parts);
  const object = await env.MEDIA.head(target.key);
  if (!object || object.size !== target.size || object.httpMetadata?.contentType !== target.contentType) {
    await env.MEDIA.delete(target.key).catch(() => {});
    throw new HttpError(400, 'Upload does not match its declared size/type');
  }
  if (purpose.finish) await convex(() => purpose.finish!(client, input.id));
  return { ok: true };
}
