import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { lastUsedProjectRoot, rememberProjectRoot } from '../src/lib/db';

test('stages remember independent folders and adopt the previous selection only once', async () => {
  await rememberProjectRoot('/Volumes/Media/Existing Projects');
  expect((await lastUsedProjectRoot('dev-local'))?.path).toBe('/Volumes/Media/Existing Projects');
  expect(await lastUsedProjectRoot('pr-42')).toBeNull();
  await rememberProjectRoot('/Movies/compound-pr-42', 'multi', 'pr-42');
  expect(await lastUsedProjectRoot('prod')).toBeNull();
  await rememberProjectRoot('/Movies/compound', 'multi', 'prod');
  expect((await lastUsedProjectRoot('dev-local'))?.path).toBe('/Volumes/Media/Existing Projects');
  expect((await lastUsedProjectRoot('pr-42'))?.path).toBe('/Movies/compound-pr-42');
  expect((await lastUsedProjectRoot('prod'))?.path).toBe('/Movies/compound');
  await rememberProjectRoot('/Volumes/Preview Projects', 'multi', 'pr-42');
  await rememberProjectRoot('/Projects/External Clip', 'single');
  expect((await lastUsedProjectRoot('pr-42'))?.path).toBe('/Volumes/Preview Projects');
  expect((await lastUsedProjectRoot('prod'))?.path).toBe('/Movies/compound');
  expect(await lastUsedProjectRoot('pr-43')).toBeNull();
});
