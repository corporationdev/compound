import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'compound-release-'));
  fixtures.push(directory);
  const remote = join(directory, 'origin.git');
  const checkout = join(directory, 'checkout');
  const output = join(directory, 'output');
  const run = (command: string, args: string[], cwd = checkout) =>
    execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run('git', ['init', '--bare', remote], directory);
  run('git', ['init', '-b', 'main', checkout], directory);
  const git = (...args: string[]) => run('git', args);
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  const packages = ['package.json', 'apps/desktop/package.json', 'apps/cli/package.json', 'apps/web/package.json'];
  for (const path of packages) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), JSON.stringify({
      name: path === 'package.json' ? 'release-fixture' : `fixture-${path.split('/')[1]}`,
      version: '0.204.5', private: true,
      ...(path === 'package.json' ? { workspaces: ['apps/*'], scripts: { release: 'node scripts/release.mjs' } } : {}),
    }, null, 2) + '\n');
  }
  mkdirSync(join(checkout, 'scripts'));
  for (const file of ['release.mjs', 'prepare-release.sh'])
    copyFileSync(new URL(file, import.meta.url), join(checkout, 'scripts', file));
  run('bun', ['install', '--lockfile-only']);
  git('add', '.');
  git('commit', '-m', 'Initial source');
  git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'main');
  const main = git('rev-parse', 'main');
  const remoteMain = () => run('git', ['rev-parse', 'refs/heads/main'], remote);
  const prepare = (id: string, bump = 'patch', extra: Record<string, string> = {}) => {
    writeFileSync(output, '');
    execFileSync('bash', ['scripts/prepare-release.sh'], {
      cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
        GITHUB_RUN_ID: id, GITHUB_OUTPUT: output, RELEASE_BUMP: bump, ...extra },
    });
    return readFileSync(output, 'utf8').trim();
  };
  return { checkout, remote, run, git, packages, main, remoteMain, prepare };
}

test('consecutive releases and retries publish versioned tags without diverging main', () => {
  const repo = repository();
  expect(repo.prepare('100')).toBe('tag=v0.204.6');
  expect(repo.git('rev-parse', 'main')).toBe(repo.main);
  expect(repo.remoteMain()).toBe(repo.main);
  const firstRelease = repo.git('rev-parse', 'v0.204.6^{}');
  expect(repo.run('git', ['rev-parse', 'refs/tags/v0.204.6^{}'], repo.remote)).toBe(firstRelease);
  for (const path of repo.packages)
    expect(JSON.parse(repo.git('show', `v0.204.6:${path}`)).version).toBe('0.204.6');

  // A developer who checked out main before the release can still push normally.
  repo.git('checkout', 'main');
  writeFileSync(join(repo.checkout, 'feature.txt'), 'New source\n');
  repo.git('add', 'feature.txt');
  repo.git('commit', '-m', 'Developer work');
  repo.git('push', 'origin', 'main');
  const advancedMain = repo.git('rev-parse', 'main');
  expect(repo.remoteMain()).toBe(advancedMain);
  expect(repo.prepare('101')).toBe('tag=v0.204.7');
  expect(repo.git('rev-parse', 'v0.204.7^')).toBe(advancedMain);
  expect(repo.remoteMain()).toBe(advancedMain);

  // Simulate the next runner fetching tags and retrying the earlier run.
  repo.git('checkout', 'main');
  expect(repo.prepare('100')).toBe('tag=v0.204.6');
  expect(repo.git('rev-parse', 'v0.204.6^{}')).toBe(firstRelease);
  expect(repo.git('tag', '--list')).toBe('v0.204.6\nv0.204.7');
  expect(repo.remoteMain()).toBe(advancedMain);
  expect(repo.prepare('102', 'patch', { GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v0.204.7' }))
    .toBe('tag=v0.204.7');
  expect(repo.git('status', '--porcelain')).toBe('');
});

test('version selection uses numeric stable tag order for patch, minor, and major', () => {
  const repo = repository();
  for (const tag of ['v0.204.9', 'v0.204.10', 'v99.0.0-beta.1', 'unrelated']) repo.git('tag', tag);
  for (const [id, bump, version] of [['200', 'patch', '0.204.11'], ['201', 'minor', '0.205.0'], ['202', 'major', '1.0.0']]) {
    repo.git('checkout', 'main');
    expect(repo.prepare(id!, bump!)).toBe(`tag=v${version}`);
    expect(repo.remoteMain()).toBe(repo.main);
  }
});

test('explicit versions cannot reuse or regress an existing release', () => {
  const repo = repository();
  repo.git('tag', 'v0.205.0');
  for (const version of ['0.204.6', '0.205.0']) {
    expect(() => repo.run('node', ['scripts/release.mjs', version])).toThrow('must be newer');
    expect(repo.git('status', '--porcelain')).toBe('');
  }
  repo.git('checkout', '--detach');
  repo.run('node', ['scripts/release.mjs', '0.206.0']);
  expect(JSON.parse(repo.git('show', 'v0.206.0:package.json')).version).toBe('0.206.0');
  expect(repo.git('rev-parse', 'main')).toBe(repo.main);
});

test('manual releases reject branches other than main before changing refs', () => {
  const repo = repository();
  expect(() => repo.prepare('300', 'patch', { GITHUB_REF: 'refs/heads/feature' })).toThrow();
  expect(repo.git('tag', '--list')).toBe('');
  expect(repo.remoteMain()).toBe(repo.main);
});
