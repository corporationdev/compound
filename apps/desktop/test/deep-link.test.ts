import { test, expect } from 'bun:test';
import { DeepLinkInbox, deepLinksIn, parseDeepLink } from '../src/deep-link';

test('parses compound:// links and rejects everything else', () => {
  expect(parseDeepLink('compound://social-connected?platform=twitter&username=isaac')).toEqual({
    host: 'social-connected',
    params: { platform: 'twitter', username: 'isaac' },
    url: 'compound://social-connected?platform=twitter&username=isaac',
  });
  expect(parseDeepLink('COMPOUND://Social-Connected')?.host).toBe('social-connected');
  expect(parseDeepLink('https://example.com/')).toBeNull();
  expect(parseDeepLink('compound://')).toBeNull();
  expect(parseDeepLink('compound://not valid host')).toBeNull();
  expect(parseDeepLink('compound:social-connected')).toBeNull();
});

test('finds links among ordinary argv entries', () => {
  const argv = ['/Applications/Compound.app/Contents/MacOS/Compound', '--hidden', 'compound://social-connected?username=a', 'compound://other'];
  expect(deepLinksIn(argv).map((l) => l.host)).toEqual(['social-connected', 'other']);
  expect(deepLinksIn(['electron', '.'])).toEqual([]);
});

test('inbox pushes to a ready renderer and holds for one that is still booting', () => {
  let ready = false;
  const delivered: string[] = [];
  const inbox = new DeepLinkInbox((link) => {
    if (!ready) return false;
    delivered.push(link.host);
    return true;
  });
  inbox.push(parseDeepLink('compound://first')!);
  inbox.push(parseDeepLink('compound://second')!);
  expect(delivered).toEqual([]);
  // Only the latest link waits; the renderer drains it once on boot.
  expect(inbox.take()?.host).toBe('second');
  expect(inbox.take()).toBeNull();
  ready = true;
  inbox.push(parseDeepLink('compound://third')!);
  expect(delivered).toEqual(['third']);
  expect(inbox.take()).toBeNull();
});
