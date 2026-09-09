import { spawn, spawnSync } from 'node:child_process';
import { root, stageFrom } from './environment';
const stage = stageFrom(process.argv.slice(2));
// Refresh the selected vault and runtime once before starting parallel watchers.
const setup = spawnSync(process.execPath, [`${root}/scripts/setup.ts`, '--stage', stage], { cwd: root, stdio: 'inherit' });
if (setup.status !== 0) process.exit(setup.status ?? 1);
let stopping = false;
const children: ReturnType<typeof spawn>[] = [];
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid) continue;
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Already stopped. */
    }
  }
  process.exitCode = code;
}
for (const script of ['dev:backend', 'dev:infra', 'dev:desktop']) {
  const args = ['run', script, ...(script === 'dev:desktop' ? [] : ['--stage', stage])];
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  children.push(child);
  child.once('error', () => stop(1));
  child.once('exit', (code) => stop(code ?? 1));
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
