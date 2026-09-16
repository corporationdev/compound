/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A tree of rows in the sidebar's own idiom: each row is shaped like a
// sidebar item (a 28px icon box, a label), indented by depth. A folder's
// icon gives way to a chevron on hover, the way Notion nests pages. Keyboard
// navigation runs over the rows on screen; a context menu per row is the
// caller's. The rows are given flat, already in display order (see
// `flattenTree` in the workspace's tree model); the tree does not know what
// they are, only how to show, move between, and rename them.

import { For, Show, createSignal, type JSX } from "solid-js";

import { cx } from "@/lib/cva";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuPortal,
  ContextMenuTrigger,
} from "./context-menu";
import { Icon } from "./icon";

export type TreeRowItem = {
  /** Identity: what selection, expansion and renaming are keyed by. */
  id: string;
  label: string;
  icon: string;
  depth: number;
  /** A folder: shows a chevron on hover and answers to left/right. */
  branch: boolean;
  expanded: boolean;
};

export type TreeProps = {
  rows: readonly TreeRowItem[];
  selected: string | null;
  /** A row was clicked or reached with the keyboard. */
  onSelect: (id: string) => void;
  /** A branch's chevron was clicked, or left/right pressed on it. */
  onToggle: (id: string, expanded: boolean) => void;
  /** A row was double-clicked, or Enter pressed on it. */
  onActivate?: (id: string) => void;
  /** The row being renamed inline, if any. */
  renaming?: string | null;
  onRenameCommit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  /** F2 was pressed on the selected row. */
  onRenameRequest?: (id: string) => void;
  /** Context menu items for a row; nothing for no menu. */
  menu?: (id: string) => JSX.Element;
  /** A row was dropped on a branch (or on the empty space, `targetId` null). */
  onMove?: (id: string, targetId: string | null) => void;
  /** Right-click on the empty space below the rows. */
  backgroundMenu?: JSX.Element;
  /** Rendered after the rows, inside the same list (a "new page" row). */
  footer?: JSX.Element;
  class?: string;
  "aria-label"?: string;
};

const DRAG_TYPE = "application/x-tree-row";

/** How far each level is indented, in pixels. */
const INDENT = 14;

