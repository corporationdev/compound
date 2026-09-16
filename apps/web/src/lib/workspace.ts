/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The active organization's workspace on this machine: which folder it is,
// what is in it, which projects it holds, and what cloud sync is doing for
// it. One store for the app. Main owns the folder (see the desktop's
// workspace.ts) and the sync engine; this asks for the folder when the
// active organization changes, watches it, and keeps its listing and sync
// status as signals for the dashboard and the editor to read.

import { createEffect, createMemo, createResource, createRoot, createSignal, on, onCleanup } from 'solid-js';
import { toast } from 'somoto';

import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { ProjectInfo, SyncStatus, WorkspaceEntry, WorkspaceFile, WorkspaceInfo, WorkspaceWriteResult } from '@desktop/main-channels';
import { mainBridge } from '@/lib/ipc';
import { requireNativeSessionToken } from '@/lib/cloud-session';
import { moveProjectRecord } from '@/lib/db';
import { activeOrganization, cloudUserId } from '@/lib/organizations';

export type { ProjectInfo, SyncStatus, WorkspaceEntry, WorkspaceFile, WorkspaceInfo, WorkspaceWriteResult };

export const isDesktop = (): boolean => !!window.desktop;

// ---------------------------------------------------------------------------
// The root: the folder every organization's workspace goes under

const ROOT_STORAGE_KEY = 'compound:workspace-root';
/** Where the projects root lived before workspaces; adopted as the workspace root on upgrade. */
const LEGACY_ROOT_STORAGE_KEY = 'compound:projects-root';

const storedRoot = (): string | null => {
  try {
    return window.localStorage.getItem(ROOT_STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_ROOT_STORAGE_KEY);
  } catch {
    return null;
  }
};

const [workspaceRoot, setWorkspaceRoot] = createSignal<string | null>(storedRoot());

/** The folder workspaces are made under: null off the desktop and until one is chosen. */
export { workspaceRoot };

function rememberRoot(root: string): void {
  try {
    window.localStorage.setItem(ROOT_STORAGE_KEY, root);
  } catch (error) {
    console.warn('[workspace] could not store the root', error);
  }
  setWorkspaceRoot(root);
}

/** The root to work against, defaulted to when there is none; null when the user declines to pick one. */
async function ensureRoot(): Promise<string | null> {
  const current = workspaceRoot();
  if (current) return current;
  const root = await mainBridge.call(MAIN_CHANNELS.PROJECTS_DEFAULT_ROOT, undefined);
  if (!root) return pickWorkspaceRoot();
  rememberRoot(root);
  return root;
}

/** Opens the native folder picker for a new root; the active organization's workspace is made under it. */
export async function pickWorkspaceRoot(): Promise<string | null> {
  if (!isDesktop()) return null;
  const root = await mainBridge.call(MAIN_CHANNELS.PROJECTS_PICK_ROOT, undefined);
  if (!root) return null;
  rememberRoot(root);
  return root;
}

// ---------------------------------------------------------------------------
// The workspace

const store = createRoot(() => {
  // null off the desktop, while no organization is active, and until main has answered.
  const [workspace, setWorkspace] = createSignal<WorkspaceInfo | null>(null);
  const [workspaceError, setWorkspaceError] = createSignal<string | null>(null);
  // Bumped on every change under the folder, coalesced; the listings refetch on it.
  const [revision, setRevision] = createSignal(1);
  const [syncStatus, setSyncStatus] = createSignal<SyncStatus | null>(null);
  const listeners = new Set<(path: string) => void>();

  // Which folder: asked of main whenever the active organization changes.
  createEffect(on(
    () => [activeOrganization()?.id, activeOrganization()?.name, workspaceRoot()] as const,
    () => {
      const organization = activeOrganization();
      setWorkspace(null);
      setWorkspaceError(null);
      if (!organization || !isDesktop()) return;
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      void (async () => {
        try {
          const root = await ensureRoot();
          if (!root) throw new Error('Choose a folder for your workspace first.');
          const info = await mainBridge.call(MAIN_CHANNELS.WORKSPACE_OPEN, { root, organizationId: organization.id, name: organization.name });
          if (cancelled) return;
          // Records follow the folders that moved, so the list, covers and
          // last-opened times carry over.
          for (const { from, to } of info.moved) await moveProjectRecord(from, to).catch(() => { });
          setWorkspace(info);
          if (info.moved.length > 0) {
            toast(`Moved ${info.moved.length} project${info.moved.length === 1 ? '' : 's'} into your workspace`, {
              description: `${info.dir}/projects`,
            });
          }
        } catch (error) {
          if (cancelled) return;
          setWorkspaceError((error as Error).message);
        }
      })();
    },
  ));

  // Watching: every change under the folder bumps the revision and reaches
  // whoever asked for paths (the open document).
  createEffect(() => {
    const current = workspace();
    if (!current) return;
    const { dir } = current;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const stop = mainBridge.handle(MAIN_CHANNELS.WORKSPACE_CHANGED, (event) => {
      if (event.dir !== dir) return;
      for (const listener of listeners) listener(event.path);
      clearTimeout(pending);
      pending = setTimeout(() => setRevision((value) => value + 1), 80);
    });
    void mainBridge.call(MAIN_CHANNELS.WORKSPACE_WATCH, { dir }).catch((error) => {
      console.warn('[workspace] could not watch', error);
    });
    onCleanup(() => {
      clearTimeout(pending);
      stop();
      mainBridge.call(MAIN_CHANNELS.WORKSPACE_UNWATCH, { dir }).catch(() => { });
    });
  });

  // Sync: runs while a signed-in user has the workspace open; main stops it
  // on sign-out too, and stopping twice is harmless.
  createEffect(() => {
    const current = workspace();
    if (!current || !cloudUserId()) {
      setSyncStatus(null);
      return;
    }
    const { dir, organizationId } = current;
    setSyncStatus({ state: 'starting', pending: 0, skipped: [] });
    void (async () => {
      try {
        const sessionToken = await requireNativeSessionToken();
        const status = await mainBridge.call(MAIN_CHANNELS.SYNC_START, { dir, organizationId, sessionToken });
        setSyncStatus(status);
        // The checkout is in: list once more with every project folder known.
        setRevision((value) => value + 1);
      } catch (error) {
        console.error('[sync] could not start:', error);
        setSyncStatus({ state: 'error', pending: 0, skipped: [], error: (error as Error).message });
        toast.error('Workspace sync failed to start', { description: (error as Error).message });
      }
    })();
    onCleanup(() => {
      mainBridge.call(MAIN_CHANNELS.SYNC_STOP, { dir }).catch((error) => console.warn('[sync] could not stop:', error));
      setSyncStatus(null);
    });
  });

  mainBridge.handle(MAIN_CHANNELS.SYNC_STATUS, ({ dir, status }) => {
    if (dir === workspace()?.dir) setSyncStatus(status);
  });
  mainBridge.handle(MAIN_CHANNELS.SYNC_CONFLICT, ({ path, keptCopy }) => {
    toast.warning(`Merged a teammate's change to ${path}`, {
      description: `Their version of the conflicting lines was kept at ${keptCopy}`,
      duration: 12_000,
    });
  });

  const [entries] = createResource(
    () => (workspace() ? { dir: workspace()!.dir, revision: revision() } : null),
    async ({ dir }) => mainBridge.call(MAIN_CHANNELS.WORKSPACE_LIST, { dir }),
  );
  const [projects] = createResource(
    () => (workspace() ? { dir: workspace()!.dir, revision: revision() } : null),
    async ({ dir }) => mainBridge.call(MAIN_CHANNELS.WORKSPACE_PROJECTS, { dir }),
  );

  const workspaceDir = createMemo(() => workspace()?.dir ?? null);

  return { workspace, workspaceDir, workspaceError, revision, syncStatus, entries, projects, listeners };
});

