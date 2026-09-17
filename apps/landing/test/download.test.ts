import { expect, test } from 'bun:test';
import worker from '../worker';
import { release } from '@compound/config/release';

const env = { ASSETS: { fetch: async () => new Response('landing') } } as unknown as Parameters<typeof worker.fetch>[1];

test('the stable download URL sends people to the newest stable release without caching', async () => {
  const response = await worker.fetch(new Request('https://compound.mov/download'), env);
  expect(response.status).toBe(302);
  expect(response.headers.get('Location')).toBe(`${release.url}/releases/latest/download/${release.dmg}`);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('only GET and HEAD download', async () => {
  const response = await worker.fetch(new Request('https://compound.mov/download', { method: 'POST' }), env);
  expect(response.status).toBe(405);
});

test('everything else is the landing page', async () => {
  const response = await worker.fetch(new Request('https://compound.mov/releases/v1.2.3/Compound-mac-universal.dmg'), env);
  expect(await response.text()).toBe('landing');
});
