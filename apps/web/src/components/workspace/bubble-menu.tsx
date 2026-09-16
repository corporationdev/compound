/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The toolbar that floats over a text selection: turn the block into
// something else, bold, italic, underline, strike, code, link. Shown while
// something is selected in the body and hidden the moment it is not.

import { posToDOMRect, type Editor } from "@tiptap/core";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cx } from "@/lib/cva";

type Block = { id: string; label: string; active: (editor: Editor) => boolean; run: (editor: Editor) => void };

const BLOCKS: Block[] = [
  { id: "text", label: "Text", active: (e) => e.isActive("paragraph") && !e.isActive("bulletList") && !e.isActive("orderedList") && !e.isActive("taskList") && !e.isActive("blockquote"), run: (e) => e.chain().focus().clearNodes().setParagraph().run() },
  { id: "h1", label: "Heading 1", active: (e) => e.isActive("heading", { level: 1 }), run: (e) => e.chain().focus().clearNodes().toggleHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", active: (e) => e.isActive("heading", { level: 2 }), run: (e) => e.chain().focus().clearNodes().toggleHeading({ level: 2 }).run() },
  { id: "h3", label: "Heading 3", active: (e) => e.isActive("heading", { level: 3 }), run: (e) => e.chain().focus().clearNodes().toggleHeading({ level: 3 }).run() },
  { id: "bullet", label: "Bulleted list", active: (e) => e.isActive("bulletList"), run: (e) => e.chain().focus().clearNodes().toggleBulletList().run() },
  { id: "number", label: "Numbered list", active: (e) => e.isActive("orderedList"), run: (e) => e.chain().focus().clearNodes().toggleOrderedList().run() },
  { id: "todo", label: "To-do list", active: (e) => e.isActive("taskList"), run: (e) => e.chain().focus().clearNodes().toggleTaskList().run() },
  { id: "quote", label: "Quote", active: (e) => e.isActive("blockquote"), run: (e) => e.chain().focus().clearNodes().toggleBlockquote().run() },
  { id: "code", label: "Code", active: (e) => e.isActive("codeBlock"), run: (e) => e.chain().focus().clearNodes().toggleCodeBlock().run() },
];

type Mark = { id: string; label: string; icon: string; shortcut: string; run: (editor: Editor) => void };

const MARKS: Mark[] = [
  { id: "bold", label: "Bold", icon: "text", shortcut: "⌘B", run: (e) => e.chain().focus().toggleBold().run() },
  { id: "italic", label: "Italic", icon: "text", shortcut: "⌘I", run: (e) => e.chain().focus().toggleItalic().run() },
  { id: "underline", label: "Underline", icon: "text", shortcut: "⌘U", run: (e) => e.chain().focus().toggleUnderline().run() },
  { id: "strike", label: "Strikethrough", icon: "text", shortcut: "⌘⇧S", run: (e) => e.chain().focus().toggleStrike().run() },
  { id: "code", label: "Code", icon: "terminal", shortcut: "⌘E", run: (e) => e.chain().focus().toggleCode().run() },
];

const GLYPHS: Record<string, string> = { bold: "B", italic: "I", underline: "U", strike: "S" };

export function BubbleMenu(props: { editor: Editor; hidden?: boolean }) {
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  const [tick, setTick] = createSignal(0);
  const [linkDraft, setLinkDraft] = createSignal<string | null>(null);

  const update = () => {
    const { editor } = props;
    const { from, to, empty } = editor.state.selection;
    const focused = editor.isFocused || linkDraft() !== null;
    if (empty || !focused || editor.isActive("codeBlock")) {
      setRect(null);
      setLinkDraft(null);
      return;
    }
    setRect(posToDOMRect(editor.view, from, to));
    setTick((value) => value + 1);
  };

  onMount(() => {
    props.editor.on("selectionUpdate", update);
    props.editor.on("transaction", update);
    props.editor.on("blur", () => setTimeout(update, 120));
    props.editor.on("focus", update);
    window.addEventListener("scroll", update, true);
    onCleanup(() => {
      props.editor.off("selectionUpdate", update);
      props.editor.off("transaction", update);
      window.removeEventListener("scroll", update, true);
    });
  });

  const active = (id: string): boolean => {
    tick();
    return props.editor.isActive(id);
  };

  const currentBlock = () => {
    tick();
    return BLOCKS.find((block) => block.active(props.editor)) ?? BLOCKS[0]!;
  };

  let toolbar: HTMLDivElement | undefined;

  // Centred over the selection and kept on screen; the toolbar is as wide
  // as its buttons, so its width is measured rather than assumed.
  const style = () => {
    const box = rect();
    if (!box) return { display: "none" };
    tick();
    const width = toolbar?.offsetWidth ?? 320;
    const left = Math.max(8, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - width - 8));
    const top = box.top - 44;
    return { left: `${left}px`, top: `${Math.max(8, top)}px` };
  };

  const applyLink = (href: string) => {
    const value = href.trim();
    if (value) props.editor.chain().focus().extendMarkRange("link").setLink({ href: value }).run();
    else props.editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setLinkDraft(null);
  };

  const button = "inline-flex h-7 min-w-7 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground";

  return (
    <Show when={rect() && !props.hidden}>
      <div
        ref={toolbar}
        role="toolbar"
        aria-label="Format"
        style={style()}
        onMouseDown={(event) => {
          // The selection must survive a click on the toolbar.
          if ((event.target as HTMLElement).tagName !== "INPUT") event.preventDefault();
        }}
        class="fixed z-50 flex h-9 w-max items-center gap-0.5 rounded-lg border border-border-strong bg-popover px-1 shadow-lg"
      >
        <Show
          when={linkDraft() === null}
          fallback={
            <input
              ref={(el) => queueMicrotask(() => el.focus())}
              type="text"
              value={linkDraft() ?? ""}
              placeholder="Paste a link, or a page path"
              aria-label="Link"
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") applyLink(event.currentTarget.value);
                if (event.key === "Escape") setLinkDraft(null);
              }}
              onBlur={(event) => applyLink(event.currentTarget.value)}
              class="h-7 w-72 min-w-0 rounded-md bg-input px-2 text-xs text-foreground outline-none ring-1 ring-ring select-text"
            />
          }
        >
          <DropdownMenu placement="bottom-start">
            <DropdownMenuTrigger as="button" type="button" class={cx(button, "gap-1 pl-2")}>
              <span>{currentBlock().label}</span>
              <Icon name="chevron-down" class="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
              <DropdownMenuContent class="w-44">
                <For each={BLOCKS}>
                  {(block) => (
                    <DropdownMenuItem onSelect={() => block.run(props.editor)}>
                      <span class="flex-1">{block.label}</span>
                      <Show when={block.id === currentBlock().id}>
                        <Icon name="confirm-check" class="size-4" />
                      </Show>
                    </DropdownMenuItem>
                  )}
                </For>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenu>
          <span class="mx-0.5 h-5 w-px bg-border-strong" />
          <For each={MARKS}>
            {(mark) => (
              <button
                type="button"
                title={`${mark.label} ${mark.shortcut}`}
                aria-label={mark.label}
                aria-pressed={active(mark.id)}
                onClick={() => mark.run(props.editor)}
                class={cx(button, active(mark.id) && "bg-accent text-foreground")}
              >
                <Show when={GLYPHS[mark.id]} fallback={<Icon name={mark.icon} class="size-4" />}>
                  <span
                    class={cx(
                      "font-450",
                      mark.id === "bold" && "font-bold",
                      mark.id === "italic" && "italic",
                      mark.id === "underline" && "underline",
                      mark.id === "strike" && "line-through",
                    )}
                  >
                    {GLYPHS[mark.id]}
                  </span>
                </Show>
              </button>
            )}
          </For>
          <span class="mx-0.5 h-5 w-px bg-border-strong" />
          <button
            type="button"
            title="Link ⌘K"
            aria-label="Link"
            aria-pressed={active("link")}
            onClick={() => setLinkDraft((props.editor.getAttributes("link").href as string | undefined) ?? "")}
            class={cx(button, "gap-1 px-2", active("link") && "bg-accent text-foreground")}
          >
            <Icon name="external-link" class="size-4" />
            <span>Link</span>
          </button>
        </Show>
      </div>
    </Show>
  );
}
