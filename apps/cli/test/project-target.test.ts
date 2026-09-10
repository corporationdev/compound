import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveCliTarget } from '../src/project-target';

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'compound-target-'))); fixtures.push(root);
  const project = join(root, 'project'); const nested = join(project, 'src', 'scenes');
  await mkdir(nested, { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ projectId: 'project-a', main: 'index.tsx' }));
  return { root, project, nested };
}
test('nested working directories resolve their containing project', async () => {
  const f = await fixture();
  expect(await resolveCliTarget(f.nested)).toEqual({ dir: f.project });
});
test('explicit ID and directory override the working directory', async () => {
  const f = await fixture();
  expect(await resolveCliTarget(f.nested, 'project-b')).toEqual({ ref: 'project-b' });
  expect(await resolveCliTarget(f.root, './project')).toEqual({ dir: f.project });
});
test('outside a project never falls back to an open editor', async () => {
  const f = await fixture();
  expect(await resolveCliTarget(f.root)).toEqual({});
  await expect(resolveCliTarget(f.root, './missing')).rejects.toThrow('does not exist');
});
test('symlink paths are canonical and the nearest nested project wins', async () => {
  const f = await fixture(); const link = join(f.root, 'alias');
  await symlink(f.project, link);
  expect(await resolveCliTarget(link)).toEqual({ dir: f.project });
  await writeFile(join(f.nested, 'package.json'), JSON.stringify({ projectId: 'nested' }));
  expect(await resolveCliTarget(f.nested)).toEqual({ dir: resolve(f.nested) });
});
