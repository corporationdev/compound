/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Every upload from the desktop app leaves through here: rendered files are
// read from disk part by part, so a 300 MiB post video never sits in
// renderer or main-process memory; bytes the renderer already holds (an
// audio extraction, a picked library file) are sliced the same way. The
// shared multipart core owns retry, concurrency and cancellation.

import { open, type FileHandle } from 'node:fs/promises';

import { UploadError, describeError, runMultipartUpload, type UploadProgress, type UploadRequest } from '@compound/config/upload';

import { cloudConfig } from './cloud';

export type CloudUploadSource = { path: string } | { bytes: Uint8Array };
export type CloudUploadRequest = {
  /** Renderer-chosen id that ties progress events and cancellation to this call. */
  uploadId: string;
  request: UploadRequest;
  source: CloudUploadSource;
  token: string | null;
};
export type CloudUploadProgress = { uploadId: string } & UploadProgress;
export type CloudUploadResult = { id: string; size: number };

const active = new Map<string, AbortController>();

export function cancelCloudUpload(uploadId: string): void {
  active.get(uploadId)?.abort(new Error('Upload cancelled'));
}

/**
 * `fetchImpl` should be Electron's `net.fetch` in the real app: Chromium's
 * network stack completed large PUTs to R2 far more often than Node's fetch
 * on the same flaky link (8/9 vs 3/8 in measurements), and the per-part
 * retries in the core handle the rest.
 */
export async function uploadToCloud(
  data: CloudUploadRequest,
  progress: (event: CloudUploadProgress) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<CloudUploadResult> {
  const { uploadId, request, source, token } = data;
  if (!token) throw new Error('Sign in required');
  const config = await cloudConfig();
  const controller = new AbortController();
  active.set(uploadId, controller);
  let handle: FileHandle | undefined;
  try {
    let size: number;
    if ('path' in source) {
      handle = await open(source.path, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1) throw new Error('The rendered file is missing or empty');
      size = info.size;
    } else {
      size = source.bytes.byteLength;
    }
    const id = await runMultipartUpload(
      {
        async request(operation, body) {
          const response = await fetchImpl(`${config.serverUrl}/upload/${operation}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
          });
          const result = (await response.json().catch(() => ({}))) as { error?: string };
          if (!response.ok) throw new UploadError(result.error ?? `Upload request failed (${response.status})`, false);
          return result;
        },
        async read(start, end) {
          if (!handle) return (source as { bytes: Uint8Array }).bytes.subarray(start, end);
          const buffer = new Uint8Array(end - start);
          let offset = 0;
          while (offset < buffer.byteLength) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, start + offset);
            if (!bytesRead) throw new UploadError('The file changed while it was uploading', false);
            offset += bytesRead;
          }
          return buffer;
        },
        async put(url, body, _onBytes, signal) {
          let response: Response;
          try {
            response = await fetchImpl(url, {
              method: 'PUT',
              body: body as Uint8Array<ArrayBuffer>,
              signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]),
            });
          } catch (error) {
            // Resets and EPIPE mid-body are what a flaky link looks like; keep the cause and retry.
            throw new UploadError(describeError(error), true, { cause: error });
          }
          await response.body?.cancel();
          if (!response.ok) throw new UploadError(`Upload failed (${response.status})`, response.status === 429 || response.status >= 500);
        },
      },
      { size, request, signal: controller.signal, onProgress: (p) => progress({ uploadId, ...p }) },
    );
    return { id, size };
  } finally {
    active.delete(uploadId);
    await handle?.close().catch(() => {});
  }
}
