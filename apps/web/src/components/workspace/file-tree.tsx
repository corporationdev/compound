/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The workspace in the dashboard sidebar: its pages, tables and folders,
// the open one selected, shaped like the Home and Projects items above it.
// Projects are not here — they have the Projects view and the editor — so
// what is left is what the organization writes: documents, tables, notes.
// New pages and folders, renames, moves and deletes happen here and land
// on disk, where the watcher brings them back into the listing.

import { useNavigate } from "@solidjs/router";
import { Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { toast } from "somoto";

import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { Tree, type TreeRowItem } from "@/components/ui/tree";
import { revealPath } from "@/lib/shell";
import {
  absolutePath,
  baseName,
  createWorkspaceEntry,
  extensionOf,
  parentPath,
  removeWorkspaceEntry,
  renameWorkspaceEntry,
  stemOf,
  workspaceDir,
  workspaceEntries,
  workspaceError,
  workspaceRoute,
} from "@/lib/workspace";

import { ancestorsOf, buildTree, findNode, flattenTree, withoutProjects, type TreeNode } from "./tree-model";

const EXPANDED_STORAGE_KEY = "compound:workspace-expanded";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "heic"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "m4v"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac"]);

/** Whether a node is a markdown page. */
export const isDocument = (node: TreeNode): boolean => node.kind === "file" && ["md", "markdown"].includes(extensionOf(node.name));

/** The icon a node shows, by what it is. */
export function iconFor(node: TreeNode, expanded: boolean): string {
  if (node.kind === "directory") {
    if (node.project) return "compound-project-file";
    if (node.table) return "page-table";
    return expanded ? "navigation.folder-open" : "navigation.folder";
  }
  const extension = extensionOf(node.name);
  if (extension === "md" || extension === "markdown") return "page";
  if (IMAGE_EXTENSIONS.has(extension)) return "image-small";
  if (VIDEO_EXTENSIONS.has(extension)) return "video-small";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio-small";
  return "text-small";
}

function readExpanded(dir: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(`${EXPANDED_STORAGE_KEY}:${dir}`);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

function writeExpanded(dir: string, expanded: Set<string>): void {
  try {
    window.localStorage.setItem(`${EXPANDED_STORAGE_KEY}:${dir}`, JSON.stringify([...expanded]));
  } catch {
    // Not worth a word: the tree opens the same folders next time or it does not.
  }
}

/** The folder a new entry goes in when `path` is selected: the folder itself, or the file's. */
function folderFor(nodes: TreeNode[], path: string | null): string {
  if (!path) return "";
  const node = findNode(nodes, path);
  if (!node) return parentPath(path);
  return node.kind === "directory" ? node.path : parentPath(node.path);
}

export function WorkspaceFileTree(props: { selectedPath: string | null }) {
  const navigate = useNavigate();
  const nodes = createMemo(() => withoutProjects(buildTree(workspaceEntries() ?? [])));
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(), { equals: false });
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [focused, setFocused] = createSignal<string | null>(null);

  // Which folders are open follows the workspace, remembered per folder.
  createEffect(on(workspaceDir, (dir) => {
    setExpanded(dir ? readExpanded(dir) : new Set<string>());
  }));

  // The open file's folders open with it, so it is on screen when arrived at by URL.
  createEffect(on(() => props.selectedPath, (path) => {
    setFocused(path);
    if (!path) return;
    const ancestors = ancestorsOf(path);
    if (ancestors.every((ancestor) => expanded().has(ancestor))) return;
    setExpanded((current) => {
      for (const ancestor of ancestors) current.add(ancestor);
      return current;
    });
  }));

  const toggle = (path: string, open: boolean) => {
    setExpanded((current) => {
      if (open) current.add(path);
      else current.delete(path);
      const dir = workspaceDir();
      if (dir) writeExpanded(dir, current);
      return current;
    });
  };

  const rows = createMemo<TreeRowItem[]>(() =>
    flattenTree(nodes(), expanded()).map(({ node, depth, expanded: open }) => ({
      id: node.path,
      // A page is called by its title, not its file name; other files keep theirs.
      label: isDocument(node) ? stemOf(node.name) : node.name,
      icon: iconFor(node, open),
      depth,
      branch: node.kind === "directory",
      expanded: open,
    })),
  );

  const nodeAt = (path: string): TreeNode | undefined => findNode(nodes(), path);

  const select = (path: string) => {
    setFocused(path);
    const node = nodeAt(path);
    if (!node) return;
    if (node.kind === "directory" && !node.table) {
      toggle(path, !expanded().has(path));
      return;
    }
    navigate(workspaceRoute(path));
  };

  const activate = (path: string) => {
    const node = nodeAt(path);
    if (!node) return;
    if (node.kind === "directory") toggle(path, !expanded().has(path));
    else navigate(workspaceRoute(path));
  };

  const report = (what: string) => (error: unknown) => {
    toast.error(what, { description: (error as Error).message });
  };

  const createFile = async (folder: string) => {
    try {
      const path = await createWorkspaceEntry(folder ? `${folder}/Untitled.md` : "Untitled.md", "file");
      if (folder) toggle(folder, true);
      navigate(workspaceRoute(path));
    } catch (error) {
      report("Could not create the page")(error);
    }
  };

  const createFolder = async (folder: string) => {
    try {
      const path = await createWorkspaceEntry(folder ? `${folder}/New folder` : "New folder", "directory");
      if (folder) toggle(folder, true);
      setFocused(path);
      setRenaming(path);
    } catch (error) {
      report("Could not create the folder")(error);
    }
  };

  const commitRename = async (path: string, name: string) => {
    setRenaming(null);
    const node = nodeAt(path);
    const typed = name.trim();
    // A page's row shows its title; the extension comes back on the way to disk.
    const trimmed = node && isDocument(node) && !typed.includes(".") ? `${typed}.${extensionOf(node.name)}` : typed;
    if (!typed || trimmed === baseName(path) || trimmed.includes("/")) return;
    const parent = parentPath(path);
    const target = parent ? `${parent}/${trimmed}` : trimmed;
    try {
      await renameWorkspaceEntry(path, target);
      if (props.selectedPath === path || props.selectedPath?.startsWith(`${path}/`)) {
        navigate(workspaceRoute(props.selectedPath.replace(path, target)), { replace: true });
      } else setFocused(target);
      if (expanded().has(path)) {
        toggle(path, false);
        toggle(target, true);
      }
    } catch (error) {
      report("Could not rename")(error);
    }
  };

  const move = async (path: string, targetFolder: string | null) => {
    const folder = targetFolder ?? "";
    if (folder === path || folder.startsWith(`${path}/`)) {
      toast("Cannot move a folder into itself");
      return;
    }
    const target = folder ? `${folder}/${baseName(path)}` : baseName(path);
    if (target === path) return;
    try {
      await renameWorkspaceEntry(path, target);
      if (folder) toggle(folder, true);
      if (props.selectedPath === path || props.selectedPath?.startsWith(`${path}/`)) {
        navigate(workspaceRoute(props.selectedPath.replace(path, target)), { replace: true });
      }
    } catch (error) {
      report("Could not move")(error);
    }
  };

  const remove = async (path: string) => {
    try {
      await removeWorkspaceEntry(path);
      if (props.selectedPath === path || props.selectedPath?.startsWith(`${path}/`)) navigate("/?dashboard=projects", { replace: true });
    } catch (error) {
      report("Could not delete")(error);
    }
  };

  const reveal = async (path: string) => {
    const absolute = absolutePath(path);
    if (!absolute) return;
    try {
      await revealPath(absolute);
    } catch (error) {
      report("Could not reveal")(error);
    }
  };

  const menu = (path: string) => {
    const node = nodeAt(path);
    const folder = folderFor(nodes(), path);
    return (
      <>
        <Show when={node?.kind === "file" || node?.table}>
          <ContextMenuItem onSelect={() => navigate(workspaceRoute(path))}>Open</ContextMenuItem>
          <ContextMenuSeparator />
        </Show>
        <ContextMenuItem onSelect={() => createFile(folder)}>New page</ContextMenuItem>
        <ContextMenuItem onSelect={() => createFolder(folder)}>New folder</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => setRenaming(path)}>Rename</ContextMenuItem>
        <ContextMenuItem onSelect={() => reveal(path)}>Reveal in Finder</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => remove(path)}>Delete</ContextMenuItem>
      </>
    );
  };

  const backgroundMenu = (
    <>
      <ContextMenuItem onSelect={() => createFile("")}>New page</ContextMenuItem>
      <ContextMenuItem onSelect={() => createFolder("")}>New folder</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => reveal("")}>Reveal in Finder</ContextMenuItem>
    </>
  );

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="group flex h-8 shrink-0 items-center px-1">
        <p class="min-w-0 flex-1 truncate text-xs text-muted-foreground">Workspace</p>
        <button
          type="button"
          title="New page"
          aria-label="New page"
          onClick={() => createFile(folderFor(nodes(), focused()))}
          class="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Icon name="plus-add-small" class="size-5" />
        </button>
      </div>
      <Show
        when={workspaceDir()}
        fallback={
          <p class="px-2 py-1 text-xs text-muted-foreground">{workspaceError() ?? "Opening your workspace…"}</p>
        }
      >
        <div class="min-h-0 flex-1 overflow-y-auto pb-2">
          <Tree
            aria-label="Workspace"
            rows={rows()}
            selected={focused()}
            onSelect={select}
            onToggle={toggle}
            onActivate={activate}
            renaming={renaming()}
            onRenameRequest={(path) => setRenaming(path)}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenaming(null)}
            menu={menu}
            backgroundMenu={backgroundMenu}
            onMove={move}
            footer={
              <button
                type="button"
                onClick={() => createFile("")}
                class="my-0.5 flex h-7 w-full shrink-0 items-center gap-1 rounded-md pr-1 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-ring"
              >
                <span class="grid size-7 shrink-0 place-items-center">
                  <Icon name="plus-add-small" class="size-6" />
                </span>
                <span class="min-w-0 flex-1 truncate text-left text-xs">New page</span>
              </button>
            }
          />
        </div>
      </Show>
    </div>
  );
}
