import { spawnSync } from 'node:child_process';
import { root, stageFrom } from './environment';
import { writeRuntime } from './write-runtime-env';

const stage = stageFrom(process.argv.slice(2));
writeRuntime(stage);
for (const [script, action] of [['backend.ts', 'sync'], ['backend.ts', 'deploy'], ['infra.ts', 'deploy']]) {
  const result = spawnSync(process.execPath, [`${root}/scripts/${script}`, action, '--stage', stage], {
    cwd: root, stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