export const { workspace, workspaceDir, workspaceError, syncStatus: workspaceSyncStatus } = store;

/** Everything in the workspace, depth first; undefined until listed, and while there is no workspace. */
export const workspaceEntries = (): WorkspaceEntry[] | undefined => store.entries.latest;

/** Every project folder in the workspace; undefined until listed. */
export const workspaceProjects = (): ProjectInfo[] | undefined => store.projects.latest;

/** The path separator main uses for the workspace folder. */
export const pathSeparator = (): string => (window.desktop?.platform === 'win32' ? '\\' : '/');

/** `path` (workspace-relative, `/`-separated) as an absolute path on this machine. */
export function absolutePath(path: string): string | null {
  const dir = workspaceDir();
  if (!dir) return null;
  return path ? dir + pathSeparator() + path.split('/').join(pathSeparator()) : dir;
}

/** The workspace-relative path of an absolute folder inside the workspace, or null when it is outside. */
export function relativePath(absolute: string): string | null {
  const dir = workspaceDir();
  if (!dir) return null;
  const separator = pathSeparator();
  const prefix = dir.endsWith(separator) ? dir : dir + separator;
  if (absolute === dir) return '';
  if (!absolute.startsWith(prefix)) return null;
  return absolute.slice(prefix.length).split(separator).join('/');
}

/** Whether an absolute folder sits inside the workspace. */
export const isInWorkspace = (absolute: string): boolean => relativePath(absolute) !== null;

/** Calls `listener` with every path that changes under the workspace, until the returned function is called. */
export function onWorkspaceChange(listener: (path: string) => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Files

function requireDir(): string {
  const dir = workspaceDir();
  if (!dir) throw new Error('No workspace is open.');
  return dir;
}

export function readWorkspaceFile(path: string): Promise<WorkspaceFile | null> {
  return mainBridge.call(MAIN_CHANNELS.WORKSPACE_READ, { dir: requireDir(), path });
}

/**
 * Writes `text`. `base` is the text last read or written for the file;
 * when the file changed since, main merges the two and answers with what
 * landed (see the desktop's workspace.ts).
 */
export function writeWorkspaceFile(path: string, text: string, base?: string | null): Promise<WorkspaceWriteResult> {
  return mainBridge.call(MAIN_CHANNELS.WORKSPACE_WRITE, { dir: requireDir(), path, text, base });
}

/** Makes a file or folder; answers the path it got (numbered when the name was taken). */
export function createWorkspaceEntry(path: string, kind: 'file' | 'directory'): Promise<string> {
  return mainBridge.call(MAIN_CHANNELS.WORKSPACE_CREATE, { dir: requireDir(), path, kind });
}

export function renameWorkspaceEntry(from: string, to: string): Promise<void> {
  return mainBridge.call(MAIN_CHANNELS.WORKSPACE_RENAME, { dir: requireDir(), from, to });
}

/** Moves the entry to the trash. */
export function removeWorkspaceEntry(path: string): Promise<void> {
  return mainBridge.call(MAIN_CHANNELS.WORKSPACE_REMOVE, { dir: requireDir(), path });
}

// ---------------------------------------------------------------------------
// Routes

/** Route for the file or folder at `path` (workspace-relative), shown in the dashboard shell. */
export const workspaceRoute = (path: string): string =>
  path ? `/workspace/${path.split('/').map(encodeURIComponent).join('/')}` : '/workspace';

/** The parent folder of a workspace path ('' at the root). */
export const parentPath = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The last segment of a workspace path. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The file name without its extension: what a document is titled. */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The extension, lower-cased and without the dot; '' when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}
