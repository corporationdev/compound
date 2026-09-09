import { test, expect, mock, afterAll } from 'bun:test';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'compound-auth-test-'));
let secure = true;
mock.module('electron', () => ({
  app: { getAppPath: () => directory, getPath: () => directory },
  safeStorage: {
    isEncryptionAvailable: () => secure,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from([...value].reverse().join('')),
    decryptString: (value: Buffer) => [...value.toString()].reverse().join(''),
  },
}));
const originalFetch = globalThis.fetch;
const { authRequest } = await import('../src/cloud');
afterAll(async () => {
  globalThis.fetch = originalFetch;
  mock.restore();
  await rm(directory, { recursive: true, force: true });
});
test('native session persists only the signed header; queued logout cannot be undone by refresh', async () => {
  await writeFile(
    join(directory, 'runtime-config.json'),
    JSON.stringify({
      stage: 'dev-test',
      convexUrl: 'https://test.convex.cloud',
      authUrl: 'https://test.convex.site',
      serverUrl: 'https://media.example.com',
    }),
  );
  let index = 0;
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    const headers = new Headers(init?.headers);
    expect(headers.get('Origin')).toBe('compound://');
    if (path.endsWith('/sign-in/email-otp'))
      return Response.json(
        { user: { id: 'user', email: 'user@example.com' }, token: 'raw-session-never-returned' },
        { headers: { 'set-auth-token': 'signed.session-header' } },
      );
    expect(headers.get('Authorization')).toBe('Bearer signed.session-header');
    if (path.endsWith('/get-session')) {
      index++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json(
        { user: { id: 'user' }, session: { token: 'raw-session-never-returned' } },
        { headers: { 'set-auth-token': 'signed.session-header' } },
      );
    }
    expect(path.endsWith('/sign-out')).toBe(true);
    return Response.json({ success: true });
  }) as typeof fetch;
  expect(await authRequest('verifyCode', { email: 'user@example.com', otp: '123456' })).toEqual({
    user: { id: 'user', email: 'user@example.com' },
  });
  const files = (await readdir(directory)).filter((name) => name.startsWith('auth-'));
  expect(files.length).toBe(1);
  expect((await readFile(join(directory, files[0]!))).toString()).not.toContain(
    'signed.session-header',
  );
  await Promise.all([authRequest('session'), authRequest('signOut')]);
  expect(index).toBe(1);
  expect(await authRequest('session')).toBeNull();
  expect((await readdir(directory)).filter((name) => name.startsWith('auth-'))).toEqual([]);
});
test('native sign-in fails closed when secure storage is unavailable', async () => {
  secure = false;
  globalThis.fetch = (async () =>
    Response.json(
      { user: { id: 'user' } },
      { headers: { 'set-auth-token': 'signed.session-header' } },
    )) as typeof fetch;
  await expect(
    authRequest('verifyCode', { email: 'user@example.com', otp: '123456' }),
  ).rejects.toThrow('Secure session storage is unavailable');
  expect((await readdir(directory)).filter((name) => name.startsWith('auth-'))).toEqual([]);
});
