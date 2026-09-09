import { getStageKind } from '@compound/config/stage';
import { resolveRuntimeContext } from '@compound/config/runtime';
import { convexTarget } from './convex-target';
import {
  stageFrom,
  scopedEnv,
  readEnv,
  requireKeys,
  writePrivate,
  renderEnvTemplate,
} from './environment';

export const workerSecretKeys = [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'DEEPGRAM_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
] as const;
export function writeRuntime(stage: string) {
  const server = scopedEnv('apps/server', stage);
  const backend = scopedEnv('packages/backend', stage);
  const infra = scopedEnv('packages/infra', stage);
  requireKeys(infra, ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'ALCHEMY_PASSWORD', 'ALCHEMY_STATE_TOKEN']);
  requireKeys(server, ['CLOUDFLARE_ACCOUNT_ID', ...workerSecretKeys]);
  requireKeys(backend, ['CONVEX_DEPLOY_KEY']);
  const local = getStageKind(stage) === 'dev' ? readEnv('packages/backend/.env.local') : {};
  // Deployment outputs override discovery; stale generated app .env URLs are never inputs.
  const convexUrl = convexTarget(stage, backend.CONVEX_DEPLOY_KEY!, process.env.CONVEX_URL?.trim() || local.CONVEX_URL).url;
  const runtime = resolveRuntimeContext(stage, { convexUrl });
  if (!/^[a-f0-9]{32}$/.test(server.CLOUDFLARE_ACCOUNT_ID!))
    throw new Error('Invalid Cloudflare account id');
  const backendValues: Record<string, string> = {
    ...backend,
    ...runtime.backendEnv,
    CONVEX_URL: runtime.convexUrl,
    CONVEX_SITE_URL: runtime.convexSiteUrl,
  };
  const serverValues: Record<string, string> = { ...server, ...runtime.serverBindings };
  writePrivate('packages/backend/.env', renderEnvTemplate('packages/backend', backendValues));
  writePrivate('apps/server/.env', renderEnvTemplate('apps/server', serverValues));
  writePrivate(
    'apps/web/.env',
    renderEnvTemplate('apps/web', { STAGE: stage, ...runtime.webClientEnv }),
  );
  writePrivate(
    'apps/desktop/runtime-config.json',
    JSON.stringify(runtime.desktopConfig, null, 2) + '\n',
  );
  return {
    config: runtime.desktopConfig,
    server: serverValues,
    backend: backendValues,
    bucket: runtime.bucket,
    infra,
  };
}
if (import.meta.main) {
  writeRuntime(stageFrom(process.argv.slice(2)));
  console.log('Wrote stage-derived runtime configuration.');
}
