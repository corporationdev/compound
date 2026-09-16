/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The `/` menu: type a slash in the body and pick what the block becomes,
// or what to make — a heading, a list, a to-do, a table, a new page, a new
// database — the way Notion's slash menu works. The Tiptap suggestion
// plugin watches for the character and the query after it; the menu itself
// is a Solid component the page positions at the caret.

import { Extension } from "@tiptap/core";
import { exitSuggestion, Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";

import { Portal } from "solid-js/web";
import { toast } from "somoto";

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
    getRect: () => props.clientRect?.() ?? null,
    command: (item) => props.command(item),
    focus: () => props.editor.commands.focus(),
    close: () => exitSuggestion(props.editor.view),
  });
  return Extension.create({
    name: "slashCommands",
    priority: 1200,
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          char: "/",
          startOfLine: false,
          allowSpaces: true,
          allow: ({ state }) => !state.selection.$from.parent.type.spec.code,
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).run();
            Promise.resolve(props.run(editor, range)).catch((error: unknown) => toast.error("Could not insert block", { description: error instanceof Error ? error.message : String(error) }));
          },
          items: ({ query }) => filterItems(handlers.items(), query),
          render: () => ({
            onStart: (props) => handlers.onChange(toState(props)),
            onUpdate: (props) => handlers.onChange(toState(props)),
            onKeyDown: (props: SuggestionKeyDownProps) => {
              if (handlers.keys.current?.(props.event)) return true;
              if (props.event.key === "Escape") {
                exitSuggestion(props.view);
                handlers.onChange(null);
                return true;
              }
              return false;
            },
            onExit: () => handlers.onChange(null),
          }),
        }),
      ];
    },
  });
}

