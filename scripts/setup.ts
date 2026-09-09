import { spawnSync } from 'node:child_process';
import { root, stageFrom, scopedEnv } from './environment';
import { isProjectPreviewKey } from './convex-target';
const args = process.argv.slice(2);
for (const [script, command] of [['secrets-inject.ts', []], ['write-runtime-env.ts', []], ['backend.ts', ['sync']]] as const) {
  const result = spawnSync(process.execPath, [`${root}/scripts/${script}`, ...command, ...args], {
    stdio: 'inherit',
    cwd: root,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (script === 'secrets-inject.ts' && isProjectPreviewKey(scopedEnv('packages/backend', stageFrom(args)).CONVEX_DEPLOY_KEY ?? '')) {
    console.log('Preview credentials injected. Run deploy to create the Convex preview and derive its runtime configuration.');
    break;
  }
}
