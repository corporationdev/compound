/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// An organization's workspace on this machine: one folder under the app's
// root, named after the organization, holding whatever the organization's
// members and their agents put there. Projects are folders inside it with a
// `package.json` and an entry file; everything else is files. The sync
// engine keeps the folder in step with the organization's rows in Convex
// (see sync/manager.ts); this module is what the renderer's file tree and
// document editor read and write through, and how the folder is found or
// made in the first place.

import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { shell, type BrowserWindow } from "electron";

import { isTempPath, writeFileAtomic } from "./atomic";
import { MAIN_CHANNELS, type ProjectInfo, type WorkspaceEntry, type WorkspaceFile, type WorkspaceInfo, type WorkspaceWriteResult } from "./main-channels";
import { mainBridge } from "./main-manager";
import { getProject, noteContent } from "./projects";
import { withProjectLock } from "./sync/locks";
import { mergeText } from "./sync/merge";
import { IGNORED_NAMES, MAX_SYNC_BYTES, isSyncableContent } from "./sync/rules";

/** Where a workspace records which organization it belongs to. */
const WORKSPACE_RECORD = join(".compound", "workspace.json");

/** How deep the tree listing and the project walk go. Workspaces are shallow; this stops a runaway symlink. */
const MAX_DEPTH = 12;

type WorkspaceRecord = { organizationId: string };

/**
 * The folders `openWorkspace` has answered with this run. Every other entry
 * point takes a `dir` from the renderer and acts on the disk under it; this
 * is what keeps that to workspaces, not to any folder a page could name.
 */
const opened = new Set<string>();

function assertOpened(dir: string): string {
  const key = resolve(dir);
  if (!opened.has(key)) throw new Error("Not an open workspace");
  return key;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** A folder name a workspace or project may be given on disk: the organization's name, made safe. */
export function folderName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return cleaned || "workspace";
}

/** `base`, or `base-2`, `base-3`... when the folder is taken. */
async function freeFolder(root: string, base: string): Promise<string> {
  let name = base;
  for (let i = 2; await exists(join(root, name)); i++) name = `${base}-${i}`;
  return join(root, name);
}

async function readRecord(dir: string): Promise<WorkspaceRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, WORKSPACE_RECORD), "utf8")) as Partial<WorkspaceRecord>;
    return typeof parsed.organizationId === "string" ? { organizationId: parsed.organizationId } : null;
  } catch {
    return null;
  }
}

async function writeRecord(dir: string, record: WorkspaceRecord): Promise<void> {
  const path = join(dir, WORKSPACE_RECORD);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, JSON.stringify(record, null, 2) + "\n");
}

/**
 * The organization's workspace folder under `root`: the one whose record
 * names it, else a new folder named after the organization. A new folder
 * gets the starter `projects/` folder, and any project folders sitting
 * directly in `root` — how projects were kept before workspaces — move into
 * it, so the upgrade finds them where the app now looks.
 */
export async function openWorkspace({ root, organizationId, name }: { root: string; organizationId: string; name: string }): Promise<WorkspaceInfo> {
  await mkdir(root, { recursive: true });
  for (const child of await childDirs(root)) {
    const record = await readRecord(child);
    if (record?.organizationId === organizationId) {
      opened.add(resolve(child));
      return { dir: child, organizationId, created: false, moved: [] };
    }
  }

  const dir = await freeFolder(root, folderName(name));
  await mkdir(join(dir, "projects"), { recursive: true });
  await writeRecord(dir, { organizationId });
  const moved = await migrateLegacyProjects(root, dir);
  opened.add(resolve(dir));
  return { dir, organizationId, created: true, moved };
}

/**
 * Moves every project folder directly under `root` into `<dir>/projects/`.
 * The old projects root held projects and nothing else; a folder with no
 * entry file (another organization's workspace, a stray download) stays.
 * The cloud binding projects used to carry in package.json is dropped: the
 * workspace is the binding now.
 */
export async function migrateLegacyProjects(root: string, dir: string): Promise<Array<{ from: string; to: string }>> {
  const moved: Array<{ from: string; to: string }> = [];
  for (const child of await childDirs(root)) {
    if (child === dir || (await readRecord(child))) continue;
    const project = await getProject(child);
    if (!project) continue;
    const target = await freeFolder(join(dir, "projects"), basename(child));
    await rename(child, target);
    await dropCloudBinding(target);
    moved.push({ from: child, to: target });
  }
  return moved;
}

