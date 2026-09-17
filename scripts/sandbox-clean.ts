import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { linkedWorktreeRoot } from '@compound/config/stage';
import { root, stageFrom } from './environment';
import { sandboxInfo } from './sandbox-info';

// Removes everything a sandbox stage owns: its Cloudflare resources (Worker,
// bucket, tunnel) through Alchemy, its local Convex database, its Electron
// profile and its checked-out projects folder. Run it from the worktree
// before `git worktree remove`; the worktree itself is left for git.
//
//   bun run sandbox:clean            # this worktree's stage
//   bun run sandbox:clean --keep-cloud   # local state only
const args = process.argv.slice(2);
const stage = stageFrom(args);
const info = sandboxInfo(stage);
if (info.kind !== 'sandbox') throw new Error(`${stage} is not a sandbox stage; clean only removes worktree sandboxes`);
if (!args.includes('--keep-cloud')) {
  const alchemy = resolve(root, 'packages/infra/.alchemy');
  if (existsSync(alchemy)) {
    const result = spawnSync(process.execPath, ['run', 'destroy', '--stage', stage], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`Alchemy destroy failed for ${stage}; fix that before removing local state`);
  } else console.log(`No Alchemy state for ${stage} here; nothing to destroy in Cloudflare.`);
}
const movies = process.platform === 'darwin' ? join(homedir(), 'Movies') : process.platform === 'win32' ? join(homedir(), 'Videos') : join(homedir(), 'Videos');
for (const path of [
  resolve(root, 'packages/backend/.convex'),
  info.electronProfile!,
  join(movies, info.projectsFolderName),
]) {
  if (!existsSync(path)) continue;
  rmSync(path, { recursive: true, force: true });
  console.log(`Removed ${path}`);
}
const worktree = linkedWorktreeRoot(root);
console.log(worktree
  ? `Sandbox ${stage} cleaned. Remove the checkout with: git worktree remove ${worktree}`
  : `Sandbox ${stage} cleaned.`);
