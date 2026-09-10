import type { AssetLibrary } from '@compound/assets';

/** Serialize detached writers by canonical project directory, not instance. */
export function createProjectLibraryRunner(deps: {
  attached: (dir: string) => Promise<AssetLibrary | null>;
  create: (dir: string) => AssetLibrary;
}) {
  const pending = new Map<string, Promise<unknown>>();
  return async function withLibrary<T>(dir: string, run: (library: AssetLibrary) => Promise<T>): Promise<T> {
    const task = (pending.get(dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const attached = await deps.attached(dir);
      if (attached) return run(attached);
      const library = deps.create(dir);
      try { await library.load(); return await run(library); }
      finally { await library.dispose(); }
    });
    pending.set(dir, task);
    try { return await task; }
    finally { if (pending.get(dir) === task) pending.delete(dir); }
  };
}
