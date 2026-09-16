/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { A } from "@solidjs/router";
import { For, Show } from "solid-js";

import { workspaceRoute } from "@/lib/workspace";

/** Where a workspace path sits: the folders above it, each a link. */
export function WorkspaceBreadcrumbs(props: { path: string }) {
  const segments = () => {
    const parts = props.path.split("/").filter(Boolean);
    return parts.slice(0, -1).map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
  };
  return (
    <nav aria-label="Location" class="flex h-5 items-center gap-1 text-xs text-muted-foreground/70">
      <A href={workspaceRoute("")} class="rounded-sm px-1 hover:bg-accent hover:text-foreground">Workspace</A>
      <For each={segments()}>
        {(segment) => (
          <>
            <span aria-hidden="true">/</span>
            <A href={workspaceRoute(segment.path)} class="truncate rounded-sm px-1 hover:bg-accent hover:text-foreground">{segment.name}</A>
          </>
        )}
      </For>
      <Show when={segments().length === 0 && !props.path}>
        <span />
      </Show>
    </nav>
  );
}
