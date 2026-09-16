import { spawn, spawnSync } from 'node:child_process';
import { root, stageFrom } from './environment';

// Attach this machine's desktop app to a stage another machine is running.
// `bun dev` is the whole stack on this machine's own stage: it starts the
// Convex and server loops and points the shared Convex deployment at that
// stage's bucket. Two machines doing that for one user fight over Convex, so
// the second one attaches instead: it takes the named stage's secrets and
// derived URLs and starts only the desktop. Nothing here writes to Convex or
// deploys a Worker.
//
//   bun dev:client --stage dev-isaacdyor-107806b0
const args = process.argv.slice(2);
if (!args.includes('--stage')) throw new Error('dev:client attaches to a stage another machine runs; name it with --stage <stage>');
const stage = stageFrom(args);
for (const script of ['secrets-inject.ts', 'write-runtime-env.ts']) {
  const result = spawnSync(process.execPath, [`${root}/scripts/${script}`, '--stage', stage], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Attached to ${stage}; starting the desktop only.`);
const desktop = spawn(process.execPath, ['run', 'dev:desktop'], { cwd: root, stdio: 'inherit', detached: process.platform !== 'win32' });
const stop = (code: number) => {
  if (desktop.pid) {
    try {
      if (process.platform === 'win32') desktop.kill('SIGTERM');
      else process.kill(-desktop.pid, 'SIGTERM');
    } catch {
      /* Already stopped. */
    }
  }
  process.exitCode = code;
};
desktop.once('error', () => stop(1));
desktop.once('exit', (code) => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
