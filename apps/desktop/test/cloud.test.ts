import { test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeSession } from '../../web/src/lib/native-session';

const directory = await mkdtemp(join(tmpdir(), 'compound-auth-test-'));
// No safeStorage mock: login must work without accessing the OS credential store.
mock.module('electron', () => ({ app: { getAppPath: () => directory } }));
const originalFetch = globalThis.fetch;
const { authRequest, mediaRequest, uploadMedia, readCatalogArtwork } = await import('../src/cloud');
const values = new Map<string, string>();
const authUrl = 'https://test.convex.site';
const storageKey = `compound:${authUrl}:native-session`;
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
};
const client = (url = authUrl) => createNativeSession({
  authUrl: async () => url,
  storage: () => storage,
  request: ({ operation, body, sessionToken }) => authRequest(operation, body, sessionToken),
});
beforeEach(async () => {
  values.clear();
  await writeFile(join(directory, 'runtime-config.json'), JSON.stringify({
    stage: 'dev-test', convexUrl: 'https://test.convex.cloud', authUrl,
    serverUrl: 'https://media.example.com',
  }));
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  mock.restore();
  await rm(directory, { recursive: true, force: true });
});

test('desktop artwork resolves an authenticated server URL and transports bytes without forwarding credentials', async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push(String(url));
    if (String(url) === 'https://media.example.com/media/catalog-artwork') {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access-token');
      expect(JSON.parse(String(init?.body))).toEqual({ sourceId: 'song-a' });
      return Response.json({ url: 'https://objects.example.com/artwork.jpg?signature=temporary' });
    }
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.credentials).toBe('omit'); expect(init?.redirect).toBe('error');
    return new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'Content-Type': 'image/jpeg' } });
  }) as typeof fetch;
  expect(await readCatalogArtwork('song-a', 'access-token')).toEqual(new Uint8Array([255, 216, 255, 217]));
  expect(requests).toHaveLength(2);
  await expect(readCatalogArtwork('song-a', null)).rejects.toThrow('Sign in required');
  expect(requests).toHaveLength(2);
});

test('desktop artwork keeps missing images empty and rejects invalid or oversized image responses', async () => {
  let imageRequests = 0, mode = 'missing';
  globalThis.fetch = (async url => {
    if (String(url).startsWith('https://media.example.com/')) return Response.json({ url: mode === 'missing' ? null : 'https://objects.example.com/artwork.jpg' });
    imageRequests++;
    if (mode === 'large') return new Response(new Uint8Array(3_000_001), { headers: { 'Content-Type': 'image/jpeg' } });
    if (mode === 'html') return new Response('<html>Expired URL</html>', { headers: { 'Content-Type': 'text/html' } });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
  }) as typeof fetch;
  expect(await readCatalogArtwork('song-a', 'token')).toBeNull(); expect(imageRequests).toBe(0);
  mode = 'large'; await expect(readCatalogArtwork('song-a', 'token')).rejects.toThrow('exceeds 3 MB');
  mode = 'html'; await expect(readCatalogArtwork('song-a', 'token')).rejects.toThrow('Invalid artwork response');
  mode = 'bad-jpeg'; await expect(readCatalogArtwork('song-a', 'token')).rejects.toThrow('not a JPEG');
});

test('login saves the signed session in localStorage and restores it after a renderer restart', async () => {
  globalThis.fetch = (async (url, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get('Origin')).toBe('compound://');
    if (String(url).endsWith('/sign-in/email-otp')) {
      expect(headers.has('Authorization')).toBe(false);
      return Response.json({ user: { id: 'user' }, token: 'raw-session' }, {
        headers: { 'set-auth-token': 'signed.session' },
      });
    }
    expect(headers.get('Authorization')).toBe('Bearer signed.session');
    return Response.json({ user: { id: 'user' }, session: { token: 'raw-session' } });
  }) as typeof fetch;
  expect(await client()('verifyCode', { email: 'user@example.com', otp: '123456' }))
    .toEqual({ user: { id: 'user' } });
  expect(values.get(storageKey)).toBe('signed.session');
  expect(await client()('session')).toEqual({ user: { id: 'user' } });
  expect((await readdir(directory)).filter((name) => name.startsWith('auth-'))).toEqual([]);
});

