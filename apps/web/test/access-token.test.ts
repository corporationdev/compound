import { expect, test } from 'bun:test';
import { createAccessToken } from '../src/lib/access-token';

const jwt = (exp: number) => `header.${btoa(JSON.stringify({ exp }))}.signature`;
test('polling coalesces token requests, reuses valid tokens, and refreshes before expiry', async () => {
  let now = 100000, requests = 0;
  const tokens = createAccessToken(async () => { requests++; return jwt((now + 90000) / 1000); }, () => now);
  const first = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
  expect(new Set(first).size).toBe(1); expect(requests).toBe(1);
  now += 59000; await tokens.get(); expect(requests).toBe(1);
  now += 1001; await tokens.get(); expect(requests).toBe(2);
});
test('logout invalidates cached and in-flight tokens; failures can be retried', async () => {
  let finish!: (value: string | null) => void;
  let fail = false;
  const tokens = createAccessToken(() => fail ? Promise.reject(new Error('network')) : new Promise(resolve => { finish = resolve; }));
  const old = tokens.get(); tokens.invalidate(); finish(jwt(Date.now() / 1000 + 600));
  expect(await old).toBeNull();
  fail = true; await expect(tokens.get()).rejects.toThrow('network');
  fail = false; const next = tokens.get(); finish('unreadable'); expect(await next).toBe('unreadable');
  const retry = tokens.get(); finish(null); expect(await retry).toBeNull();
});
