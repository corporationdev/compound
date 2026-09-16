/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The WYSIWYG editor over a document's body. Tiptap on ProseMirror, fed
// markdown and asked for markdown back, so what the user edits and what is
// on disk are the same text. Framework-agnostic: mounted into an element the
// page owns, torn down when the page goes.

import { Editor, type AnyExtension } from '@tiptap/core';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { DocumentBlocks } from './document-blocks';

export type DocumentEditorOptions = {
  /** The body as markdown. */
  content: string;
  placeholder?: string;
  /** The document changed by an edit (not by `replaceContent`). */
  onChange: () => void;
  /** A link in the body was clicked. */
  onLinkClick?: (href: string) => void;
  /** More extensions (the slash menu). */
  extensions?: AnyExtension[];
};

export function createDocumentEditor(element: HTMLElement | null, options: DocumentEditorOptions): Editor {
  return new Editor({
    element,
    content: options.content,
    contentType: 'markdown',
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true },
      }),
      Markdown,
      DocumentBlocks,
      Placeholder.configure({
        placeholder: ({ node }) => node.type.name === 'heading'
          ? `Heading ${node.attrs.level}`
          : options.placeholder ?? "Type '/' for commands",
        showOnlyCurrent: true,
        includeChildren: true,
      }),
      TableKit.configure({ table: { resizable: false, allowTableNodeSelection: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      ...(options.extensions ?? []),
    ],
    editorProps: {
      attributes: {
        class: 'workspace-doc select-text outline-none',
        spellcheck: 'true',
      },
      handleClick: (_view, _pos, event) => {
        const anchor = (event.target as HTMLElement | null)?.closest('a[href]');
        const href = anchor?.getAttribute('href');
        if (!href || !options.onLinkClick) return false;
        // A plain click follows the link; with a modifier it edits like any text.
        if (event.metaKey || event.ctrlKey || event.altKey) return false;
        event.preventDefault();
        options.onLinkClick(href);
        return true;
      },
    },
    onUpdate: ({ transaction }) => {
      if (transaction.docChanged) options.onChange();
    },
  });
}

/**
 * Replaces the body with `markdown` from outside (a teammate's or an
 * agent's edit landed on disk), keeping the cursor where it was as far as
 * the new text allows. Not an edit: no change is reported.
 */
export function replaceContent(editor: Editor, markdown: string): void {
  const { from, to } = editor.state.selection;
  editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
  const size = editor.state.doc.content.size;
  const clamp = (position: number) => Math.max(0, Math.min(position, size));
  try {
    editor.commands.setTextSelection({ from: clamp(from), to: clamp(to) });
  } catch {
    // Out of range in the new document: the selection stays where ProseMirror put it.
  }
}
