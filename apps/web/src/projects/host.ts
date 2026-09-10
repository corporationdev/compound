/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Renderer half of on-disk projects. Projects live as folders under a root
// (persisted) — a stage default until the user picks another; each project's
// package.json is its record (`projectId`, `displayName`, `main`). The
// desktop main process scans, scaffolds, renames, copies, trashes, compiles,
// and watches them. Desktop only for now: without the bridge every call
// rejects and the root is null.
//
// A project is addressed by its folder — an absolute path, which is what main
// takes — and identified by its id, which is what the app's URLs carry and
// what survives the folder being renamed. `resolveProject` is the one bridge
// between the two; callers get the folder from the `ProjectInfo` it answers
// with (and the open project's from `@/context/project`).

import { createSignal } from 'solid-js';

import { MAIN_CHANNELS } from '@desktop/main-channels';
import { mainBridge } from '@/lib/ipc';
import { lastUsedProjectRoot, listProjectRoots, rememberProjectRoot } from '@/lib/db';

import type { CompileResult, ProjectInfo, SourceEdit, WriteResult } from '@desktop/main-channels';

export type { CompileResult, ProjectInfo, SourceEdit, WriteResult };

// The roots live in the app's IndexedDB (see @/lib/db) as a list
// keyed by path. The app works against one of them — the saved selection for the current stage — and
// each stage remembers its own active path in the database metadata.
//
// Reading a database is asynchronous, so the root starts null and arrives a
// tick later. Every call here waits for it, leaving only the UI to tell "no
// root yet" from "no root picked" — which is what `rootsReady` is for.

const [projectsRoot, setProjectsRoot] = createSignal<string | null>(null);
const [rootsReady, setRootsReady] = createSignal(false);

/** The selected/default projects folder; null while initializing or unavailable. */
export { projectsRoot };

/** Whether the saved selection or stage default has finished initializing. */
export { rootsReady };

let projectStage: string | undefined;
const ready = (async () => {
	if (!window.desktop) return;
	const config = await mainBridge.call(MAIN_CHANNELS.CLOUD_CONFIG, undefined);
	projectStage = config.stage;
	const saved = await lastUsedProjectRoot(projectStage);
	const root = saved?.path ?? await mainBridge.call(MAIN_CHANNELS.PROJECTS_DEFAULT_ROOT, undefined);
	if (root) {
		await rememberProjectRoot(root, 'multi', projectStage);
		setProjectsRoot(root);
	}
})()
	.catch((error) => console.error('[projects] could not initialize the projects folder', error))
	.finally(() => setRootsReady(true));

export const isDesktop = (): boolean => !!window.desktop;

/** The initialized projects root, or null when unavailable/off desktop. */
export async function getProjectsRoot(): Promise<string | null> {
	await ready;
	return projectsRoot();
}

/** Opens the native folder picker and remembers the chosen root. */
export async function pickProjectsRoot(): Promise<string | null> {
	await ready;
	const root = await mainBridge.call(MAIN_CHANNELS.PROJECTS_PICK_ROOT, undefined);
	if (!root) return null;

	await rememberProjectRoot(root, 'multi', projectStage);
	setProjectsRoot(root);
	return root;
}

/**
 * The root to work against, waited for and — when there is none to wait for —
 * defaulted to. Null off the desktop, where there is no folder at all, and
 * when the user is asked where to put projects and declines to say.
 */
export async function ensureProjectsRoot(): Promise<string | null> {
	if (!isDesktop()) return null;
	await ready;

	const current = projectsRoot();
	if (current) return current;

	// Nothing picked yet: the default folder, so a first project costs a click
	// rather than a trip through the folder picker. The picker is still there
	// for anyone who wants to say — and for when the default will not do.
	const root = await mainBridge.call(MAIN_CHANNELS.PROJECTS_DEFAULT_ROOT, undefined);
	if (!root) return pickProjectsRoot();

	await rememberProjectRoot(root, 'multi', projectStage);
	setProjectsRoot(root);
	return root;
}

export async function listProjects(): Promise<ProjectInfo[]> {
	await ready;
	const root = projectsRoot();
	if (!root || !isDesktop()) return [];
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_LIST, { root });
}

/** Creates a project folder under the root, named after `displayName`. */
export async function createProject(displayName: string): Promise<ProjectInfo> {
	await ready;
	const root = projectsRoot();
	if (!root) throw new Error('No projects folder selected.');
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_CREATE, { root, displayName });
}

/**
 * The project `ref` names: its id, or — for links made before ids existed,
 * and folders opened by name — its folder name. The active root is searched
 * first (and hands out ids, so the app can put one in the URL); on a miss,
 * the single-project roots answer for projects living anywhere else on disk,
 * matched by id or folder name, most recently used first.
 */
export async function resolveProject(ref: string): Promise<ProjectInfo | null> {
	await ready;
	if (!ref || !isDesktop()) return null;

	const root = projectsRoot();
	if (root) {
		const found = await mainBridge.call(MAIN_CHANNELS.PROJECTS_RESOLVE, { root, ref });
		if (found) return found;
	}

	for (const single of await listProjectRoots('single')) {
		const project = await getProject(single.path);
		if (project && (project.id === ref || project.name === ref)) return project;
	}
	return null;
}

