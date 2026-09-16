/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Extension, type Command } from '@tiptap/core';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { blockSelection, blockSelectionEnds, documentBlockPositions, DocumentBlockSelection, isDocumentBlockSelection } from './document-block-selection';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection, Plugin, type EditorState, type Transaction } from '@tiptap/pm/state';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    documentBlocks: {
      selectDocumentBlock: (position?: number, extend?: boolean) => ReturnType;
      editDocumentBlock: () => ReturnType;
      navigateDocumentBlock: (direction: -1 | 1, extend?: boolean) => ReturnType;
      duplicateDocumentBlock: () => ReturnType;
      clearDocumentBlocks: () => ReturnType;
      deleteDocumentBlock: () => ReturnType;
      moveDocumentBlockUp: () => ReturnType;
      moveDocumentBlockDown: () => ReturnType;
      moveDocumentBlockTo: (sourcePosition: number, targetPosition: number) => ReturnType;
      insertDocumentBlock: (side?: 'before' | 'after') => ReturnType;
    };
  }
}

/** Top-level block boundaries, including every block touched by a selection. */
export function selectedDocumentBlocks(state: EditorState, position?: number): { from: number; to: number } {
  const { doc, selection } = state;
  const from = position ?? selection.from;
  const to = position ?? selection.to;
  let first = 0;
  let last = doc.content.size;
  doc.forEach((node, offset) => {
    if (offset <= from && from < offset + node.nodeSize) first = offset;
    if (offset < to && to <= offset + node.nodeSize) last = offset + node.nodeSize;
    if (from === to && offset <= from && from < offset + node.nodeSize) last = offset + node.nodeSize;
  });
  if (from === doc.content.size) {
    first = doc.content.size - (doc.lastChild?.nodeSize ?? 0);
    last = doc.content.size;
  }
  return { from: first, to: last };
}

function selectBlock(tr: Transaction, position: number): Transaction {
  const node = tr.doc.nodeAt(position);
  return tr.setSelection(node && NodeSelection.isSelectable(node)
    ? NodeSelection.create(tr.doc, position)
    : Selection.near(tr.doc.resolve(position)));
}

function selectBlockRange(tr: Transaction, from: number, to: number, reversed = false): Transaction {
  const positions = documentBlockPositions(tr.doc).filter((position) => position >= from && position < to);
  const first = positions[0]!;
  const last = positions[positions.length - 1]!;
  return tr.setSelection(blockSelection(tr.doc, reversed ? last : first, reversed ? first : last));
}

/** Move only across document block boundaries; nested table/list structure stays intact. */
export function moveDocumentBlocks(state: EditorState, from: number, to: number, target: number): Transaction | null {
  const boundaries = new Set([0, state.doc.content.size]);
  state.doc.forEach((node, pos) => { boundaries.add(pos); boundaries.add(pos + node.nodeSize); });
  if (![from, to, target].every((pos) => boundaries.has(pos)) || from >= to || (target >= from && target <= to)) return null;
  const slice = state.doc.slice(from, to);
  const insertion = target > to ? target - (to - from) : target;
  const tr = state.tr.delete(from, to).insert(insertion, slice.content);
  const reversed = state.selection instanceof DocumentBlockSelection && state.selection.headBlock < state.selection.anchorBlock;
  return selectBlockRange(tr, insertion, insertion + to - from, reversed).scrollIntoView();
}

