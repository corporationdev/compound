/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


import { createEffect, createMemo, createRoot, createSignal, on } from 'solid-js';

import { MAIN_CHANNELS } from '@desktop/main-channels';
import { mainBridge } from '@/lib/ipc';
import {
	findProjectRecords,
	forgetProject as forgetProjectRecord,
	listProjectRecords,
	moveProjectRecord,
	rememberProject,
	updateProjectRecord,
} from '@/lib/db';
import { isInWorkspace, pathSeparator, workspace, workspaceDir, workspaceProjects } from '@/lib/workspace';

import type { CompileResult, ProjectInfo, SourceEdit, WriteResult } from '@desktop/main-channels';
import type { ProjectRecord } from '@/lib/db';

export type { CompileResult, ProjectInfo, ProjectRecord, SourceEdit, WriteResult };

/** The starter folder projects are created in, inside the workspace. */
const PROJECTS_FOLDER = 'projects';

// New projects go in the workspace's projects folder. The workspace is the
// active organization's, so this follows the organization switcher; null off
// the desktop and until the workspace has been opened.
const projectsRoot = createRoot(() => createMemo(() => {
	const dir = workspaceDir();
	return dir ? dir + pathSeparator() + PROJECTS_FOLDER : null;
}));

/** The folder new projects are created in: null until the workspace is open. */
export { projectsRoot };

// Bumped whenever the list of known projects changes — one created, opened,
// renamed, copied, or deleted — so a view listing them can refetch on it.
const [projectsRevision, setProjectsRevision] = createSignal(1);

/**
 * What a list of projects follows: the records here (a create, a forget),
 * and the workspace's own scan of its folders, which moves when a project
 * lands from another machine or when a folder made here is seen by the
 * watcher. A view keyed on the records alone refetched too early after a
 * create, read the stale scan, and never asked again.
 */
export const projectsListKey = () => `${projectsRevision()}:${(workspaceProjects() ?? []).map((project) => `${project.dir}@${project.modifiedAt}`).join('\n')}`;

/**
 * Records handed out last time, by folder. A list rebuilt with the same
 * record for a folder answers the same object, so a view keyed on identity
 * keeps that project's element rather than making it again on every refetch.
 */
const handedOut = new Map<string, ProjectRecord>();
function stable(record: ProjectRecord): ProjectRecord {
	const previous = handedOut.get(record.dir);
	if (previous && JSON.stringify(previous) === JSON.stringify(record)) return previous;
	handedOut.set(record.dir, record);
	return record;
}

/** Changes whenever the list `listProjects` answers with would; a source for `createResource`. */
export { projectsRevision };

/** Tells the views the list changed, for a change made to the records directly (a cover landing). */
export function markProjectsChanged(): void {
	setProjectsRevision((revision) => revision + 1);
}

// The workspace's projects are part of the list: when its walk answers, or
// answers differently after a change on disk, the views refetch. Keyed on
// what the walk found rather than the array, which is new on every listing.
const projectsKey = () => (workspaceProjects() ?? []).map((project) => `${project.dir}\0${project.modifiedAt}\0${project.displayName}`).join('\n');
createRoot(() => createEffect(on(projectsKey, () => setProjectsRevision((revision) => revision + 1), { defer: true })));

export const isDesktop = (): boolean => !!window.desktop;

/** Puts `project` on the list (or marks it just opened) and tells the views. */
async function remember(project: ProjectInfo): Promise<void> {
	await rememberProject(project);
	setProjectsRevision((revision) => revision + 1);
}

/**
 * Opens the native folder picker for a folder to open as a single project.
 * Unlike the workspace it changes nothing on its own — hand the path to
 * `openProjectFolder`, which is what makes the folder a project.
 */
export async function pickProjectFolder(): Promise<string | null> {
	if (!isDesktop()) return null;
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_PICK_FOLDER, undefined);
}

/** How long a caller waits for the workspace to open before giving up. */
const WORKSPACE_WAIT_MS = 15_000;

/**
 * The folder new projects go in, once the workspace is open. Null off the
 * desktop, where there is no folder at all, and when the workspace does not
 * open in time (no organization yet, or the user declined to pick a root).
 */
