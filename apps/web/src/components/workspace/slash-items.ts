/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the slash menu offers and how it is searched. Kept apart from the
// menu's markup so it can be tested without a window.

import type { Editor, Range } from "@tiptap/core";

export type SlashItem = {
  id: string;
  title: string;
  description: string;
  icon: string;
  glyph?: string;
  group?: string;
  keywords?: string[];
  picker?: { title: string; placeholder: string; noun: string; items: () => SlashItem[] };
  /** What choosing the item does; the slash and query are already removed. */
  run: (editor: Editor, range: Range) => unknown;
};

export type SlashState = {
  items: SlashItem[];
  query: string;
  rect: DOMRect | null;
  getRect?: () => DOMRect | null;
  command: (item: SlashItem) => void;
  focus?: () => void;
  close?: () => void;
};

/** The block items every page offers. */
export function blockItems(): SlashItem[] {
  return [
    { id: "text", title: "Text", description: "Plain text", icon: "text-small", keywords: ["paragraph", "plain"], run: (editor) => editor.chain().focus().clearNodes().setParagraph().run() },
    { id: "h1", title: "Heading 1", description: "Big section heading", icon: "text", glyph: "H₁", keywords: ["h1", "title"], run: (editor) => editor.chain().focus().clearNodes().setHeading({ level: 1 }).run() },
    { id: "h2", title: "Heading 2", description: "Medium section heading", icon: "text", glyph: "H₂", keywords: ["h2"], run: (editor) => editor.chain().focus().clearNodes().setHeading({ level: 2 }).run() },
    { id: "h3", title: "Heading 3", description: "Small section heading", icon: "text", glyph: "H₃", keywords: ["h3"], run: (editor) => editor.chain().focus().clearNodes().setHeading({ level: 3 }).run() },
    { id: "bullet", title: "Bulleted list", description: "A simple list", icon: "sequence", glyph: "• ≡", keywords: ["ul", "unordered"], run: (editor) => editor.chain().focus().clearNodes().toggleBulletList().run() },
    { id: "number", title: "Numbered list", description: "A list with numbers", icon: "sequence", glyph: "1.", keywords: ["ol", "ordered"], run: (editor) => editor.chain().focus().clearNodes().toggleOrderedList().run() },
    { id: "todo", title: "To-do list", description: "Track tasks with checkboxes", icon: "confirm-check", keywords: ["task", "checkbox", "checklist"], run: (editor) => editor.chain().focus().clearNodes().toggleTaskList().run() },
    { id: "quote", title: "Quote", description: "Capture a quote", icon: "captions-small", keywords: ["blockquote"], run: (editor) => editor.chain().focus().clearNodes().toggleBlockquote().run() },
    { id: "code", title: "Code", description: "A code block", icon: "terminal", keywords: ["codeblock", "snippet"], run: (editor) => editor.chain().focus().clearNodes().toggleCodeBlock().run() },
    { id: "divider", title: "Divider", description: "A horizontal rule", icon: "minus", keywords: ["hr", "rule", "line"], run: (editor) => editor.chain().focus().setHorizontalRule().run() },
    { id: "table", title: "Table", description: "A simple table in this page", icon: "page-table", keywords: ["grid"], run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  ];
}

/** Items matching `query` by title or keyword, in the given order. */
export function filterItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) =>
    item.title.toLowerCase().includes(needle) || (item.keywords ?? []).some((keyword) => keyword.includes(needle)),
  );
}