export const DocumentBlocks = Extension.create({
  name: 'documentBlocks',
  // Let slash suggestions consume Escape before block selection does.
  priority: 1100,

  addCommands() {
    const move = (direction: -1 | 1): Command => ({ state, dispatch }) => {
      const { from, to } = selectedDocumentBlocks(state);
      const neighbor = direction < 0 ? state.doc.resolve(from).nodeBefore : state.doc.resolve(to).nodeAfter;
      if (!neighbor) return false;
      const target = direction < 0 ? from - neighbor.nodeSize : to + neighbor.nodeSize;
      const tr = moveDocumentBlocks(state, from, to, target);
      if (tr && dispatch) dispatch(tr);
      return !!tr;
    };
    return {
      selectDocumentBlock: (position, extend = false) => ({ state, tr, dispatch }) => {
        if (position !== undefined && (position < 0 || position > state.doc.content.size)) return false;
        const { from, to } = selectedDocumentBlocks(state, position);
        if (dispatch) {
          if (extend && isDocumentBlockSelection(state.selection)) tr.setSelection(blockSelection(tr.doc, blockSelectionEnds(state.selection).anchor, from));
          else if (position === undefined && !state.selection.empty) selectBlockRange(tr, from, to, state.selection.anchor > state.selection.head);
          else selectBlock(tr, from);
        }
        return true;
      },
      editDocumentBlock: () => ({ state, tr, dispatch, commands }) => {
        if (!isDocumentBlockSelection(state.selection)) return false;
        const { head } = blockSelectionEnds(state.selection);
        const node = state.doc.nodeAt(head)!;
        let position: number | undefined;
        state.doc.nodesBetween(head, head + node.nodeSize, (child, offset) => {
          if (child.isTextblock) { position = offset + child.nodeSize - 1; return false; }
          return true;
        });
        if (position === undefined) return commands.insertDocumentBlock('after');
        if (dispatch) tr.setSelection(TextSelection.create(tr.doc, position)).scrollIntoView();
        return true;
      },
      navigateDocumentBlock: (direction, extend = false) => ({ state, tr, dispatch }) => {
        if (!isDocumentBlockSelection(state.selection)) return false;
        const positions = documentBlockPositions(state.doc);
        const { anchor, head } = blockSelectionEnds(state.selection);
        const next = positions[Math.max(0, Math.min(positions.length - 1, positions.indexOf(head) + direction))]!;
        if (dispatch) tr.setSelection(blockSelection(tr.doc, extend ? anchor : next, next)).scrollIntoView();
        return true;
      },
      clearDocumentBlocks: () => ({ state, chain }) => {
        // NodeSelection maps to a cursor when its list/quote wrapper is lifted.
        // Select its text first so converting a container includes every item.
        if (!isDocumentBlockSelection(state.selection)) return chain().clearNodes().run();
        const { from, to } = selectedDocumentBlocks(state);
        let first: number | undefined;
        let last: number | undefined;
        state.doc.nodesBetween(from, to, (node, position) => {
          if (node.isTextblock) {
            first ??= position + 1;
            last = position + node.nodeSize - 1;
            return false;
          }
          return true;
        });
        if (first === undefined || last === undefined) return false;
        return chain().setTextSelection({ from: first, to: last }).clearNodes().run();
      },
      duplicateDocumentBlock: () => ({ state, tr, dispatch }) => {
        const { from, to } = selectedDocumentBlocks(state);
        if (dispatch) {
          tr.insert(to, state.doc.slice(from, to).content);
          selectBlockRange(tr, to, to + to - from).scrollIntoView();
        }
        return true;
      },
      deleteDocumentBlock: () => ({ state, tr, dispatch }) => {
        const { from, to } = selectedDocumentBlocks(state);
        if (dispatch) {
          tr.delete(from, to);
          tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)))).scrollIntoView();
        }
        return true;
      },
      moveDocumentBlockUp: () => move(-1),
      moveDocumentBlockDown: () => move(1),
      moveDocumentBlockTo: (source, target) => ({ state, dispatch }) => {
        if (source < 0 || source >= state.doc.content.size) return false;
        const insideSelection = isDocumentBlockSelection(state.selection) && source >= state.selection.from && source < state.selection.to;
        const { from, to } = selectedDocumentBlocks(state, insideSelection ? undefined : source);
        const tr = moveDocumentBlocks(state, from, to, target);
        if (tr && dispatch) dispatch(tr);
        return !!tr;
      },
      insertDocumentBlock: (side = 'after') => ({ state, tr, dispatch }) => {
        const range = selectedDocumentBlocks(state);
        const position = side === 'before' ? range.from : range.to;
        const paragraph = state.schema.nodes.paragraph?.create();
        if (!paragraph) return false;
        if (dispatch) {
          tr.insert(position, paragraph);
          tr.setSelection(Selection.near(tr.doc.resolve(position + 1))).scrollIntoView();
        }
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({ props: {
      decorations: (state) => {
        if (!(state.selection instanceof DocumentBlockSelection)) return null;
        const decorations: Decoration[] = [];
        state.doc.forEach((node, position) => {
          if (position >= state.selection.from && position < state.selection.to) decorations.push(Decoration.node(position, position + node.nodeSize, { class: 'workspace-selected-block' }));
        });
        return DecorationSet.create(state.doc, decorations);
      },
    } })];
  },

  addKeyboardShortcuts() {
    return {
      Escape: () => {
        if (isDocumentBlockSelection(this.editor.state.selection)) return true;
        return this.editor.commands.selectDocumentBlock();
      },
      Enter: () => this.editor.commands.editDocumentBlock(),
      ArrowUp: () => this.editor.commands.navigateDocumentBlock(-1),
      ArrowDown: () => this.editor.commands.navigateDocumentBlock(1),
      'Shift-ArrowUp': () => this.editor.commands.navigateDocumentBlock(-1, true),
      'Shift-ArrowDown': () => this.editor.commands.navigateDocumentBlock(1, true),
      Backspace: () => isDocumentBlockSelection(this.editor.state.selection) && this.editor.commands.deleteDocumentBlock(),
      Delete: () => isDocumentBlockSelection(this.editor.state.selection) && this.editor.commands.deleteDocumentBlock(),
      'Mod-d': () => this.editor.commands.duplicateDocumentBlock(),
      'Mod-Shift-ArrowUp': () => this.editor.commands.moveDocumentBlockUp(),
      'Mod-Shift-ArrowDown': () => this.editor.commands.moveDocumentBlockDown(),
      Tab: () => {
        if (this.editor.isActive('table')) return false;
        if (this.editor.isActive('codeBlock')) return this.editor.commands.insertContent('  ');
        if (this.editor.isActive('taskItem')) return this.editor.commands.sinkListItem('taskItem');
        return this.editor.commands.sinkListItem('listItem');
      },
      'Shift-Tab': () => {
        if (this.editor.isActive('table')) return false;
        if (this.editor.isActive('taskItem')) return this.editor.commands.liftListItem('taskItem');
        return this.editor.commands.liftListItem('listItem');
      },
      'Mod-Enter': () => {
        const { state } = this.editor;
        const { $from } = state.selection;
        for (let depth = $from.depth; depth > 0; depth--) {
          const node: ProseMirrorNode = $from.node(depth);
          if (node.type.name !== 'taskItem') continue;
          this.editor.view.dispatch(state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, checked: !node.attrs.checked }));
          return true;
        }
        return false;
      },
    };
  },
});