/** The menu on screen, at the caret. Rows never shrink when the list scrolls. */
export function SlashMenu(props: { state: SlashState | null; keys: SlashHandlers["keys"] }) {
  const [selected, setSelected] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  const [picker, setPicker] = createSignal<SlashItem["picker"] | null>(null);
  const [search, setSearch] = createSignal("");
  const visibleItems = () => picker() ? filterItems(picker()!.items(), search()) : props.state?.items ?? [];
  const back = () => { setPicker(null); setSearch(""); setSelected(0); props.state?.focus?.(); };
  const choose = (item: SlashItem) => {
    if (item.picker) { setPicker(item.picker); setSearch(""); setSelected(0); }
    else props.state?.command(item);
  };
  let list: HTMLDivElement | undefined;
  let menu: HTMLDivElement | undefined;
  const dismissOutside = (event: PointerEvent) => {
    if (props.state && event.target instanceof Node && !menu?.contains(event.target)) props.state.close?.();
  };
  const reposition = () => setViewport((value) => value + 1);
  onMount(() => {
    document.addEventListener("pointerdown", dismissOutside, true);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
  });
  onCleanup(() => {
    props.keys.current = null;
    document.removeEventListener("pointerdown", dismissOutside, true);
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
  });
  createEffect(on(() => props.state?.query, () => setSelected(0)));
  createEffect(on(search, () => setSelected(0)));
  createEffect(() => { if (!props.state) { setPicker(null); setSearch(""); } });
  createEffect(() => {
    const state = props.state;
    props.keys.current = state ? (event) => {
      const items = visibleItems();
      const count = items.length;
      if (picker() && (event.key === "Escape" || (event.key === "ArrowLeft" && !search()))) {
        back();
        return true;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        setSelected((index) => count ? (index + (event.key === "ArrowDown" ? 1 : -1) + count) % count : 0);
        return true;
      }
      if (event.key === "Home" || event.key === "End") {
        setSelected(event.key === "Home" ? 0 : Math.max(0, count - 1));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[selected()];
        if (item) choose(item);
        return true;
      }
      return false;
    } : null;
  });
  createEffect(on(selected, (index) => {
    list?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }));
  const style = () => {
    viewport();
    const rect = props.state?.getRect?.() ?? props.state?.rect;
    if (!rect) return { display: "none" };
    const width = Math.min(336, window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 16;
    const above = rect.top - 16;
    const flip = below < 280 && above > below;
    return {
      width: `${width}px`,
      "max-height": `${Math.min(420, Math.max(100, flip ? above : below))}px`,
      left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      ...(flip ? { bottom: `${Math.max(12, window.innerHeight - rect.top + 6)}px` } : { top: `${Math.max(12, rect.bottom + 6)}px` }),
    };
  };
  const group = (item: SlashItem) => item.group ?? "Basic blocks";
  return (
    <Show when={props.state}>
      {(state) => (
        <Portal>
          <div ref={menu} class="workspace-slash-menu" style={style()} onMouseDown={(event) => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); }}>
            <Show when={picker()}>
              {(currentPicker) => <div class="shrink-0 border-b border-border p-2">
                <div class="flex items-center gap-1">
                <button type="button" onClick={back} aria-label="Back to block types" title="Back" class="grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent">
                  <Icon name="arrow-left" class="size-4" />
                </button>
                <input
                  ref={(element) => queueMicrotask(() => element.focus())}
                  type="search" value={search()} placeholder={currentPicker().placeholder} aria-label={`Search ${currentPicker().noun}`}
                  role="combobox" aria-expanded="true" aria-controls="slash-options" aria-activedescendant={visibleItems().length ? `slash-option-${selected()}` : undefined}
                  class="h-8 w-full rounded border border-border-strong bg-background px-2 text-xs text-foreground outline-none focus:border-ring select-text"
                  onInput={(event) => setSearch(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (["ArrowUp", "ArrowDown", "ArrowLeft", "Enter", "Escape"].includes(event.key) && props.keys.current?.(event)) event.preventDefault();
                  }}
                />
                </div>
                <div class="px-1 pt-2 pb-0.5 text-xs text-muted-foreground">{currentPicker().title}</div>
              </div>}
            </Show>
            <div id="slash-options" ref={list} class="workspace-slash-list" role="listbox" aria-label={picker()?.title ?? "Insert block"} aria-activedescendant={`slash-option-${selected()}`}>
              <Show when={visibleItems().length === 0}>
                <p class="workspace-slash-empty">{picker() ? search() ? `No ${picker()!.noun} match “${search()}”` : `No ${picker()!.noun} available` : `No blocks match “${state().query}”`}</p>
              </Show>
              <For each={visibleItems()}>
                {(item, index) => <>
                  <Show when={!picker() && (index() === 0 || group(visibleItems()[index() - 1]!) !== group(item))}>
                    <div class="workspace-slash-group">{group(item)}</div>
                  </Show>
                  <button
                    id={`slash-option-${index()}`}
                    type="button" role="option" tabindex="-1"
                    aria-selected={selected() === index()} data-index={index()}
                    onMouseEnter={() => setSelected(index())}
                    onClick={() => choose(item)}
                    class={cx("workspace-slash-option", selected() === index() && "is-selected")}
                    style={picker() ? { "min-height": "34px", padding: "5px 8px", gap: "8px" } : undefined}
                  >
                    <span class={picker() ? "grid size-5 shrink-0 place-items-center text-muted-foreground" : "workspace-slash-icon"}>
                      <Show when={item.glyph} fallback={<Icon name={item.icon} class="size-5" />}>
                        <span>{item.glyph}</span>
                      </Show>
                    </span>
                    <span class="workspace-slash-copy">
                      <span class="workspace-slash-title">{item.title}</span>
                      <Show when={!picker()}><span class="workspace-slash-description">{item.description}</span></Show>
                    </span>
                    <Show when={item.picker} fallback={<Show when={selected() === index()}><span class="workspace-slash-enter">↵</span></Show>}><Icon name="chevron-right" class="size-4 text-muted-foreground" /></Show>
                  </button>
                </>}
              </For>
            </div>
            <div class="workspace-slash-footer"><span>↑ ↓ to navigate</span><span>↵ select · esc {picker() ? "back" : "close"}</span></div>
          </div>
        </Portal>
      )}
    </Show>
  );
}
