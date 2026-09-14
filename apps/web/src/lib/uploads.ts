import { getToken } from './auth-client';
import type { FileRef } from './media-api';
import { uploadToCloud } from './upload';
import {
  MAX_AUDIO_BYTES,
  TRANSCRIPTION_VERSION,
} from '@compound/config/transcription';
export const MAX_UPLOAD_BYTES = MAX_AUDIO_BYTES;
const MEDIA_TYPES = ['audio/ogg', 'audio/wav', 'video/mp4'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];
export async function uploadBlob(
  blob: Blob,
  cacheScope = '',
): Promise<FileRef> {
  if (!blob.size || blob.size > MAX_UPLOAD_BYTES)
    throw new Error(
      'Prepared media must be between 1 byte and 100 MiB. Choose a shorter clip.',
    );
  if (!(MEDIA_TYPES as readonly string[]).includes(blob.type))
    throw new Error('Unsupported upload. Use WAV/Ogg audio or MP4 video.');
  const token = await getToken();
  if (!token) throw new Error('Sign in required');
  // Re-encoding the same PCM after a reload rejoins the existing upload/job.
  // Only an upload reference is cached; ownership is rechecked by the server.
  let cacheKey: string | undefined;
  if (blob.type === 'audio/wav') {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      const claims = JSON.parse(
        atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')),
      );
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      cacheKey = `compound:transcription:${TRANSCRIPTION_VERSION}:${cacheScope}:${claims.iss}:${claims.sub}:${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`;
      const cached = JSON.parse(localStorage.getItem(cacheKey) ?? 'null');
      if (
        cached &&
        typeof cached.uploadId === 'string' &&
        cached.expiresAt > Date.now()
      )
        return { uploadId: cached.uploadId };
    } catch {
      /* Storage may be disabled; uploading still works. */
    }
  }
  const file: FileRef = {
    uploadId: await uploadToCloud({ purpose: 'media', contentType: blob.type as MediaType }, { blob }),
  };
  if (cacheKey) {
    try {
      localStorage.setItem(
        cacheKey,
        JSON.stringify({
          ...file,
          expiresAt: Date.now() + 23 * 60 * 60 * 1000,
        }),
      );
    } catch {
      /* A full cache must not prevent caption generation. */
    }
  }
  return file;
}

/** Collect bounded encoded chunks while the encoder runs. Errors cancel the producer. */
export async function collectEncodedMedia(
  readable: ReadableStream<Uint8Array<ArrayBuffer>>,
  run: (() => Promise<void>) | undefined,
  contentType: string,
): Promise<Blob> {
  const reader = readable.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const collect = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_UPLOAD_BYTES)
          throw new Error(
            'Prepared media exceeds 100 MiB. Choose a shorter clip.',
          );
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    }
  };
  try {
    await Promise.all([
      collect(),
      Promise.resolve()
        .then(() => run?.())
        .catch(async (error) => {
          await reader.cancel(error).catch(() => {});
          throw error;
        }),
    ]);
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: contentType });
}