export function Tree(props: TreeProps) {
  const [dropTarget, setDropTarget] = createSignal<string | null | undefined>(undefined);

  const indexOf = (id: string | null): number => (id === null ? -1 : props.rows.findIndex((row) => row.id === id));

  const parentOf = (row: TreeRowItem): TreeRowItem | undefined => {
    const index = indexOf(row.id);
    for (let i = index - 1; i >= 0; i--) {
      const candidate = props.rows[i]!;
      if (candidate.depth < row.depth) return candidate;
    }
    return undefined;
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (props.renaming) return;
    const index = indexOf(props.selected);
    const current = index >= 0 ? props.rows[index] : undefined;
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = props.rows[Math.min(index + 1, props.rows.length - 1)];
        if (next) props.onSelect(next.id);
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        const next = props.rows[Math.max(index - 1, 0)];
        if (next) props.onSelect(next.id);
        break;
      }
      case "ArrowRight": {
        if (!current) return;
        event.preventDefault();
        if (current.branch && !current.expanded) props.onToggle(current.id, true);
        else {
          const child = props.rows[index + 1];
          if (child && child.depth > current.depth) props.onSelect(child.id);
        }
        break;
      }
      case "ArrowLeft": {
        if (!current) return;
        event.preventDefault();
        if (current.branch && current.expanded) props.onToggle(current.id, false);
        else {
          const parent = parentOf(current);
          if (parent) props.onSelect(parent.id);
        }
        break;
      }
      case "Enter": {
        if (!current) return;
        event.preventDefault();
        props.onActivate?.(current.id);
        break;
      }
      case "F2": {
        if (!current) return;
        event.preventDefault();
        props.onRenameRequest?.(current.id);
        break;
      }
      case "Home":
      case "End": {
        event.preventDefault();
        const next = props.rows[event.key === "Home" ? 0 : props.rows.length - 1];
        if (next) props.onSelect(next.id);
        break;
      }
      default:
        return;
    }
  };

  const handleDragStart = (row: TreeRowItem, event: DragEvent) => {
    if (!props.onMove || !event.dataTransfer) return;
    event.dataTransfer.setData(DRAG_TYPE, row.id);
    event.dataTransfer.effectAllowed = "move";
  };

  const isRowDrag = (event: DragEvent): boolean => !!event.dataTransfer?.types.includes(DRAG_TYPE);

  const handleDragOver = (target: string | null, event: DragEvent) => {
    if (!props.onMove || !isRowDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setDropTarget(target);
  };

  const handleDrop = (target: string | null, event: DragEvent) => {
    if (!props.onMove || !isRowDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(undefined);
    const id = event.dataTransfer?.getData(DRAG_TYPE);
    if (id) props.onMove(id, target);
  };

  const row = (item: TreeRowItem) => {
    const selected = () => props.selected === item.id;
    const renaming = () => props.renaming === item.id;
    const isDrop = () => dropTarget() === item.id;
    return (
      <div
        role="treeitem"
        aria-selected={selected()}
        aria-expanded={item.branch ? item.expanded : undefined}
        aria-level={item.depth + 1}
        data-tree-row={item.id}
        draggable={!!props.onMove && !renaming()}
        onDragStart={(event) => handleDragStart(item, event)}
        on:dragover={(event) => item.branch && handleDragOver(item.id, event)}
        on:dragleave={() => isDrop() && setDropTarget(undefined)}
        on:drop={(event) => item.branch && handleDrop(item.id, event)}
        onClick={() => props.onSelect(item.id)}
        onDblClick={() => props.onActivate?.(item.id)}
        class={cx(
          "group my-0.5 flex h-7 w-full shrink-0 cursor-default items-center gap-1 rounded-md pr-1 hover:bg-accent focus-ring",
          selected() && "bg-accent",
          isDrop() && "ring-1 ring-inset ring-ring",
        )}
        style={{ "padding-left": `${item.depth * INDENT}px` }}
      >
        <span class="relative grid size-7 shrink-0 place-items-center overflow-clip">
          <Icon
            name={item.icon}
            class={cx(
              "size-6 transition-opacity",
              selected() ? "text-foreground" : "text-muted-foreground",
              item.branch && "group-hover:opacity-0",
            )}
          />
          <Show when={item.branch}>
            <button
              type="button"
              tabIndex={-1}
              aria-label={item.expanded ? "Collapse" : "Expand"}
              class="absolute inset-0.5 grid place-items-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                props.onToggle(item.id, !item.expanded);
              }}
            >
              <Icon name="chevron-right" class={cx("size-5 transition-transform", item.expanded && "rotate-90")} />
            </button>
          </Show>
        </span>
        <Show
          when={renaming()}
          fallback={
            <span
              class={cx(
                "min-w-0 flex-1 truncate text-left text-xs",
                selected() ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {item.label}
            </span>
          }
        >
          <input
            ref={(el) => queueMicrotask(() => {
              el.focus();
              const dot = item.label.lastIndexOf(".");
              el.setSelectionRange(0, dot > 0 ? dot : item.label.length);
            })}
            type="text"
            name="tree-rename"
            autocomplete="off"
            value={item.label}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                props.onRenameCommit?.(item.id, event.currentTarget.value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                props.onRenameCancel?.();
              }
            }}
            onBlur={(event) => props.onRenameCommit?.(item.id, event.currentTarget.value)}
            onClick={(event) => event.stopPropagation()}
            onDblClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            class="h-5 min-w-0 flex-1 rounded-sm bg-input px-1 text-xs text-foreground outline-none ring-1 ring-ring select-text"
          />
        </Show>
      </div>
    );
  };

  const list = (
    <>
      <For each={props.rows}>{(item) => wrap(item, row(item), props.menu)}</For>
      {props.footer}
    </>
  );

  return (
    <div
      role="tree"
      tabIndex={0}
      aria-label={props["aria-label"]}
      onKeyDown={handleKeyDown}
      on:dragover={(event) => handleDragOver(null, event)}
      on:drop={(event) => handleDrop(null, event)}
      on:dragleave={() => dropTarget() === null && setDropTarget(undefined)}
      class={cx("flex min-h-0 flex-col rounded-md outline-none", props.class)}
    >
      <Show when={props.backgroundMenu} fallback={list}>
        <ContextMenu>
          <ContextMenuTrigger as="div" class="flex min-h-full flex-1 flex-col">
            {list}
            <div class="min-h-6 flex-1" />
          </ContextMenuTrigger>
          <ContextMenuPortal>
            <ContextMenuContent class="w-[200px]">{props.backgroundMenu}</ContextMenuContent>
          </ContextMenuPortal>
        </ContextMenu>
      </Show>
    </div>
  );
}

/** A row inside its own context menu when the tree has one for it. */
function wrap(item: TreeRowItem, content: JSX.Element, menu: TreeProps["menu"]): JSX.Element {
  if (!menu) return content;
  return (
    <ContextMenu>
      <ContextMenuTrigger as="div" class="contents">
        {content}
      </ContextMenuTrigger>
      <ContextMenuPortal>
        <ContextMenuContent class="w-[200px]">{menu(item.id)}</ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenu>
  );
}
