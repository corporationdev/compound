import { spawnSync } from 'node:child_process';
import { root, stageFrom, scopedEnv } from './environment';
import { isProjectPreviewKey } from './convex-target';
import { writeRuntime } from './write-runtime-env';

const stage = stageFrom(process.argv.slice(2));
const preview = isProjectPreviewKey(scopedEnv('packages/backend', stage).CONVEX_DEPLOY_KEY ?? '');
if (!preview) writeRuntime(stage);
const steps = preview
  ? [['modal-aligner.ts', 'deploy'], ['backend.ts', 'preview'], ['backend.ts', 'sync'], ['infra.ts', 'deploy'], ['catalog.ts', 'publish']]
  : [['modal-aligner.ts', 'deploy'], ['backend.ts', 'sync'], ['backend.ts', 'deploy'], ['infra.ts', 'deploy'], ['catalog.ts', 'publish']];
for (const [script, action] of steps) {
  const result = spawnSync(process.execPath, [`${root}/scripts/${script}`, action, '--stage', stage], {
    cwd: root, stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
