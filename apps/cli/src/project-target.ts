import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CliProjectTarget } from './cli-channels';

/** Explicit choice wins. CWD discovery never depends on editor navigation. */
export async function resolveCliTarget(cwd: string, project?: string): Promise<CliProjectTarget> {
  if (project) {
    const candidate = resolve(cwd, project.startsWith('~/') ? homedir() + project.slice(1) : project);
    if (await stat(candidate).then(s => s.isDirectory(), () => false)) return { dir: await realpath(candidate) };
    if (project.includes('/') || project.startsWith('.')) throw new Error(`Project directory does not exist: ${candidate}`);
    return { ref: project };
  }
  let dir = await realpath(cwd);
  for (;;) {
    const pkg = await readFile(resolve(dir, 'package.json'), 'utf8').then(text => { try { return JSON.parse(text); } catch { return null; } }, () => null);
    if (typeof pkg?.projectId === 'string' && pkg.projectId.trim()) return { dir };
    const parent = dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}