async function dropCloudBinding(dir: string): Promise<void> {
  const path = join(dir, "package.json");
  try {
    const pkg = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (!("cloudProjectId" in pkg)) return;
    delete pkg.cloudProjectId;
    await writeFileAtomic(path, JSON.stringify(pkg, null, 2) + "\n");
  } catch {
    // Not ours to fix; the project still opens.
  }
}

async function childDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED_NAMES.has(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(root, name));
}

// ---------------------------------------------------------------------------
// Paths

/**
 * `path` under `dir`, refused when it is not workspace-relative or would
 * leave the folder. Everything the renderer names goes through here.
 */
export function workspacePath(dir: string, path: string): string {
  if (path.includes("\0") || path.includes("\\")) throw new Error(`Invalid path: ${path}`);
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) throw new Error(`Invalid path: ${path}`);
  const target = resolve(dir, ...segments);
  const rel = relative(resolve(dir), target);
  if (rel.startsWith("..")) throw new Error(`Path leaves the workspace: ${path}`);
  return target;
}

/** Whether a workspace-relative path is one the tree shows: not hidden, not ignored, not a temp file. */
export function isVisiblePath(path: string): boolean {
  return path.split("/").every((segment) => segment !== "" && !segment.startsWith(".") && !IGNORED_NAMES.has(segment) && !isTempPath(segment));
}

// ---------------------------------------------------------------------------
// Listing

/**
 * Every visible entry under `dir`, depth first, as workspace-relative paths.
 * Folders come with whether they are a project, which the tree marks and
 * the dashboard lists; the ignored names (installs, caches, media, the
 * app's own folder) and dotfiles are left out.
 */
export async function listWorkspace(dir: string): Promise<WorkspaceEntry[]> {
  assertOpened(dir);
  const entries: WorkspaceEntry[] = [];
  const walk = async (parent: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    const absolute = parent ? workspacePath(dir, parent) : dir;
    const children = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    for (const child of children) {
      if (!isVisiblePath(child.name)) continue;
      const path = parent ? `${parent}/${child.name}` : child.name;
      const info = await stat(join(absolute, child.name)).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        const project = !!(await getProject(join(absolute, child.name)));
        entries.push({ path, name: child.name, kind: "directory", size: 0, mtime: info.mtimeMs, project });
        await walk(path, depth + 1);
      } else if (info.isFile()) {
        entries.push({ path, name: child.name, kind: "file", size: info.size, mtime: info.mtimeMs });
      }
    }
  };
  await walk("", 0);
  return entries;
}

/**
 * Every project folder under `dir`, however deep, without descending into
 * one (a project's own folders are its own). What the dashboard lists.
 */
export async function findProjects(dir: string): Promise<ProjectInfo[]> {
  assertOpened(dir);
  const projects: ProjectInfo[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    for (const child of await childDirs(folder)) {
      const project = await getProject(child);
      if (project) projects.push(project);
      else await walk(child, depth + 1);
    }
  };
  await walk(dir, 0);
  return projects;
}

// ---------------------------------------------------------------------------
// Files

/**
 * What is at `path`: its text when it is text the app can edit, else its
 * size, else null when nothing is there.
 */
export async function readWorkspaceFile(dir: string, path: string): Promise<WorkspaceFile | null> {
  assertOpened(dir);
  const target = workspacePath(dir, path);
  const info = await stat(target).catch(() => null);
  if (!info || !info.isFile()) return null;
  if (info.size > MAX_SYNC_BYTES) return { kind: "binary", size: info.size, mtime: info.mtimeMs };
  const bytes = await readFile(target);
  if (!isSyncableContent(bytes)) return { kind: "binary", size: info.size, mtime: info.mtimeMs };
  return { kind: "text", text: bytes.toString("utf8"), mtime: info.mtimeMs };
}