/**
 * Opens the folder `dir` as a project, making it one first when it is not:
 * the folder is created if missing and, when nothing in it can be an entry,
 * given an `index.tsx` holding an empty stage — and nothing else. Remembered
 * as a single-project root unless it lives under the active root (where the
 * ordinary resolution already finds it), so it stays reachable by name or id
 * across relaunches. How `compound open <path>` lands anywhere on disk.
 */
export async function openProjectFolder(dir: string): Promise<ProjectInfo> {
	await ready;
	if (!isDesktop()) throw new Error('Opening a project folder requires the desktop app.');

	const project = await mainBridge.call(MAIN_CHANNELS.PROJECTS_INIT, { dir });

	const root = projectsRoot();
	const underRoot = root !== null && project.dir.startsWith(root.replace(/\/+$/, '') + '/');
	if (!underRoot) await rememberProjectRoot(project.dir, 'single');

	return project;
}

/** The project in the folder `dir`, or null when there is none. */
export async function getProject(dir: string): Promise<ProjectInfo | null> {
	if (!dir || !isDesktop()) return null;
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_GET, { dir });
}

/**
 * Renames the project: `displayName` in the record, and the folder with it.
 * The folder moves, so the answer says where the project now lives — hold on
 * to it. Its id has not changed, and neither has its URL.
 */
export async function renameProject(dir: string, displayName: string): Promise<ProjectInfo> {
	if (!dir) throw new Error('No project folder.');
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_RENAME, { dir, displayName });
}

/** Copies the project in `dir` next to itself and returns the copy (a new id). */
export async function duplicateProject(dir: string): Promise<ProjectInfo> {
	if (!dir) throw new Error('No project folder.');
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_DUPLICATE, { dir });
}

/** Moves the project in `dir` to the trash. */
export async function deleteProject(dir: string): Promise<void> {
	if (!dir) throw new Error('No project folder.');
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_DELETE, { dir });
}

/**
 * What to put in a project's URL: its id, or its folder name while it has
 * none (a folder that predates ids gets one the next time it is opened).
 */
export const projectKey = (project: ProjectInfo): string => project.id || project.name;

export function compileProject(dir: string): Promise<CompileResult> {
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_COMPILE, { dir });
}

/**
 * Writes changed props back into the project's JSX. No compile follows: the
 * canvas is already showing these values, and main keeps the write from
 * reaching the watcher (see `markSelfWrite` in the desktop's projects.ts).
 */
export function writeProject(dir: string, edits: SourceEdit[]): Promise<WriteResult> {
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_WRITE, { dir, edits });
}

/** The project's config (the `compound` field of its package.json), unparsed; null when absent. */
export function readProjectConfig(dir: string): Promise<unknown> {
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_CONFIG_READ, { dir });
}

/** Replaces the project's config (null removes the field). Kept from the watcher like `writeProject`. */
export function writeProjectConfig(dir: string, config: unknown): Promise<void> {
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_CONFIG_WRITE, { dir, config });
}

/**
 * Watches a project folder and calls `onChange` (debounced) when a file
 * inside it changes. Returns the unwatch function.
 */
export function watchProject(dir: string, onChange: (path: string) => void, debounceMs = 80): () => void {
	if (!isDesktop()) return () => {};

	let pending: ReturnType<typeof setTimeout> | undefined;
	let last = '';
	const stop = mainBridge.handle(MAIN_CHANNELS.PROJECTS_CHANGED, (event) => {
		if (event.dir !== dir) return;
		last = event.path;
		clearTimeout(pending);
		pending = setTimeout(() => onChange(last), debounceMs);
	});
	void mainBridge.call(MAIN_CHANNELS.PROJECTS_WATCH, { dir });

	return () => {
		clearTimeout(pending);
		stop();
		void mainBridge.call(MAIN_CHANNELS.PROJECTS_UNWATCH, { dir }).catch(() => {});
	};
}

/** All remembered roots, for explicit CLI targeting independently of navigation. */
export async function listKnownProjects(): Promise<ProjectInfo[]> {
  await ready;
  const roots = await listProjectRoots();
  const active = projectsRoot();
  const dirs = new Set<string>();
  const projects: ProjectInfo[] = [];
  for (const root of [...roots, ...(active && !roots.some(r => r.path === active) ? [{ path: active, kind: 'multi' }] : [])]) {
    const found = root.kind === 'single'
      ? [await getProject(root.path)].filter((p): p is ProjectInfo => !!p)
      : await mainBridge.call(MAIN_CHANNELS.PROJECTS_LIST, { root: root.path });
    for (const project of found) {
      const canonical = await mainBridge.call(MAIN_CHANNELS.PROJECTS_FS_REAL_PATH, { dir: project.dir, source: '.' });
      if (canonical && !dirs.has(canonical)) { dirs.add(canonical); projects.push({ ...project, dir: canonical }); }
    }
  }
  return projects;
}
