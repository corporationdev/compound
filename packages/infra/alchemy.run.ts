import { existsSync } from 'node:fs';
import { resolveRuntimeContext } from '@compound/config/runtime';
import { release } from '@compound/config/release';
import alchemy from 'alchemy';
import { R2Bucket, Tunnel, Worker, Vite } from 'alchemy/cloudflare';
import { CloudflareStateStore } from 'alchemy/state';
import { config } from 'dotenv';

config({ path: './.env', override: false, quiet: true });
config({ path: '../../apps/server/.env', override: false, quiet: true });
config({ path: '../backend/.env.local', override: false, quiet: true });

const stage = process.env.STAGE?.trim() || 'dev';
const runtime = resolveRuntimeContext(stage, { convexUrl: process.env.CONVEX_URL });
const useServerTunnel = runtime.stageKind === 'dev' || runtime.stageKind === 'sandbox';

const app = await alchemy('compound', {
  adopt: true,
  stage,
  stateStore: process.env.CI
    ? (scope) => new CloudflareStateStore(scope, {
        scriptName: `compound-alchemy-state-${runtime.envTier}`,
      })
    : undefined,
});

export const mediaBucket = await R2Bucket('media', {
  adopt: true,
  name: runtime.bucket,
  devDomain: false,
  dev: { remote: true },
  empty: runtime.stageKind === 'preview',
  cors: [{
    allowed: { origins: [runtime.webUrl], methods: ['PUT', 'GET', 'HEAD'], headers: ['Content-Type', 'Range'] },
    exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
    maxAgeSeconds: 3600,
  }],
  lifecycle: [{
    id: 'temporary-media',
    enabled: true,
    conditions: { prefix: 'media/' },
    deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } },
  }, {
    id: 'temporary-library-staging', enabled: true,
    conditions: { prefix: 'library-staging/' },
    deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } },
  }],
});

export const server = await Worker('server', {
  // Adopt the dev Worker already provisioned during initial setup.
  name: `compound-media-${stage}`,
  adopt: true,
  cwd: '../../apps/server',
  entrypoint: 'src/index.ts',
  compatibility: 'node',
  compatibilityDate: '2026-05-01',
  domains: useServerTunnel ? undefined : [runtime.serverHostname],
  url: true,
  observability: { enabled: false },
  bindings: {
    MEDIA: mediaBucket,
    MEDIA_BUCKET_NAME: mediaBucket.name,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID!,
    CONVEX_URL: runtime.convexUrl,
    CORS_ORIGIN: runtime.webUrl,
    R2_ACCESS_KEY_ID: alchemy.secret.env('R2_ACCESS_KEY_ID'),
    R2_SECRET_ACCESS_KEY: alchemy.secret.env('R2_SECRET_ACCESS_KEY'),
    DEEPGRAM_API_KEY: alchemy.secret.env('DEEPGRAM_API_KEY'),
    GOOGLE_GENERATIVE_AI_API_KEY: alchemy.secret.env('GOOGLE_GENERATIVE_AI_API_KEY'),
  },
  dev: { port: 3000 },
});

export const serverTunnel = useServerTunnel
  ? await Tunnel('server-tunnel', {
      name: `compound-server-${stage}`,
      adopt: true,
      apiToken: alchemy.secret.env('CLOUDFLARE_API_TOKEN'),
      ingress: [
        { hostname: runtime.serverHostname, service: 'http://localhost:3000' },
        { service: 'http_status:404' },
      ],
    })
  : undefined;

// PostBob hosts its web frontend through Alchemy Vite outside local development.
export const web = !useServerTunnel
  ? await Vite('web', {
      name: `compound-web-${stage}`,
      adopt: true,
      cwd: '../../apps/web',
      assets: 'dist',
      build: { command: 'bun run build', env: runtime.webClientEnv, memoize: false },
      domains: [new URL(runtime.webUrl).hostname],
      compatibilityDate: '2026-05-01',
    })
  : undefined;

export const releases = runtime.stageKind === 'production'
  ? await R2Bucket('releases', {
      name: release.bucket, adopt: true, devDomain: false, delete: false,
    })
  : undefined;

export const landing = runtime.landingHostname
  ? await Vite('landing', {
      name: `compound-landing-${stage}`,
      adopt: true,
      cwd: '../../apps/landing',
      entrypoint: 'worker/index.ts',
      assets: { directory: 'dist', run_worker_first: ['/download', '/releases/*'] },
      spa: false,
      build: { command: 'bun run build', memoize: false },
      bindings: releases ? { RELEASES: releases } : {},
      domains: [runtime.landingHostname],
      compatibilityDate: '2026-05-01',
    })
  : undefined;

if (serverTunnel && app.local) {
  const cloudflared = [
    '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared',
  ].find(existsSync);
  if (!cloudflared) throw new Error('Install cloudflared to run the dev server tunnel.');
  await app.spawn('server-tunnel', {
    cmd: `${cloudflared} tunnel run`,
    env: { TUNNEL_TOKEN: serverTunnel.token.unencrypted },
    processName: 'cloudflared',
    quiet: true,
  });
}

console.log(`Stage -> ${stage}`);
console.log(`Server -> ${useServerTunnel ? runtime.serverUrl : server.url}`);
if (web) console.log(`Web -> ${runtime.webUrl}`);
await app.finalize();
