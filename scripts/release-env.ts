import { resolveRuntimeContext } from '@compound/config/runtime';
import { renderEnvTemplate, writePrivate } from './environment';

// Releases derive public URLs from committed production identity. No vault access is needed.
const runtime = resolveRuntimeContext('prod');
writePrivate(
  'apps/web/.env',
  renderEnvTemplate('apps/web', { STAGE: runtime.stage, ...runtime.webClientEnv }),
);
writePrivate(
  'apps/desktop/runtime-config.json',
  JSON.stringify(runtime.desktopConfig, null, 2) + '\n',
);
console.log('Prepared stage-derived production client configuration.');
