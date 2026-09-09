import { spawnSync } from 'node:child_process';
import { root } from './environment';
const args = process.argv.slice(2);
for (const [script, command] of [['secrets-inject.ts', []], ['write-runtime-env.ts', []], ['backend.ts', ['sync']]] as const) {
  const result = spawnSync(process.execPath, [`${root}/scripts/${script}`, ...command, ...args], {
    stdio: 'inherit',
    cwd: root,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
