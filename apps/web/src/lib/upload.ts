/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The one way bytes leave the app for R2. In the browser the parts go out
// from here with XHR so progress is per byte; in the desktop app the main
// process does the same from a path or from bytes, because the packaged
// renderer has no browser origin the Worker or the bucket would accept.

import { MAIN_CHANNELS } from '@desktop/main-channels';
import { UploadError, runMultipartUpload, type UploadProgress, type UploadRequest } from '@compound/config/upload';

import { getToken } from './auth-client';
import { mainBridge } from './ipc';

export type { UploadProgress, UploadRequest };
export type UploadSource = { blob: Blob } | { path: string };
export type UploadOptions = { onProgress?: (progress: UploadProgress) => void; signal?: AbortSignal };

/** Upload one object for `request` and return the purpose's row id. */
export async function uploadToCloud(request: UploadRequest, source: UploadSource, options: UploadOptions = {}): Promise<string> {
  const token = await getToken();
  if (!token) throw new Error('Sign in required');
  if (window.desktop) return uploadThroughMain(request, source, token, options);
  if (!('blob' in source)) throw new Error('Uploading a file by path needs the desktop app');
  return uploadFromBrowser(request, source.blob, token, options);
}

async function uploadThroughMain(request: UploadRequest, source: UploadSource, token: string, options: UploadOptions) {
  const uploadId = crypto.randomUUID();
  const stop = mainBridge.handle(MAIN_CHANNELS.CLOUD_UPLOAD_PROGRESS, (event) => {
    if (event.uploadId === uploadId) options.onProgress?.({ sent: event.sent, total: event.total });
  });
  const cancel = () => void mainBridge.call(MAIN_CHANNELS.CLOUD_UPLOAD_CANCEL, { uploadId });
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    options.signal?.throwIfAborted();
    const result = await mainBridge.call(MAIN_CHANNELS.CLOUD_UPLOAD, {
      uploadId,
      request,
      token,
      source: 'path' in source ? { path: source.path } : { bytes: new Uint8Array(await source.blob.arrayBuffer()) },
    });
    return result.id;
  } catch (error) {
    // The main process only sees an aborted fetch; the caller's reason is the useful one.
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw error;
  } finally {
    stop();
    options.signal?.removeEventListener('abort', cancel);
  }
}

async function uploadFromBrowser(request: UploadRequest, blob: Blob, token: string, options: UploadOptions) {
  const server = import.meta.env.VITE_SERVER_URL;
  if (!server) throw new Error('Media service is not configured');
  return runMultipartUpload(
    {
      async request(operation, body) {
        const response = await fetch(`${server}/upload/${operation}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const result = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new UploadError(result.error ?? `Upload request failed (${response.status})`, false);
        return result;
      },
      read: async (start, end) => blob.slice(start, end),
      put: (url, body, onBytes, signal) =>
        new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', url);
          xhr.timeout = 5 * 60_000;
          xhr.upload.onprogress = (event) => onBytes(event.loaded);
          xhr.onload = () =>
            xhr.status >= 200 && xhr.status < 300
              ? resolve()
              : reject(new UploadError(`Upload failed (${xhr.status})`, xhr.status === 429 || xhr.status >= 500));
          xhr.onerror = () => reject(new UploadError('Upload failed: network error', true));
          xhr.ontimeout = () => reject(new UploadError('Upload failed: timed out', true));
          xhr.onabort = () => reject(signal.reason instanceof Error ? signal.reason : new UploadError('Upload cancelled', false));
          signal.addEventListener('abort', () => xhr.abort(), { once: true });
          xhr.send(body instanceof Blob ? body : new Blob([body as Uint8Array<ArrayBuffer>]));
        }),
    },
    { size: blob.size, request, onProgress: options.onProgress, signal: options.signal },
  );
}
