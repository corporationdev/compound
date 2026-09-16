import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CatalogMedia, CatalogKind } from '@compound/backend/catalog';
import { MAX_CATALOG_UPLOAD_BYTES } from '@compound/backend/catalog';
import { downloadCatalogArtwork } from '@compound/backend/catalog-artwork';
import { projectsFolderNameForStage, validateStage } from '@compound/config/runtime';
import type { CloudAuthOperation, CloudAuthResult, CloudConfig } from './main-channels';

const AUTH_ROUTES: Record<CloudAuthOperation, string> = {
  sendCode: 'email-otp/send-verification-otp',
  verifyCode: 'sign-in/email-otp',
  session: 'get-session',
  token: 'convex/token',
  signOut: 'sign-out',
  updateUser: 'update-user',
  deleteUser: 'delete-user',
  requestEmailChange: 'email-otp/request-email-change',
  changeEmail: 'email-otp/change-email',
};
export async function cloudConfig(): Promise<CloudConfig> {
  try {
    const value = JSON.parse(await readFile(join(app.getAppPath(), 'runtime-config.json'), 'utf8'));
    for (const key of ['convexUrl', 'authUrl', 'serverUrl']) {
      const url = new URL(value[key]);
      if (
        url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      )
        throw new Error('Invalid cloud URL');
    }
    const stage = validateStage(value.stage);
    const projectsFolderName = projectsFolderNameForStage(stage);
    return { stage, projectsFolderName, convexUrl: value.convexUrl, authUrl: value.authUrl, serverUrl: value.serverUrl };
  } catch {
    throw new Error(
      'Cloud is not configured. Run bun run setup after creating the Compound secrets.',
    );
  }
}
// Session persistence belongs to the renderer's localStorage. The main process
// only provides the native HTTP transport for the packaged file:// app.
export async function authRequest(
  operation: CloudAuthOperation,
  body: Record<string, unknown> | undefined,
  sessionToken: string | null,
): Promise<CloudAuthResult> {
  if (!Object.hasOwn(AUTH_ROUTES, operation)) throw new Error('Unknown auth operation');
  const config = await cloudConfig();
  const isGet = operation === 'session' || operation === 'token';
  if (isGet && !sessionToken) return { data: null, sessionToken: null };
  const response = await fetch(`${config.authUrl}/api/auth/${AUTH_ROUTES[operation]}`, {
    method: isGet ? 'GET' : 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      Origin: 'compound://',
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    },
    ...(!isGet ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  if (response.status === 401) {
    sessionToken = null;
    if (isGet) return { data: null, sessionToken };
  }
  const result = (await response.json().catch(() => null)) as {
    message?: string;
    user?: unknown;
    token?: string;
  } | null;
  if (!response.ok)
    return { data: null, sessionToken, error: result?.message ?? 'Authentication request failed' };
  const signedToken = response.headers.get('set-auth-token');
  if (signedToken) sessionToken = signedToken;
  if (operation === 'session' && !result?.user) sessionToken = null;
  if (operation === 'verifyCode' && !signedToken)
    throw new Error('The auth server did not issue a native session');
  if (operation === 'signOut' || operation === 'deleteUser') sessionToken = null;
  const data = operation === 'session' || operation === 'verifyCode'
    ? (result?.user ? { user: result.user } : null)
    : operation === 'token' ? result : { success: true };
  return { data, sessionToken };
}
/** A media server refusal, with the status so a caller can tell "not there" (404) from a failure. */
export class MediaRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MediaRequestError';
    this.status = status;
  }
}
/** Every operation the media server exposes that this process may call; anything else never leaves the machine. */
export const MEDIA_OPERATIONS = ['upload-url', 'transcribe', 'transcribe-status', 'transcribe-cancel', 'analyze', 'catalog-list', 'catalog-get', 'catalog-artwork', 'catalog-search', 'catalog-search-status', 'catalog-resolve', 'catalog-prepare', 'catalog-playback', 'catalog-save', 'catalog-remove', 'catalog-upload-url', 'catalog-upload-finish', 'asset-upload-url', 'asset-upload-finish', 'asset-download-url', 'asset-proxy-upload-url', 'asset-proxy-upload-finish', 'asset-multipart-start', 'asset-multipart-part-url', 'asset-multipart-complete'] as const;

export async function mediaRequest(path: string, body: Record<string, unknown>, token: string | null): Promise<unknown> {
  if (!(MEDIA_OPERATIONS as readonly string[]).includes(path))
    throw new Error('Unknown media operation');
  if (!token) throw new Error('Sign in required');
  const config = await cloudConfig();
  const response = await fetch(`${config.serverUrl}/media/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(255000),
  });
  const text = await response.text();
  let result: { error?: string };
  try {
    result = JSON.parse(text) as { error?: string };
  } catch {
    throw new MediaRequestError(response.status, `Media server answered ${response.status} with ${text.trim().slice(0, 80) || 'nothing'} (is the server up?)`);
  }
  if (!response.ok) throw new MediaRequestError(response.status, result.error ?? 'Media request failed');
  return result;
}

export async function uploadCatalogAudio(data: { title: string; kind: CatalogKind; mimeType: string; bytes: Uint8Array; token: string | null }) {
  if (!data.bytes.byteLength || data.bytes.byteLength > MAX_CATALOG_UPLOAD_BYTES) throw new Error('Upload audio up to 100 MiB');
  const upload = await mediaRequest('catalog-upload-url', { title: data.title, kind: data.kind, mimeType: data.mimeType, size: data.bytes.byteLength }, data.token) as { sourceId: string; url: string };
  const response = await fetch(upload.url, { method: 'PUT', headers: { 'Content-Type': data.mimeType }, body: data.bytes as Uint8Array<ArrayBuffer>, signal: AbortSignal.timeout(240000) });
  if (!response.ok) throw new Error('Library upload failed');
  await response.body?.cancel();
  await mediaRequest('catalog-upload-finish', { sourceId: upload.sourceId }, data.token);
  return { sourceId: upload.sourceId };
}

export async function readCatalogAudio(sourceId: string, token: string | null) {
  const media = await mediaRequest('catalog-playback', { sourceId }, token) as CatalogMedia;
  const response = await fetch(media.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error('Could not download library audio');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CATALOG_UPLOAD_BYTES) throw new Error('Library audio exceeds 100 MiB');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { media, bytes };
}
export async function readCatalogArtwork(sourceId: string, token: string | null) {
  // Resolve the URL on the authenticated server, never from renderer input.
  // The main process transports bytes only; caching stays in IndexedDB.
  const { url } = await mediaRequest('catalog-artwork', { sourceId }, token) as { url: string | null };
  return url === null ? null : downloadCatalogArtwork(url);
}
export async function uploadMedia(contentType: string, bytes: Uint8Array, token: string | null) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > 100 * 1024 * 1024
  )
    throw new Error('Upload must be between 1 byte and 100 MiB');
  const result = (await mediaRequest('upload-url', { contentType, size: bytes.byteLength }, token)) as {
    uploadId: string;
    uploadUrl: string;
  };
  // The destination is obtained from the authenticated server, never supplied by the renderer.
  const response = await fetch(result.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes as Uint8Array<ArrayBuffer>,
    signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) throw new Error('Media upload failed');
  return { uploadId: result.uploadId };
}
