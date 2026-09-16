/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the dashboard shows for a workspace path: a document, a table, a
// folder, or a plain text file, by what is there. Pages are keyed on the
// path, not the node: the listing is rebuilt on every change under the
// workspace, and a page must not remount (and lose its editor) for that.

import { Match, Show, Switch, createMemo } from "solid-js";

import { Icon } from "@/components/ui/icon";
import { extensionOf, workspaceDir, workspaceEntries, workspaceError } from "@/lib/workspace";

import { DocumentPage } from "./document-page";
import { FolderPage } from "./folder-page";
import { TablePage } from "./table-page";
import { TextFilePage } from "./text-file-page";
import { buildTree, findNode } from "./tree-model";

const DOCUMENT_EXTENSIONS = new Set(["md", "markdown"]);

export function WorkspaceView(props: { path: string }) {
  const nodes = createMemo(() => buildTree(workspaceEntries() ?? []));
  const node = createMemo(() => (props.path ? findNode(nodes(), props.path) : undefined));

  return (
    <Switch>
      <Match when={!workspaceDir()}>
        <Centered>
          <Show when={workspaceError()} fallback={<Icon name="spinner-loader" class="size-5 animate-spin text-muted-foreground" />}>
            <p class="text-xs text-destructive">{workspaceError()}</p>
          </Show>
        </Centered>
      </Match>
      <Match when={!props.path}>
        <FolderPage path="" children={nodes()} />
      </Match>
      <Match when={!workspaceEntries()}>
        <Centered>
          <Icon name="spinner-loader" class="size-5 animate-spin text-muted-foreground" />
        </Centered>
      </Match>
      <Match when={!node()}>
        {/* A path the listing does not have yet (a page just made) or no longer has; the listing catches up within a moment. */}
        <Centered>
          <Icon name="spinner-loader" class="size-5 animate-spin text-muted-foreground" />
        </Centered>
      </Match>
      <Match when={node()!.kind === "directory" && node()!.table}>
        <Show when={node()?.path} keyed>
          {(path) => <TablePage path={path} />}
        </Show>
      </Match>
      <Match when={node()!.kind === "directory"}>
        <FolderPage path={node()!.path} children={node()!.children} />
      </Match>
      <Match when={DOCUMENT_EXTENSIONS.has(extensionOf(node()!.name))}>
        <Show when={node()?.path} keyed>
          {(path) => <DocumentPage path={path} />}
        </Show>
      </Match>
      <Match when={true}>
        <Show when={node()?.path} keyed>
          {(path) => <TextFilePage path={path} />}
        </Show>
      </Match>
    </Switch>
  );
}

function Centered(props: { children: import("solid-js").JSX.Element }) {
  return <div class="flex min-h-0 flex-1 items-center justify-center">{props.children}</div>;
}
