import { test, expect } from 'bun:test';
import { parse } from 'dotenv';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deriveEnvTier, getStageKind, linkedWorktreeRoot, resolveStage } from '@compound/config/stage';
import { stagePorts } from '@compound/config/ports';
import { resolveRuntimeContext } from '@compound/config/runtime';
import { DEEPGRAM_MODEL, GEMINI_MODEL } from '@compound/config/models';
import { renderEnv, renderEnvTemplate, stageFrom, readEnv, targets, serviceAccountToken } from './environment';

test('local 1Password token takes priority over an inherited account, with CI fallback', () => {
  expect(serviceAccountToken({ OP_SERVICE_ACCOUNT_TOKEN: ' ops_local ' }, { OP_SERVICE_ACCOUNT_TOKEN: 'ops_old' })).toBe('ops_local');
  expect(serviceAccountToken({}, { OP_SERVICE_ACCOUNT_TOKEN: 'ops_ci' })).toBe('ops_ci');
  expect(() => serviceAccountToken({ OP_SERVICE_ACCOUNT_TOKEN: 'invalid' }, { OP_SERVICE_ACCOUNT_TOKEN: 'ops_old' })).toThrow();
  expect(() => serviceAccountToken({}, {})).toThrow();
});

test('parallel dev processes can atomically write the same private config file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'compound-env-test-'));
  const destination = join(directory, '.env');
  try {
    const writers = Array.from({ length: 12 }, (_, i) => {
      const script = `import { writePrivate } from ${JSON.stringify(import.meta.resolve('./environment'))}; for (let n = 0; n < 30; n++) writePrivate(${JSON.stringify(destination)}, ${JSON.stringify(`WRITER=${i}\n`)});`;
      return Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    });
    const results = await Promise.all(writers.map(async (writer) => ({
      code: await writer.exited,
      error: await new Response(writer.stderr).text(),
    })));
    expect(results).toEqual(Array.from({ length: 12 }, () => ({ code: 0, error: '' })));
    expect(readFileSync(destination, 'utf8')).toMatch(/^WRITER=\d+\n$/);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(['.env']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const identity = { rootDomain: 'compound.example', productionConvexDeployment: 'production-one' };
test('PostBob stage pattern maps machine dev and PR stages to shared vault tiers', () => {
  expect(resolveStage('dev')).toStartWith('dev-');
  expect(resolveStage('dev')).toBe(resolveStage('dev'));
  expect(stageFrom([])).toBe(resolveStage('dev'));
  expect(stageFrom(['--dev'])).toBe(resolveStage('dev'));
  expect(deriveEnvTier('dev-isaac-1234')).toBe('dev');
  expect(deriveEnvTier('pr-42')).toBe('preview');
  expect(deriveEnvTier('preview-feature')).toBe('preview');
  expect(deriveEnvTier('prod')).toBe('prod');
  expect(getStageKind('production')).toBe('production');
  expect(() => stageFrom(['--stage', '../../prod'])).toThrow();
  expect(() => stageFrom(['--stage', 'unknown'])).toThrow();
  expect(() => stageFrom(['--stage'])).toThrow();
  expect(() => stageFrom(['--dev', '--stage', 'prod'])).toThrow();
});
test('a linked worktree resolves its own sandbox stage; the main checkout keeps the machine stage', () => {
  // git reports real paths, so compare against the resolved temp directory.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'compound-worktree-test-')));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const main = join(directory, 'main');
    const linked = join(directory, 'Feature Branch.v2');
    git(directory, 'init', '-q', '-b', 'main', main);
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'root');
    git(main, 'worktree', 'add', '-q', '--detach', linked);
    expect(linkedWorktreeRoot(main)).toBeNull();
    expect(linkedWorktreeRoot(join(directory, 'nowhere-' + Date.now()) )).toBeNull();
    expect(linkedWorktreeRoot(join(linked, 'nested'))).toBeNull();
    const nested = join(linked, 'packages');
    execFileSync('mkdir', ['-p', nested]);
    expect(linkedWorktreeRoot(nested)).toBe(linked);
    expect(resolveStage('dev', { cwd: main })).toBe(resolveStage('dev'));
    const sandbox = resolveStage('dev', { cwd: linked });
    expect(sandbox).toMatch(/^sandbox-feature-branch-v2-[a-f0-9]{8}$/);
    expect(sandbox).toBe(resolveStage('dev', { cwd: nested }));
    expect(getStageKind(sandbox)).toBe('sandbox');
    expect(deriveEnvTier(sandbox)).toBe('dev');
    expect(sandbox.length).toBeLessThanOrEqual(48);
    expect(stageFrom(['--stage', sandbox])).toBe(sandbox);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('sandbox stages get a stable, distinct port block; machine dev stages keep the documented ports', () => {
  expect(stagePorts('dev-isaac-1234')).toEqual({ web: 5173, server: 3000, convexCloud: 3210, convexSite: 3211, inspector: 9333 });
  expect(stagePorts('pr-42')).toEqual(stagePorts('prod'));
  const alpha = stagePorts('sandbox-alpha-12345678');
  const beta = stagePorts('sandbox-beta-12345678');
  expect(alpha).toEqual(stagePorts('sandbox-alpha-12345678'));
  expect(alpha.web % 10).toBe(0);
  expect(alpha.web).toBeGreaterThanOrEqual(20000);
  expect(alpha.inspector).toBeLessThan(40000);
  expect([alpha.server, alpha.convexCloud, alpha.convexSite, alpha.inspector]).toEqual([1, 2, 3, 4].map((n) => alpha.web + n));
  expect(beta.web).not.toBe(alpha.web);
});
test('a sandbox stage runs Convex locally on its ports and keeps its own Worker, bucket and folder', () => {
  const stage = 'sandbox-alpha-12345678';
  const ports = stagePorts(stage);
  const sandbox = resolveRuntimeContext(stage, identity);
  expect(sandbox.ports).toEqual(ports);
  expect(sandbox.convexUrl).toBe(`http://127.0.0.1:${ports.convexCloud}`);
  expect(sandbox.convexSiteUrl).toBe(`http://127.0.0.1:${ports.convexSite}`);
  expect(sandbox.webUrl).toBe(`http://localhost:${ports.web}`);
  expect(sandbox.serverUrl).toBe(`https://server-${stage}.compound.example`);
  expect(sandbox.bucket).toBe(`compound-media-${stage}`);
  expect(sandbox.desktopConfig).toEqual({
    stage,
    projectsFolderName: `compound-${stage}`,
    convexUrl: sandbox.convexUrl,
    authUrl: sandbox.convexSiteUrl,
    serverUrl: sandbox.serverUrl,
  });
  expect(sandbox.webClientEnv.VITE_CONVEX_SITE_URL).toBe(sandbox.convexSiteUrl);
  expect(resolveRuntimeContext(stage, { ...identity, convexUrl: sandbox.convexUrl }).convexUrl).toBe(sandbox.convexUrl);
  expect(() => resolveRuntimeContext(stage, { ...identity, convexUrl: 'https://dev-one.convex.cloud' })).toThrow('locally');
  expect(() => resolveRuntimeContext(stage, { ...identity, convexUrl: 'http://127.0.0.1:3210' })).toThrow('locally');
});
test('one runtime resolver derives browser, desktop, Worker, and auth URLs', () => {
  const dev = resolveRuntimeContext('dev-isaac-1234', {
    ...identity,
    convexUrl: 'https://dev-one.convex.cloud',
  });
  expect(dev.webUrl).toBe('http://localhost:5173');
  expect(dev.landingUrl).toBe('http://localhost:3002');
  expect(dev.serverUrl).toBe('https://server-dev-isaac-1234.compound.example');
  expect(dev.convexSiteUrl).toBe('https://dev-one.convex.site');
  expect(dev.bucket).toBe('compound-media-dev-isaac-1234');
  expect(dev.desktopConfig.stage).toBe('dev-isaac-1234');
  expect(dev.desktopConfig.projectsFolderName).toBe('compound-dev-isaac-1234');
  const preview = resolveRuntimeContext('pr-42', {
    ...identity,
    convexUrl: 'https://preview-one.convex.cloud',
  });
  expect(preview.webUrl).toBe('https://app-pr-42.compound.example');
  expect(preview.landingHostname).toBe('pr-42.compound.example');
  expect(preview.serverUrl).toBe('https://server-pr-42.compound.example');
  expect(preview.serverBindings.CORS_ORIGIN).toBe(
    preview.webClientEnv.VITE_SERVER_URL.replace('server-', 'app-'),
  );
  expect(preview.desktopConfig.serverUrl).toBe(preview.webClientEnv.VITE_SERVER_URL);
  expect(preview.desktopConfig.projectsFolderName).toBe('compound-pr-42');
  const prod = resolveRuntimeContext('prod', identity);
  expect(prod.webUrl).toBe('https://app.compound.example');
  expect(prod.landingUrl).toBe('https://compound.example');
  expect(prod.serverUrl).toBe('https://server.compound.example');
  expect(prod.convexUrl).toBe('https://production-one.convex.cloud');
  expect(prod.desktopConfig.projectsFolderName).toBe('compound');
  expect(prod.backendEnv.RESEND_FROM_EMAIL).toBe('Compound <no-reply@compound.example>');
});
test('runtime fails on missing identity, invalid deployment outputs and production mismatches', () => {
  expect(() =>
    resolveRuntimeContext('prod', { rootDomain: '', productionConvexDeployment: '' }),
  ).toThrow('rootDomain');
  expect(() =>
    resolveRuntimeContext('prod', {
      rootDomain: identity.rootDomain,
      productionConvexDeployment: '',
    }),
  ).toThrow('productionConvexDeployment');
  expect(() => resolveRuntimeContext('pr-42', identity)).toThrow('Convex');
  expect(() =>
    resolveRuntimeContext('prod', { ...identity, convexUrl: 'https://dev-one.convex.cloud' }),
  ).toThrow('Production');
  expect(() =>
    resolveRuntimeContext('dev-test', {
      ...identity,
      convexUrl: 'https://user:password@example.com',
    }),
  ).toThrow();
  expect(() =>
    resolveRuntimeContext('dev-test', { ...identity, convexUrl: 'http://localhost:3210' }),
  ).toThrow();
});
test('1Password contains credentials only and env templates preserve grouped output', () => {
  const references = readEnv('.env.op');
  for (const [key, value] of Object.entries(references)) {
    if (key === 'STAGE') continue;
    expect(value).toStartWith('op://compound-${ENV_TIER}/');
    expect(/URL|MODEL|FROM_EMAIL/.test(key)).toBe(false);
    expect(targets.some((target) => key in readEnv(`${target}/.env.example`))).toBe(true);
  }
  expect(DEEPGRAM_MODEL).toBeTruthy();
  expect(GEMINI_MODEL).toBeTruthy();
  const publicOutput = renderEnvTemplate('apps/web', {
    STAGE: 'prod',
    VITE_CONVEX_URL: 'https://prod.convex.cloud',
    DEEPGRAM_API_KEY: 'do-not-ship',
  });
  expect(publicOutput).toContain('# Generated by runtime:write');
  expect(publicOutput).not.toContain('do-not-ship');
  expect(publicOutput).not.toContain('DEEPGRAM_API_KEY');
});
test('dotenv output preserves supported values and rejects silent escaping changes', () => {
  const values = { SECRET: 'test#hash$!value', EMAIL: 'Compound <test@example.com>' };
  expect(parse(renderEnv(values))).toEqual(values);
  expect(() => renderEnv({ KEY: 'a"b' })).toThrow();
});
