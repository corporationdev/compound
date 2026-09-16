/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A database inside a page, the way Notion embeds one: a block that shows
// the grid of a table folder, editable in place. On disk it is one line of
// markdown an agent can read and write:
//
//   :::database {path="ideas"}
//
// `path` is workspace-relative, so the block survives the page moving.

import { Node, createAtomBlockMarkdownSpec, mergeAttributes } from "@tiptap/core";
import { Show } from "solid-js";
import { render } from "solid-js/web";

import { Icon } from "@/components/ui/icon";
import { baseName, workspaceEntries, workspaceRoute } from "@/lib/workspace";

import { DatabaseGrid, createDatabase } from "./database-grid";

export const DATABASE_NODE = "database";

/** Opens a workspace path from outside the router (the node view is not under it). */
const open = (path: string) => {
  window.location.hash = workspaceRoute(path).slice(0);
};

function DatabaseEmbed(props: { path: string; selected: () => boolean }) {
  const db = createDatabase(() => props.path);
  const exists = () => (workspaceEntries() ?? []).some((entry) => entry.path === props.path && entry.kind === "directory");
  return (
    <div
      class="database-embed my-2 rounded-lg"
      classList={{ "ring-1 ring-ring": props.selected() }}
    >
      <div class="mb-2 flex items-center gap-2">
        <Icon name="page-table" class="size-5 text-muted-foreground" />
        <button
          type="button"
          onClick={() => open(props.path)}
          class="min-w-0 truncate text-left text-sm font-450 text-foreground hover:underline"
        >
          {db.schema.latest?.name ?? baseName(props.path)}
        </button>
        <span class="text-xs text-muted-foreground">{db.count()} row{db.count() === 1 ? "" : "s"}</span>
      </div>
      <Show
        when={exists()}
        fallback={<p class="rounded-lg border border-dashed border-border-strong px-3 py-2 text-xs text-muted-foreground">No database at {props.path}.</p>}
      >
        <DatabaseGrid path={props.path} onOpen={open} header={false} />
      </Show>
    </div>
  );
}

/** The Tiptap node: atomic, block-level, one attribute. */
export const DatabaseBlock = Node.create({
  name: DATABASE_NODE,
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return { path: { default: "" } };
  },

  parseHTML() {
    return [{ tag: `div[data-type="${DATABASE_NODE}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": DATABASE_NODE })];
  },

  // How the block reads and writes as markdown: `:::database {path="…"}`.
  ...createAtomBlockMarkdownSpec({
    nodeName: DATABASE_NODE,
    requiredAttributes: ["path"],
    allowedAttributes: ["path"],
  }),

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("div");
      dom.setAttribute("data-type", DATABASE_NODE);
      dom.contentEditable = "false";
      const selected = () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        const { selection } = editor.state;
        return pos !== undefined && "node" in selection && (selection as { node?: unknown }).node === node && selection.from === pos;
      };
      const dispose = render(() => <DatabaseEmbed path={String(node.attrs.path ?? "")} selected={selected} />, dom);
      return {
        dom,
        destroy: dispose,
        // The grid is its own world: clicks, keys and mutations inside it are not the document's.
        stopEvent: () => true,
        ignoreMutation: () => true,
      };
    };
  },
});