test('queued refresh, logout, and session read cannot resurrect a saved session', async () => {
  values.set(storageKey, 'signed.session');
  const paths: string[] = [];
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    const headers = new Headers(init?.headers);
    if (path.endsWith('/get-session')) {
      expect(headers.get('Authorization')).toBe('Bearer signed.session');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ user: { id: 'user' } }, {
        headers: { 'set-auth-token': 'rotated.session' },
      });
    }
    expect(path.endsWith('/sign-out')).toBe(true);
    expect(headers.get('Authorization')).toBe('Bearer rotated.session');
    return Response.json({ success: true });
  }) as typeof fetch;
  const auth = client();
  const results = await Promise.all([auth('session'), auth('signOut'), auth('session')]);
  expect(results[2]).toBeNull();
  expect(paths).toHaveLength(2);
  expect(values.has(storageKey)).toBe(false);
  expect(await client()('session')).toBeNull();
});

test('invalid credentials are cleared for session reads and failed account mutations', async () => {
  globalThis.fetch = (async () => Response.json({ message: 'Expired' }, { status: 401 })) as typeof fetch;
  values.set(storageKey, 'expired.session');
  expect(await client()('session')).toBeNull();
  expect(values.has(storageKey)).toBe(false);
  values.set(storageKey, 'expired.session');
  await expect(client()('updateUser', { name: 'New name' })).rejects.toThrow('Expired');
  expect(values.has(storageKey)).toBe(false);
});

test('network failures preserve saved login and the auth queue recovers', async () => {
  values.set(storageKey, 'signed.session');
  const auth = client();
  globalThis.fetch = (async () => { throw new Error('Offline'); }) as typeof fetch;
  await expect(auth('session')).rejects.toThrow('Offline');
  expect(values.get(storageKey)).toBe('signed.session');
  globalThis.fetch = (async () => Response.json({ user: { id: 'user' } })) as typeof fetch;
  expect(await auth('session')).toEqual({ user: { id: 'user' } });
});

test('saved login is scoped to the auth environment; old encrypted files are not read', async () => {
  values.set(storageKey, 'signed.session');
  await writeFile(join(directory, 'auth-legacy.bin'), 'unreadable legacy encrypted session');
  globalThis.fetch = (async () => { throw new Error('Unexpected request'); }) as typeof fetch;
  expect(await client('https://other.convex.site')('session')).toBeNull();
  expect(values.get(storageKey)).toBe('signed.session');
  values.clear();
  expect(await client()('session')).toBeNull();
  await rm(join(directory, 'auth-legacy.bin'));
});

test('account deletion clears saved login and missing signed login header is rejected', async () => {
  values.set(storageKey, 'signed.session');
  globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch;
  await client()('deleteUser');
  expect(values.has(storageKey)).toBe(false);
  await expect(client()('verifyCode', { otp: '123456' })).rejects.toThrow('did not issue a native session');
  expect(values.has(storageKey)).toBe(false);
});

test('native media and uploads use the access token obtained by the renderer', async () => {
  globalThis.fetch = (async (url, init) => {
    if (String(url) === 'https://upload.example.com/object') {
      expect(init?.method).toBe('PUT');
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return new Response(null, { status: 200 });
    }
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer convex.jwt');
    return String(url).endsWith('/upload-url')
      ? Response.json({ uploadId: 'upload', uploadUrl: 'https://upload.example.com/object' })
      : Response.json({ result: 'analysis' });
  }) as typeof fetch;
  expect(await mediaRequest('analyze', { uploadId: 'upload' }, 'convex.jwt'))
    .toEqual({ result: 'analysis' });
  expect(await uploadMedia('audio/wav', new Uint8Array([1]), 'convex.jwt'))
    .toEqual({ uploadId: 'upload' });
  await expect(mediaRequest('analyze', {}, null)).rejects.toThrow('Sign in required');
});