export async function ensureProjectsRoot(): Promise<string | null> {
	if (!isDesktop()) return null;
	const current = projectsRoot();
	if (current) return current;
	const until = Date.now() + WORKSPACE_WAIT_MS;
	while (Date.now() < until) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		const root = projectsRoot();
		if (root) return root;
	}
	return null;
}

/**
 * The projects the app knows: every project folder in the workspace, plus
 * any folder opened from elsewhere on disk that is still on record. A
 * workspace project that has a record (a cover, a last-opened time) shows
 * with it; one that has none shows as its folder describes it. Records for
 * folders inside the workspace that the walk did not find are dropped from
 * the answer: the folder is gone or no longer a project.
 */
export async function listProjects(): Promise<ProjectRecord[]> {
	if (!isDesktop()) return [];
	const records = await listProjectRecords();
	// The folders as they are now, not the last scan: a project made a moment ago is on disk before the watcher says so.
	const found = workspace() ? await mainBridge.call(MAIN_CHANNELS.WORKSPACE_PROJECTS, { dir: workspace()!.dir }) : [];
	const byDir = new Map(records.map((record) => [record.dir, record] as const));
	const now = new Date().toISOString();
	const list: ProjectRecord[] = found.map((project) => {
		const record = byDir.get(project.dir);
		return record
			? { ...record, ...project }
			: { ...project, recordedAt: now, lastOpenedAt: project.modifiedAt, cover: null };
	});
	const seen = new Set(found.map((project) => project.dir));
	const ids = new Set(found.map((project) => project.id).filter(Boolean));
	for (const record of records) {
		// A record for a folder that moved into the workspace names the same project twice.
		if (seen.has(record.dir) || isInWorkspace(record.dir) || (record.id && ids.has(record.id))) continue;
		list.push(record);
	}
	return list.map(stable);
}

/**
 * What the folder of `project` holds now, its record brought up to date with
 * it: the project as it is, or null when the folder is gone or no longer a
 * project. For the moment before a project on the list is opened.
 */
export async function checkProject(project: ProjectInfo): Promise<ProjectInfo | null> {
	const current = await getProject(project.dir);
	if (current) await updateProjectRecord(current);
	return current;
}

/**
 * Re-reads the project in `dir` and brings its record up to date — for a
 * project whose folder changed while it was open, and for one that is
 * closing, so the dashboard shows what it was last edited as. Null when the
 * folder is gone.
 */
export async function refreshProject(dir: string): Promise<ProjectInfo | null> {
	const current = await getProject(dir);
	if (!current) return null;
	await updateProjectRecord(current);
	setProjectsRevision((revision) => revision + 1);
	return current;
}

/** Takes the project in `dir` off the list, leaving its folder alone, and tells the views. */
export async function forgetProject(dir: string): Promise<void> {
	await forgetProjectRecord(dir);
	setProjectsRevision((revision) => revision + 1);
}

/** Creates a project folder under the workspace's projects folder, named after `displayName`, and puts it on the list. */
export async function createProject(displayName: string): Promise<ProjectInfo> {
	const root = projectsRoot();
	if (!root) throw new Error('No workspace is open.');

	const project = await mainBridge.call(MAIN_CHANNELS.PROJECTS_CREATE, { root, displayName });
	await remember(project);
	return project;
}

/**
 * The project `ref` names: its id, or — for links made before ids existed,
 * and folders opened by name — its folder name. Looked for among the
 * workspace's projects and the records; the folders say what they are now
 * (one may have been renamed or replaced behind our back, or be a folder
 * that predates ids — in which case main gives it one here, so the app can
 * put an id in the URL).
 */
export async function resolveProject(ref: string): Promise<ProjectInfo | null> {
	if (!ref || !isDesktop()) return null;

	const candidates: string[] = [];
	for (const project of workspaceProjects() ?? []) {
		if (project.id === ref || project.name === ref) candidates.push(project.dir);
	}
	for (const record of await findProjectRecords(ref)) candidates.push(record.dir);

	for (const dir of candidates) {
		const project = await mainBridge.call(MAIN_CHANNELS.PROJECTS_RESOLVE, { dir });
		if (!project || (project.id !== ref && project.name !== ref)) continue;
		// Just opened, and holding an id the record may not have had yet.
		await rememberProject(project);
		return project;
	}
	return null;
}

