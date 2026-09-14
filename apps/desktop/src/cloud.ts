import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CatalogMedia } from '@compound/backend/catalog';
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
const SERVER_ROUTES = new Set([
  ...['transcribe', 'transcribe-status', 'transcribe-cancel', 'analyze', 'catalog-list', 'catalog-get', 'catalog-artwork', 'catalog-search', 'catalog-search-status', 'catalog-resolve', 'catalog-prepare', 'catalog-playback', 'catalog-save', 'catalog-remove'].map(operation => `/media/${operation}`),
  '/social/media-url',
]);
/** A JSON call to the Worker. The packaged renderer has no allowed browser origin, so every server call goes through here. */
export async function serverRequest(path: string, body: Record<string, unknown>, token: string | null): Promise<unknown> {
  if (!SERVER_ROUTES.has(path)) throw new Error('Unknown server operation');
  if (!token) throw new Error('Sign in required');
  const config = await cloudConfig();
  const response = await fetch(`${config.serverUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(255000),
  });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? 'Media request failed');
  return result;
}
/** `/media/<operation>` calls. */
export function mediaRequest(operation: string, body: Record<string, unknown>, token: string | null): Promise<unknown> {
  return serverRequest(`/media/${operation}`, body, token);
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
