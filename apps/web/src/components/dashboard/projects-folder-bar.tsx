/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { revealPath } from "@/lib/shell";
import { isDesktop, workspaceDir, workspaceError, workspaceSyncStatus } from "@/lib/workspace";

/**
 * Footer bar of the projects view: the workspace folder projects live in,
 * and a way to it. Desktop only — the workspace is a folder on disk, so
 * there is nothing to show in the browser build.
 */
export function DashboardProjectsFolderBar() {
  const label = () => workspaceDir() ?? workspaceError() ?? "Opening your workspace…";
  const detail = () => {
    const status = workspaceSyncStatus();
    if (!status) return "Projects in this folder sync with your organization once you are signed in.";
    switch (status.state) {
      case "synced":
        return "In sync with your organization.";
      case "offline":
        return `Offline: ${status.pending} change${status.pending === 1 ? "" : "s"} waiting.`;
      case "error":
        return status.error ?? "Sync error.";
      default:
        return "Syncing…";
    }
  };

  const handleReveal = async () => {
    const dir = workspaceDir();
    if (!dir) return;
    try {
      await revealPath(dir);
    } catch (e) {
      toast.error("Failed to reveal workspace", { description: (e as Error).message });
    }
  };

  return (
    <Show when={isDesktop()}>
      <div class="flex shrink-0 flex-col gap-3 border-t border-border px-4 py-3">
        <div class="flex items-center gap-4">
          <div class="flex min-w-0 flex-1 items-start gap-2">
            <span class="relative size-4 shrink-0 text-muted-foreground">
              <Icon
                name="navigation.folder"
                class="absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2"
              />
            </span>
            <div class="flex min-w-0 flex-1 flex-col justify-center gap-1">
              <p class="h-4 text-xs text-foreground">Workspace</p>
              <p class="min-w-0 truncate text-xs text-muted-foreground" title={label()}>
                {label()}
              </p>
              <p class="min-w-0 truncate text-xxs text-muted-foreground opacity-70">{detail()}</p>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Button variant="secondary" onClick={handleReveal} disabled={!workspaceDir()}>
              Reveal in Finder
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
