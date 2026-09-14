// Every byte that leaves a client for R2 goes through one multipart flow:
// the Worker registers the object with Convex, opens an S3 multipart upload
// and signs one URL per part; the client PUTs parts with per-part retry and
// asks the Worker to complete. Small files are simply one part, so there is
// a single code path to keep correct.

/**
 * R2's minimum part size. Parts are kept this small on purpose: on a flaky
 * link a large PUT is far more likely to be reset mid-body, and a failed part
 * costs a full retry of its bytes.
 */
export const UPLOAD_PART_BYTES = 5 * 1024 * 1024;
/** Per-part attempts. Measured against R2 from a VPN-heavy machine, single attempts failed about half the time. */
export const UPLOAD_PART_ATTEMPTS = 8;
/** Parts in flight at once; more parallel bodies made resets more frequent in the same measurements. */
export const UPLOAD_CONCURRENCY = 2;
/** Signed part URLs stay valid this long; an upload slower than this fails. */
export const UPLOAD_URL_TTL_SECONDS = 6 * 60 * 60;
export const UPLOAD_MAX_PARTS = 1000;

export const UPLOAD_LIMITS = {
  /** Transcription and analysis inputs, `media/` prefix, 24h lifecycle. */
  media: 100 * 1024 * 1024,
  /** Library audio, `library-staging/` prefix, 24h lifecycle. */
  library: 100 * 1024 * 1024,
  /** Post videos and covers, `social/` prefix, long lifecycle. */
  social: 300 * 1024 * 1024,
} as const;
export type UploadPurpose = keyof typeof UPLOAD_LIMITS;

/** What the client sends to `/upload/begin`; `size` is added by the uploader. */
export type UploadRequest =
  | { purpose: 'media'; contentType: 'audio/ogg' | 'audio/wav' | 'video/mp4' }
  | { purpose: 'library'; kind: 'music' | 'sfx'; title: string; mimeType: string }
  | {
      purpose: 'social';
      kind: 'video' | 'cover';
      contentType: 'video/mp4' | 'image/jpeg' | 'image/png';
      durationMs?: number;
      width?: number;
      height?: number;
      projectId?: string;
      projectName?: string;
      sceneId?: string;
      /** Render-input hash; lets the backend reuse an identical upload. */
      contentHash?: string;
    };

export type UploadBegin = {
  /** The purpose's own row id (uploads, catalogSources or socialMedia). */
  id: string;
  uploadId: string;
  partSize: number;
  /** One signed PUT URL per part, in part order. */
  urls: string[];
};
export type UploadProgress = { sent: number; total: number };

export function planParts(size: number, partSize = UPLOAD_PART_BYTES): { start: number; end: number }[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('Upload is empty');
  const count = Math.ceil(size / partSize);
  if (count > UPLOAD_MAX_PARTS) throw new Error('Upload is too large');
  return Array.from({ length: count }, (_, i) => ({ start: i * partSize, end: Math.min(size, (i + 1) * partSize) }));
}

export class UploadError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UploadError';
    this.retryable = retryable;
  }
}

/** The message of an error including its `cause`, so "fetch failed" is never all we know. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const inner = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  return inner && !error.message.includes(inner) ? `${error.message}: ${inner}` : error.message;
}

export type MultipartIo = {
  /** POST to the Worker's `/upload/<operation>` and return its JSON body. */
  request: (operation: 'begin' | 'complete' | 'abort', body: Record<string, unknown>) => Promise<unknown>;
  /** Bytes for `[start, end)` of the source. */
  read: (start: number, end: number) => Promise<Uint8Array | Blob>;
  /**
   * PUT one part. Resolve on 2xx; throw `UploadError` with `retryable` for
   * network errors, 429 and 5xx. `onBytes` may report bytes sent so far.
   */
  put: (url: string, body: Uint8Array | Blob, onBytes: (sent: number) => void, signal: AbortSignal) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

export type MultipartOptions = {
  size: number;
  request: UploadRequest;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  concurrency?: number;
  attempts?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Upload one object and return the purpose's row id. Parts run `concurrency`
 * at a time; each part retries with backoff; the whole thing aborts on
 * `signal`, telling the Worker to discard the partial object.
 */
export async function runMultipartUpload(io: MultipartIo, options: MultipartOptions): Promise<string> {
  const { size, signal } = options;
  const limit = UPLOAD_LIMITS[options.request.purpose];
  if (!Number.isSafeInteger(size) || size < 1) throw new UploadError('The file is empty', false);
  if (size > limit) throw new UploadError(`The file is larger than ${Math.round(limit / 1024 / 1024)} MiB`, false);
  signal?.throwIfAborted();

  const begin = (await io.request('begin', { ...options.request, size })) as UploadBegin;
  const parts = planParts(size, begin.partSize);
  if (begin.urls.length !== parts.length) throw new UploadError('The upload plan does not match the file', false);

  const sent = new Array<number>(parts.length).fill(0);
  const report = () => options.onProgress?.({ sent: sent.reduce((a, b) => a + b, 0), total: size });
  report();

  const controller = new AbortController();
  const abortAll = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortAll, { once: true });
  const attempts = options.attempts ?? UPLOAD_PART_ATTEMPTS;
  const sleep = io.sleep ?? defaultSleep;

  const uploadPart = async (index: number) => {
    const { start, end } = parts[index]!;
    for (let attempt = 1; ; attempt++) {
      controller.signal.throwIfAborted();
      try {
        const body = await io.read(start, end);
        await io.put(
          begin.urls[index]!,
          body,
          (bytes) => {
            sent[index] = Math.min(bytes, end - start);
            report();
          },
          controller.signal,
        );
        sent[index] = end - start;
        report();
        return;
      } catch (error) {
        sent[index] = 0;
        report();
        if (controller.signal.aborted) throw error;
        const retryable = error instanceof UploadError ? error.retryable : true;
        if (!retryable || attempt >= attempts) throw error;
        await sleep(Math.min(10_000, 500 * 2 ** (attempt - 1)));
      }
    }
  };

  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? UPLOAD_CONCURRENCY, parts.length)) }, async () => {
    while (next < parts.length) await uploadPart(next++);
  });
  try {
    await Promise.all(workers);
    controller.signal.throwIfAborted();
    await io.request('complete', { purpose: options.request.purpose, id: begin.id, uploadId: begin.uploadId });
    return begin.id;
  } catch (error) {
    const cancelled = signal?.aborted ?? false;
    abortAll();
    await io.request('abort', { purpose: options.request.purpose, id: begin.id, uploadId: begin.uploadId }).catch(() => {});
    // Surface the caller's own cancellation reason rather than whichever part failed first.
    throw cancelled ? (signal!.reason ?? error) : error;
  } finally {
    signal?.removeEventListener('abort', abortAll);
  }
}
