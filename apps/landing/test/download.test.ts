import { expect, test } from 'bun:test';
import worker from '../worker';
import { release, releaseVersion } from '@compound/config/release';

const path = '/releases/v1.2.3/Compound-mac-universal.dmg';
function storage(version: string | null = '1.2.3') {
  const reads: string[] = [];
  const bucket = {
    async head(key: string) {
      return key === path.slice(1) ? { size: 10, httpEtag: '"installer"' } : null;
    },
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      reads.push(key);
      if (key === 'latest.json') return version ? { json: async () => ({ version }) } : null;
      if (key !== path.slice(1)) return null;
      const { offset = 0, length = 10 } = options?.range ?? {};
      return { body: new Response('0123456789'.slice(offset, offset + length)).body };
    },
  };
  const env = {
    RELEASES: bucket,
    ASSETS: { fetch: async () => new Response('landing') },
  } as unknown as Parameters<typeof worker.fetch>[1];
  return { env, reads };
}

test('the stable download URL resolves the current version without caching the pointer', async () => {
  for (const version of ['1.2.3', '2.0.0']) {
    const response = await worker.fetch(new Request('https://compound.mov/download'), storage(version).env);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`/releases/v${version}/${release.dmg}`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
});

test('an unpublished first release returns an uncached unavailable response', async () => {
  const response = await worker.fetch(new Request('https://compound.mov/download'), storage(null).env);
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('downloads stream the installer and HEAD avoids reading its body', async () => {
  const { env, reads } = storage();
  const head = await worker.fetch(new Request(`https://compound.mov${path}`, { method: 'HEAD' }), env);
  expect(head.headers.get('Content-Length')).toBe('10');
  expect(await head.text()).toBe('');
  expect(reads).toEqual([]);
  const response = await worker.fetch(new Request(`https://compound.mov${path}`), env);
  expect(response.headers.get('Content-Disposition')).toContain(release.dmg);
  expect(await response.text()).toBe('0123456789');
});

test('resumable downloads handle bounded, open-ended, and suffix ranges', async () => {
  for (const [range, body, contentRange] of [
    ['bytes=3-5', '345', 'bytes 3-5/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-2', '89', 'bytes 8-9/10'],
    ['bytes=8-99', '89', 'bytes 8-9/10'],
  ]) {
    const response = await worker.fetch(new Request(`https://compound.mov${path}`, { headers: { Range: range! } }), storage().env);
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(contentRange!);
    expect(await response.text()).toBe(body!);
  }
});

test('invalid ranges, write methods, and unrelated objects are not exposed', async () => {
  for (const range of ['bytes=10-', 'bytes=7-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5']) {
    const response = await worker.fetch(new Request(`https://compound.mov${path}`, { headers: { Range: range } }), storage().env);
    expect(response.status).toBe(416);
  }
  const { env, reads } = storage();
  expect((await worker.fetch(new Request('https://compound.mov/download', { method: 'POST' }), env)).status).toBe(405);
  expect((await worker.fetch(new Request('https://compound.mov/releases/credentials.json'), env)).status).toBe(404);
  expect(reads).toEqual([]);
});

test('preview downloads use production and normal page requests use static assets', async () => {
  const { env } = storage();
  delete env.RELEASES;
  expect((await worker.fetch(new Request('https://preview-test.compound.mov/download'), env)).headers.get('Location')).toBe(release.downloadUrl);
  expect(await (await worker.fetch(new Request('https://compound.mov/'), env)).text()).toBe('landing');
});

test('release versions reject paths, prereleases, and malformed versions', () => {
  expect(releaseVersion('0.205.0')).toBe('0.205.0');
  for (const version of ['../secret', '1.0.0-beta', 'v1.0.0', '01.0.0', null])
    expect(() => releaseVersion(version)).toThrow();
});
