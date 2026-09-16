/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The `/` menu: type a slash in the body and pick what the block becomes,
// or what to make — a heading, a list, a to-do, a table, a new page, a new
// database — the way Notion's slash menu works. The Tiptap suggestion
// plugin watches for the character and the query after it; the menu itself
// is a Solid component the page positions at the caret.

import { Extension } from "@tiptap/core";
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { For, Show, createEffect, createSignal, on } from "solid-js";

import { Icon } from "@/components/ui/icon";
import { cx } from "@/lib/cva";

import { filterItems, type SlashItem, type SlashState } from "./slash-items";

export { blockItems, filterItems, type SlashItem, type SlashState } from "./slash-items";

export type SlashHandlers = {
  items: () => SlashItem[];
  onChange: (state: SlashState | null) => void;
  /** Set by the menu while open: answers the keys it handles (arrows, enter, escape). */
  keys: { current: ((event: KeyboardEvent) => boolean) | null };
};

/** The extension that turns `/` into the menu. */
export function createSlashExtension(handlers: SlashHandlers) {
  const toState = (props: SuggestionProps<SlashItem, SlashItem>): SlashState => ({
    items: props.items,
    query: props.query,
    rect: props.clientRect?.() ?? null,
    command: (item) => props.command(item),
  });
  return Extension.create({
    name: "slashCommands",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          char: "/",
          startOfLine: false,
          allowSpaces: false,
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).run();
            void props.run(editor, range);
          },
          items: ({ query }) => filterItems(handlers.items(), query),
          render: () => ({
            onStart: (props) => handlers.onChange(toState(props)),
            onUpdate: (props) => handlers.onChange(toState(props)),
            onKeyDown: (props: SuggestionKeyDownProps) => handlers.keys.current?.(props.event) ?? false,
            onExit: () => handlers.onChange(null),
          }),
        }),
      ];
    },
  });
}

/** The menu on screen, at the caret. */
export function SlashMenu(props: { state: SlashState | null; keys: SlashHandlers["keys"] }) {
  const [selected, setSelected] = createSignal(0);
  let list: HTMLDivElement | undefined;

  createEffect(on(() => props.state?.query, () => setSelected(0)));

  createEffect(() => {
    const state = props.state;
    if (!state) {
      props.keys.current = null;
      return;
    }
    props.keys.current = (event) => {
      const count = state.items.length;
      if (event.key === "ArrowDown") {
        setSelected((index) => (count ? (index + 1) % count : 0));
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelected((index) => (count ? (index - 1 + count) % count : 0));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = state.items[selected()];
        if (item) state.command(item);
        return true;
      }
      if (event.key === "Escape") {
        // Let the plugin close on its own: the query goes away with the slash.
        return false;
      }
      return false;
    };
  });

  createEffect(on(selected, (index) => {
    list?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }));

  const style = () => {
    const rect = props.state?.rect;
    if (!rect) return { display: "none" };
    const below = rect.bottom + 8;
    const flip = below + 320 > window.innerHeight;
    return {
      left: `${Math.min(rect.left, window.innerWidth - 300)}px`,
      ...(flip ? { bottom: `${window.innerHeight - rect.top + 8}px` } : { top: `${below}px` }),
    };
  };

  return (
    <Show when={props.state}>
      {(state) => (
        <div
          ref={list}
          role="listbox"
          aria-label="Insert block"
          style={style()}
          onMouseDown={(event) => event.preventDefault()}
          class="fixed z-50 flex max-h-80 w-72 flex-col overflow-y-auto rounded-lg border border-border-strong bg-popover p-1 shadow-lg"
        >
          <Show when={state().items.length === 0}>
            <p class="px-2 py-2 text-xs text-muted-foreground">No results</p>
          </Show>
          <For each={state().items}>
            {(item, index) => (
              <button
                type="button"
                role="option"
                aria-selected={selected() === index()}
                data-index={index()}
                onMouseEnter={() => setSelected(index())}
                onClick={() => state().command(item)}
                class={cx(
                  "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left",
                  selected() === index() ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                <span class="grid size-7 shrink-0 place-items-center rounded-md border border-border-strong bg-background">
                  <Icon name={item.icon} class="size-5 text-muted-foreground" />
                </span>
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate text-xs text-foreground">{item.title}</span>
                  <span class="truncate text-xxs text-muted-foreground">{item.description}</span>
                </span>
              </button>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}
