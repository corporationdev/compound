import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deployment } from '@compound/config/deployment';
import { stagePorts } from '@compound/config/ports';
import { getStageKind } from '@compound/config/stage';
import { root, stageFrom, scopedEnv, requireKeys, renderEnv } from './environment';
import { convexTarget, validateProjectPreviewKey } from './convex-target';

const args = process.argv.slice(2);
const action = args[0];
if (!['sync', 'deploy', 'dev', 'preview'].includes(action ?? '')) throw new Error('Expected sync, deploy, dev, or preview');
const stage = stageFrom(args);
const backend = scopedEnv('packages/backend', stage);
// A sandbox stage runs the Convex backend on this machine, so it has no deploy key.
const sandbox = getStageKind(stage) === 'sandbox';
requireKeys(backend, [...(sandbox ? [] : ['CONVEX_DEPLOY_KEY']), 'BETTER_AUTH_SECRET', 'RESEND_API_KEY']);
if (action === 'preview') validateProjectPreviewKey(stage, backend.CONVEX_DEPLOY_KEY);
if (sandbox && action === 'deploy') throw new Error('Sandbox stages develop live; use dev');
const target = action === 'preview' ? { preview: true }
  : sandbox ? { url: backend.CONVEX_URL, preview: false }
  : convexTarget(stage, backend.CONVEX_DEPLOY_KEY, backend.CONVEX_URL);
if (action !== 'preview') requireKeys(backend, ['CONVEX_URL', 'SITE_URL', 'RESEND_FROM_EMAIL']);
if (backend.BETTER_AUTH_SECRET.length < 32) throw new Error('BETTER_AUTH_SECRET needs at least 32 random characters');
const cwd = resolve(root, 'packages/backend');
/**
 * Where the Convex CLI and local backend keep temp files for a sandbox. They
 * rename built modules from there into the deployment's storage, which fails
 * across filesystems (a tmpfs /tmp on Linux), and they bind Unix sockets
 * there, whose paths Linux caps at 108 bytes. So: the OS temp dir when it
 * shares a filesystem with the state (macOS), otherwise a short per-stage
 * directory under the home cache, which is on the same filesystem as any
 * checkout under home. Null means leave the environment alone.
 */
function convexTempDir(): string | null {
  const state = resolve(cwd, '.convex');
  mkdirSync(state, { recursive: true });
  if (statSync(tmpdir()).dev === statSync(state).dev) return null;
  const dir = join(homedir(), '.cache', 'compound', 'convex-tmp', createHash('sha256').update(stage).digest('hex').slice(0, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}
const convexTmp = sandbox ? convexTempDir() : null;
/**
 * The local deployment the Convex CLI created for this checkout, if any. Its
 * state lives beside the functions, so every worktree has its own; the CLI
 * suffixes the name when another checkout on this machine took it first.
 */
function localDeploymentName(): string | null {
  const file = resolve(cwd, '.convex/local/default/config.json');
  if (!existsSync(file)) return null;
  const name = JSON.parse(readFileSync(file, 'utf8')).deploymentName;
  return typeof name === 'string' && name ? name : null;
}
const ports = stagePorts(stage);
if (sandbox) {
  // The local backend runs "use node" actions with the Node on PATH and refuses versions it does not know.
  const version = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const major = Number(version.match(/^v(\d+)/)?.[1]);
  if (![20, 22, 24].includes(major))
    throw new Error(`Convex's local backend needs Node 20, 22 or 24 first on PATH; found ${version || 'none'}. Install one (for example under ~/.local/node22) and prepend its bin to PATH.`);
}
// Until the first run creates the local deployment, configure one in the committed project.
const sandboxArgs = () => [
  ...(localDeploymentName() ? [] : ['--configure', 'existing', '--team', deployment.convexTeamSlug, '--project', deployment.convexProjectSlug, '--dev-deployment', 'local']),
  '--local-cloud-port', String(ports.convexCloud),
  '--local-site-port', String(ports.convexSite),
];
const run = (command: string[], quiet = false) => {
  const local = sandbox ? localDeploymentName() : null;
  const result = spawnSync(resolve(root, 'node_modules/.bin/convex'), command, {
    cwd,
    env: {
      ...process.env,
      // See convexTempDir; TMPDIR is what the backend binary reads, CONVEX_TMPDIR the CLI.
      ...(convexTmp ? { CONVEX_TMPDIR: convexTmp, TMPDIR: convexTmp } : {}),
      STAGE: stage,
      // Empty values shadow the injected .env so the CLI never selects the shared cloud deployment for a sandbox.
      CONVEX_DEPLOYMENT: local ? `local:${local}` : '',
      CONVEX_DEPLOY_KEY: sandbox ? '' : backend.CONVEX_DEPLOY_KEY,
    },
    stdio: quiet ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) throw new Error(`Convex ${command[0]} failed (exit ${result.status})`);
};
if (action === 'preview') {
  run(['deploy', '--yes', '--preview-name', stage, '--cmd-url-env-var-name', 'CONVEX_URL', '--cmd', 'bun ../../scripts/preview-runtime.ts']);
} else if (action === 'sync') {
  // Environment variables are set on a deployment, so a sandbox creates and pushes its own first.
  if (sandbox) run(['dev', '--once', ...sandboxArgs()]);
  const temporary = mkdtempSync(resolve(tmpdir(), 'compound-convex-'));
  try {
    const file = resolve(temporary, 'runtime.env');
    const keys = ['STAGE', 'SITE_URL', 'BETTER_AUTH_SECRET', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'CLOUDFLARE_ACCOUNT_ID', 'MEDIA_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'DEEPGRAM_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'APIFY_TOKEN'];
    requireKeys(backend, keys);
    writeFileSync(file, renderEnv(Object.fromEntries(keys.map((key) => [key, backend[key]]))), { mode: 0o600 });
    run(['env', 'set', ...(target.preview ? ['--preview-name', stage] : []), '--from-file', file, '--force'], true);
    console.log(`Synced Convex runtime environment for ${stage}.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
} else {
  if (action === 'dev' && !['dev', 'sandbox'].includes(getStageKind(stage))) throw new Error('Live development requires a dev or sandbox stage');
  run([action!, ...(action === 'deploy' ? ['--yes', ...(target.preview ? ['--preview-name', stage] : [])] : sandbox ? sandboxArgs() : [])]);
}
