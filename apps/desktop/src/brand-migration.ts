import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Copy saved project locations and preferences once, leaving the old app intact. */
export function prepareUserData(appData: string): string {
  const target = join(appData, 'Compound');
  if (existsSync(target)) return target;
  const previous = ['Diffusion Studio', '@diffusionstudio/desktop']
    .map((name) => join(appData, name))
    .find((path) => existsSync(join(path, 'IndexedDB')) || existsSync(join(path, 'Local Storage')));
  if (!previous) {
    mkdirSync(target, { recursive: true });
    return target;
  }
  // Publish only a completed copy. A failed copy can be retried next launch.
  const temporary = mkdtempSync(join(appData, '.compound-migration-'));
  try {
    for (const name of ['IndexedDB', 'Local Storage', 'Preferences']) {
      const source = join(previous, name);
      if (existsSync(source)) cpSync(source, join(temporary, name), { recursive: true });
    }
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return target;
}
