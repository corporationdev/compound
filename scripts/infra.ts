import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { getStageKind } from '@compound/config/stage';
import { root, stageFrom, scopedEnv, requireKeys } from './environment';

const args = process.argv.slice(2);
const action = args[0];
if (!['dev', 'deploy', 'destroy'].includes(action ?? '')) throw new Error('Expected dev, deploy, or destroy');
const stage = stageFrom(args);
if (action === 'dev' && getStageKind(stage) !== 'dev') throw new Error('Live development requires a dev stage');
const infra = scopedEnv('packages/infra', stage);
const server = scopedEnv('apps/server', stage);
requireKeys(infra, ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'ALCHEMY_PASSWORD', 'ALCHEMY_STATE_TOKEN']);
const result = spawnSync(process.execPath, ['run', action!], {
  cwd: resolve(root, 'packages/infra'),
  env: { ...process.env, ...server, ...infra, STAGE: stage },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
