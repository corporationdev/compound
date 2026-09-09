import { app, safeStorage } from 'electron';
import { readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CloudAuthOperation, CloudConfig } from './main-channels';

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
    return { convexUrl: value.convexUrl, authUrl: value.authUrl, serverUrl: value.serverUrl };
  } catch {
    throw new Error(
      'Cloud is not configured. Run bun run setup after creating the Compound secrets.',
    );
  }
}
let sessionToken: string | null | undefined;
let configKey = '';
let tokenRequest: Promise<string | null> | undefined;
async function credentialPath() {
  const { authUrl } = await cloudConfig();
  const scope = createHash('sha256').update(authUrl).digest('hex').slice(0, 24);
  if (scope !== configKey) {
    configKey = scope;
    sessionToken = undefined;
  }
  return join(app.getPath('userData'), `auth-${scope}.bin`);
}
async function readToken() {
  const path = await credentialPath();
  if (sessionToken !== undefined) return sessionToken;
  try {
    sessionToken = safeStorage.decryptString(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Could not restore the saved session');
    sessionToken = null;
  }
  return sessionToken;
}
async function persistToken(token: string | null) {
  const path = await credentialPath();
  if (token) {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new Error('Secure session storage is unavailable');
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(`${path}.tmp`, safeStorage.encryptString(token), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  } else await rm(path, { force: true });
  sessionToken = token;
}
async function performAuthRequest(
  operation: CloudAuthOperation,
  body?: Record<string, unknown>,
): Promise<unknown> {
  if (!Object.hasOwn(AUTH_ROUTES, operation)) throw new Error('Unknown auth operation');
  const config = await cloudConfig();
  const token = await readToken();
  const isGet = operation === 'session' || operation === 'token';
  if (isGet && !token) return null;
  const response = await fetch(`${config.authUrl}/api/auth/${AUTH_ROUTES[operation]}`, {
    method: isGet ? 'GET' : 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      Origin: 'compound://',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(!isGet ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  if (response.status === 401) {
    await persistToken(null);
    if (isGet) return null;
  }
  const result = (await response.json().catch(() => null)) as {
    message?: string;
    user?: unknown;
    token?: string;
  } | null;
  if (!response.ok) throw new Error(result?.message ?? 'Authentication request failed');
  const signedToken = response.headers.get('set-auth-token');
  if (signedToken) await persistToken(signedToken);
  if (operation === 'session' && !result) await persistToken(null);
  if (operation === 'verifyCode' && !signedToken)
    throw new Error('The auth server did not issue a native session');
  if (operation === 'signOut' || operation === 'deleteUser') await persistToken(null);
  // Never send the long-lived session token back into the renderer.
  if (operation === 'session' || operation === 'verifyCode')
    return result?.user ? { user: result.user } : null;
  return operation === 'token' ? result : { success: true };
}
let authQueue: Promise<unknown> = Promise.resolve();
export function authRequest(
  operation: CloudAuthOperation,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const result = authQueue.then(() => performAuthRequest(operation, body));
  authQueue = result.catch(() => {});
  return result;
}
async function jwt(): Promise<string | null> {
  if (!tokenRequest)
    tokenRequest = authRequest('token')
      .then((result) => (result as { token?: string } | null)?.token ?? null)
      .finally(() => {
        tokenRequest = undefined;
      });
  return tokenRequest;
}
export async function mediaRequest(path: string, body: Record<string, unknown>): Promise<unknown> {
  if (!['upload-url', 'transcribe', 'analyze'].includes(path))
    throw new Error('Unknown media operation');
  const token = await jwt();
  if (!token) throw new Error('Sign in required');
  const config = await cloudConfig();
  const response = await fetch(`${config.serverUrl}/media/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(255000),
  });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? 'Media request failed');
  return result;
}
export async function uploadMedia(contentType: string, bytes: Uint8Array) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > 100 * 1024 * 1024
  )
    throw new Error('Upload must be between 1 byte and 100 MiB');
  const result = (await mediaRequest('upload-url', { contentType, size: bytes.byteLength })) as {
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