/**
 * Opens the folder `dir` as a project, making it one first when it is not:
 * the folder is created if missing and, when nothing in it can be an entry,
 * given an `index.tsx` holding an empty stage — and nothing else. Put on the
 * list, so it stays reachable by name or id across relaunches. How
 * `compound open <path>` lands anywhere on disk.
 */
export async function openProjectFolder(dir: string): Promise<ProjectInfo> {
	if (!isDesktop()) throw new Error('Opening a project folder requires the desktop app.');

	const project = await mainBridge.call(MAIN_CHANNELS.PROJECTS_INIT, { dir });
	await remember(project);
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
 * to it. Its id has not changed, and neither has its URL; the list follows
 * the folder.
 */
export async function renameProject(dir: string, displayName: string): Promise<ProjectInfo> {
	if (!dir) throw new Error('No project folder.');

	const project = await mainBridge.call(MAIN_CHANNELS.PROJECTS_RENAME, { dir, displayName });
	await moveProjectRecord(dir, project.dir);
	await remember(project);
	return project;
}

/** Copies the project in `dir` next to itself and returns the copy (a new id), on the list. */
export async function duplicateProject(dir: string): Promise<ProjectInfo> {
	if (!dir) throw new Error('No project folder.');

	const project = await mainBridge.call(MAIN_CHANNELS.PROJECTS_DUPLICATE, { dir });
	await remember(project);
	return project;
}

/** Moves the project in `dir` to the trash and takes it off the list. */
export async function deleteProject(dir: string): Promise<void> {
	if (!dir) throw new Error('No project folder.');

	await mainBridge.call(MAIN_CHANNELS.PROJECTS_DELETE, { dir });
	await forgetProject(dir);
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
 * reaching the watcher (see `noteContent` in the desktop's projects.ts).
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
 * Watches a project folder and calls `onChange` with every file that changed
 * since the last call, coalescing a burst of them — an install, a checkout, a
 * folder dropped into the library — into one answer.
 *
 * The delay buys throughput and nothing else: main keeps the app's own writes
 * out of this stream by their content rather than by their timing (see
 * `noteContent` in the desktop's projects.ts) and writes whole files, so no
 * amount of waiting here is load-bearing.
 */
export function watchProject(dir: string, onChange: (paths: string[]) => void, debounceMs = 80): () => void {
	if (!isDesktop()) return () => { };

	let pending: ReturnType<typeof setTimeout> | undefined;
	let changed = new Set<string>();
	const stop = mainBridge.handle(MAIN_CHANNELS.PROJECTS_CHANGED, (event) => {
		if (event.dir !== dir) return;
		changed.add(event.path);
		clearTimeout(pending);
		pending = setTimeout(() => {
			const paths = [...changed];
			changed = new Set();
			onChange(paths);
		}, debounceMs);
	});

	mainBridge.call(MAIN_CHANNELS.PROJECTS_WATCH, { dir });

	return () => {
		clearTimeout(pending);
		stop();
		mainBridge.call(MAIN_CHANNELS.PROJECTS_UNWATCH, { dir }).catch(() => { });
	};
}

/**
 * Every project the app knows, for explicit CLI targeting independently of
 * navigation — the list, canonicalized, so two paths to the same folder are
 * one project.
 */
export async function listKnownProjects(): Promise<ProjectInfo[]> {
	if (!isDesktop()) return [];

	const dirs = new Set<string>();
	const projects: ProjectInfo[] = [];
	for (const project of await listProjects()) {
		const canonical = await mainBridge.call(MAIN_CHANNELS.PROJECTS_FS_REAL_PATH, { dir: project.dir, source: '.' });
		const dir = canonical || project.dir;
		if (dirs.has(dir)) continue;
		dirs.add(dir);
		projects.push({ ...project, dir });
	}
	return projects;
}
