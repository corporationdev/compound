import { getToken } from './auth-client';
import { mediaRequest, type FileRef } from './media-api';
import { mainBridge } from './ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import {
  MAX_AUDIO_BYTES,
  TRANSCRIPTION_VERSION,
} from '@compound/config/transcription';
export const MAX_UPLOAD_BYTES = MAX_AUDIO_BYTES;
export async function uploadBlob(
  blob: Blob,
  cacheScope = '',
): Promise<FileRef> {
  if (!blob.size || blob.size > MAX_UPLOAD_BYTES)
    throw new Error(
      'Prepared media must be between 1 byte and 100 MiB. Choose a shorter clip.',
    );
  const token = await getToken();
  if (!token) throw new Error('Sign in required');
  const bytes =
    blob.type === 'audio/wav' || window.desktop
      ? new Uint8Array(await blob.arrayBuffer())
      : undefined;
  // Re-encoding the same PCM after a reload rejoins the existing upload/job.
  // Only an upload reference is cached; ownership is rechecked by the server.
  let cacheKey: string | undefined;
  if (blob.type === 'audio/wav' && bytes) {
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
  let file: FileRef;
  if (window.desktop) {
    file = await mainBridge.call(MAIN_CHANNELS.CLOUD_UPLOAD, {
      token,
      contentType: blob.type,
      bytes: bytes!,
    });
  } else {
    const { uploadId, uploadUrl } = await mediaRequest<{
      uploadId: string;
      uploadUrl: string;
    }>('upload-url', { size: blob.size, contentType: blob.type });
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type },
      body: blob,
      signal: AbortSignal.timeout(240000),
    });
    if (!response.ok) throw new Error('Media upload failed');
    file = { uploadId };
  }
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
