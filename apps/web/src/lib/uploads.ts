import { mediaRequest, type FileRef } from './media-api';
import { mainBridge } from './ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export async function uploadBlob(blob: Blob): Promise<FileRef> {
  if (!blob.size || blob.size > MAX_UPLOAD_BYTES)
    throw new Error('Prepared media must be between 1 byte and 100 MiB. Choose a shorter clip.');
  if (window.desktop)
    return mainBridge.call(MAIN_CHANNELS.CLOUD_UPLOAD, {
      contentType: blob.type,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
  const { uploadId, uploadUrl } = await mediaRequest<{ uploadId: string; uploadUrl: string }>(
    'upload-url',
    { size: blob.size, contentType: blob.type },
  );
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type },
    body: blob,
    signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) throw new Error('Media upload failed');
  return { uploadId };
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
          throw new Error('Prepared media exceeds 100 MiB. Choose a shorter clip.');
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
