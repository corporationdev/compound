/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A plain folder, and the workspace root: what is in it, as rows to open.

import { useNavigate } from "@solidjs/router";
import { For, Show } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { projectRoute } from "@/hooks/use-project-route";
import { revealPath } from "@/lib/shell";
import { absolutePath, baseName, createWorkspaceEntry, workspaceDir, workspaceProjects, workspaceRoute } from "@/lib/workspace";
import { projectKey } from "@/projects";

import { WorkspaceBreadcrumbs } from "./breadcrumbs";
import { iconFor } from "./file-tree";
import type { TreeNode } from "./tree-model";

export function FolderPage(props: { path: string; children: TreeNode[] }) {
  const navigate = useNavigate();
  const title = () => (props.path ? baseName(props.path) : "Workspace");

  const open = (node: TreeNode) => {
    if (node.project) {
      const dir = absolutePath(node.path);
      const project = (workspaceProjects() ?? []).find((candidate) => candidate.dir === dir);
      if (project) return navigate(projectRoute(projectKey(project)));
    }
    navigate(workspaceRoute(node.path));
  };

  const newFile = async () => {
    try {
      const path = await createWorkspaceEntry(props.path ? `${props.path}/Untitled.md` : "Untitled.md", "file");
      navigate(workspaceRoute(path));
    } catch (error) {
      toast.error("Could not create the file", { description: (error as Error).message });
    }
  };

  const reveal = async () => {
    const absolute = absolutePath(props.path);
    if (absolute) await revealPath(absolute).catch(() => { });
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div class="mx-auto flex w-full max-w-3xl flex-col px-12 pb-40 pt-14">
        <WorkspaceBreadcrumbs path={props.path} />
        <div class="mt-3 flex items-end gap-4">
          <h1 class="min-w-0 flex-1 truncate text-6xl font-450 leading-tight text-foreground">{title()}</h1>
          <Button variant="secondary" onClick={reveal}>Reveal in Finder</Button>
          <Button onClick={newFile}>New file</Button>
        </div>
        <Show when={!props.path}>
          <p class="mt-2 truncate text-xs text-muted-foreground" title={workspaceDir() ?? undefined}>
            {workspaceDir()}
          </p>
        </Show>
        <div class="mt-8 flex flex-col">
          <For each={props.children}>
            {(node) => (
              <button
                type="button"
                onClick={() => open(node)}
                class="flex h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-accent focus-ring"
              >
                <Icon name={iconFor(node, false)} class="size-5 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate text-xs text-foreground">{node.name}</span>
                <span class="text-xxs text-muted-foreground/70">
                  {node.project ? "Project" : node.table ? "Table" : node.kind === "directory" ? `${node.children.length} item${node.children.length === 1 ? "" : "s"}` : ""}
                </span>
              </button>
            )}
          </For>
          <Show when={props.children.length === 0}>
            <p class="px-2 py-4 text-xs text-muted-foreground">Nothing here yet.</p>
          </Show>
        </div>
      </div>
    </div>
  );
}
