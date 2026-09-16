/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show } from "solid-js";

import { useProject } from "@/context/project";
import { cx } from "@/lib/cva";
import { isInWorkspace, workspaceSyncStatus } from "@/lib/workspace";

import type { SyncStatus } from "@/lib/workspace";

const LABELS: Record<SyncStatus["state"], string> = {
  starting: "Syncing…",
  syncing: "Syncing…",
  synced: "Synced",
  offline: "Offline",
  error: "Sync error",
};

const DOT: Record<SyncStatus["state"], string> = {
  starting: "bg-muted-foreground animate-pulse",
  syncing: "bg-muted-foreground animate-pulse",
  synced: "bg-success-accent-foreground",
  offline: "bg-muted-foreground",
  error: "bg-destructive",
};

/**
 * What cloud sync is doing for the open project: nothing for a folder
 * outside the workspace, else the workspace's status as a dot and a word.
 * The pending count and any error go in the title.
 */
export function SyncStatusPill() {
  const project = useProject();
  const status = () => (isInWorkspace(project.dir()) ? workspaceSyncStatus() : null);

  const title = () => {
    const current = status();
    if (!current) return undefined;
    // Files that cannot sync (too large, or not text) are worth a line of
    // their own: they stay local on this machine while everything else moves.
    const skipped = current.skipped.length
      ? `\nNot synced (too large or not text): ${current.skipped.join(", ")}`
      : "";
    if (current.state === "error") return (current.error ?? "Sync error") + skipped;
    if (current.state === "offline") return `Offline: ${current.pending} change${current.pending === 1 ? "" : "s"} waiting` + skipped;
    if (current.pending > 0) return `${current.pending} change${current.pending === 1 ? "" : "s"} to send` + skipped;
    return "Workspace in sync" + skipped;
  };

  return (
    <Show when={status()}>
      {(current) => (
        <span
          role="status"
          title={title()}
          class="ml-auto flex shrink-0 items-center gap-1.5 rounded-full px-1.5 text-xxs text-muted-foreground"
        >
          <span class={cx("size-1.5 rounded-full", DOT[current().state])} />
          {LABELS[current().state]}
        </span>
      )}
    </Show>
  );
}
