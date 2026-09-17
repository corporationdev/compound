import { expect, test } from 'bun:test';
import { newerRelease } from '../src/updates-feed';
import { compareVersions, release } from '@compound/config/release';

const feed = { version: '0.206.0', url: 'https://github.com/corporationdev/compound-releases/releases/download/v0.206.0/Compound-mac-universal.zip', name: 'v0.206.0', notes: 'Compound 0.206.0', pub_date: '2026-09-16T00:00:00Z' };

test('a newer version in the feed is offered', () => {
  const next = newerRelease(feed, '0.205.4');
  expect(next?.version).toBe('0.206.0');
  expect(next?.url).toBe(feed.url);
});

test('the same or an older version is not', () => {
  expect(newerRelease(feed, '0.206.0')).toBeNull();
  expect(newerRelease(feed, '1.0.0')).toBeNull();
});

test('a feed that is not a release document is an error, not an update', () => {
  expect(() => newerRelease('nope', '0.1.0')).toThrow();
  expect(() => newerRelease({ version: 'latest', url: feed.url }, '0.1.0')).toThrow();
  expect(() => newerRelease({ version: '9.9.9', url: 'http://example.com/app.zip' }, '0.1.0')).toThrow('https');
});

test('versions order numerically, not lexically', () => {
  expect(compareVersions('0.205.10', '0.205.9')).toBeGreaterThan(0);
  expect(compareVersions('1.0.0', '0.999.999')).toBeGreaterThan(0);
  expect(compareVersions('0.205.4', '0.205.4')).toBe(0);
});

test('the feed and installers are addressed on the public releases repository', () => {
  expect(release.feedUrl).toBe('https://github.com/corporationdev/compound-releases/releases/latest/download/latest-mac.json');
  expect(release.asset('0.206.0', release.zip)).toBe(feed.url);
});