/**
 * Replaces the text at `path`. Under the workspace lock, so sync never
 * lands on a half-written file; claimed with `noteContent`, so a project
 * watcher on the same file does not report the app's own write as an
 * outside change.
 *
 * `base` is the text the caller last read or wrote. When the file has moved
 * on since (a teammate through sync, an agent with its own tools), the
 * caller's text and the file's are merged three ways against it, the way
 * sync merges between machines, and the merged text is what lands and what
 * comes back — so an edit typed while someone else's landed loses nothing
 * but the lines both sides changed, where the caller's win. Null means the
 * caller believes the file is new; undefined skips the check.
 */
export async function writeWorkspaceFile(dir: string, path: string, text: string, base?: string | null): Promise<WorkspaceWriteResult> {
  assertOpened(dir);
  const target = workspacePath(dir, path);
  return withProjectLock(dir, async () => {
    let final = text;
    let merged = false;
    let conflicted = false;
    if (base !== undefined) {
      const current = await readFile(target, "utf8").catch(() => null);
      if (current !== null && current !== base && current !== text) {
        const outcome = mergeText(base ?? "", text, current);
        final = outcome.text;
        conflicted = outcome.conflicted;
        merged = true;
      }
    }
    await mkdir(dirname(target), { recursive: true });
    noteContent(target, final);
    await writeFileAtomic(target, final);
    return merged ? { status: "merged", text: final, conflicted } : { status: "ok" };
  });
}

/**
 * Makes a file or folder at `path`, numbering the name when it is taken.
 * Answers the workspace-relative path it ended up at.
 */
export async function createWorkspaceEntry(dir: string, path: string, kind: "file" | "directory"): Promise<string> {
  assertOpened(dir);
  const target = workspacePath(dir, path);
  if (target === resolve(dir)) throw new Error("A name is needed");
  return withProjectLock(dir, async () => {
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    const name = basename(target);
    const dot = kind === "file" ? name.lastIndexOf(".") : -1;
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let i = 2; await exists(join(parent, candidate)); i++) candidate = `${stem} ${i}${ext}`;
    const final = join(parent, candidate);
    if (kind === "directory") await mkdir(final);
    else await writeFile(final, "", { flag: "wx" });
    return relative(dir, final).split(sep).join("/");
  });
}

/**
 * Moves `from` to `to` inside the workspace; refused when `to` is taken.
 * Under the workspace lock, so a sync write in flight for `from` lands
 * before the move rather than recreating the old path after it. A change
 * of letter case only is a rename too (the disk is case-insensitive here,
 * so `exists` would say the target is taken by the source itself).
 */
export async function renameWorkspaceEntry(dir: string, from: string, to: string): Promise<void> {
  assertOpened(dir);
  const source = workspacePath(dir, from);
  const target = workspacePath(dir, to);
  if (source === resolve(dir) || target === resolve(dir)) throw new Error("Refusing to move the workspace itself");
  return withProjectLock(dir, async () => {
    if (source === target) return;
    const caseOnly = source.toLowerCase() === target.toLowerCase();
    if (!caseOnly && (await exists(target))) throw new Error(`${to} already exists`);
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
  });
}

/** Moves `path` to the trash. */
export async function removeWorkspaceEntry(dir: string, path: string): Promise<void> {
  assertOpened(dir);
  const target = workspacePath(dir, path);
  if (target === resolve(dir)) throw new Error("Refusing to remove the workspace itself");
  await shell.trashItem(target);
}

// ---------------------------------------------------------------------------
// Watch

const watchers = new Map<string, FSWatcher>();

/**
 * Reports every change under the workspace to the renderer, path by path.
 * No digest filter here: the tree refetches on any change, and the editor
 * compares text before it reacts (see the renderer's workspace store).
 */
export function watchWorkspace(window: BrowserWindow | null, dir: string): void {
  assertOpened(dir);
  if (watchers.has(dir)) return;
  const watcher = watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const path = filename.split(sep).join("/");
    if (!isVisiblePath(path)) return;
    mainBridge.emit(window, MAIN_CHANNELS.WORKSPACE_CHANGED, { dir, path });
  });
  watcher.on("error", () => unwatchWorkspace(dir));
  watchers.set(dir, watcher);
}

export function unwatchWorkspace(dir: string): void {
  watchers.get(dir)?.close();
  watchers.delete(dir);
}

export function unwatchAllWorkspaces(): void {
  for (const dir of [...watchers.keys()]) unwatchWorkspace(dir);
}
