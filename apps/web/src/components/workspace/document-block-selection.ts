/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Node } from '@tiptap/pm/model';
import { NodeSelection, Selection, type SelectionBookmark } from '@tiptap/pm/state';
import type { Mappable } from '@tiptap/pm/transform';

export function documentBlockPositions(doc: Node): number[] {
  const positions: number[] = [];
  doc.forEach((_node, position) => positions.push(position));
  return positions;
}

function boundary(doc: Node, position: number): number {
  const positions = documentBlockPositions(doc);
  return [...positions].reverse().find((start) => start <= position) ?? 0;
}

/** A real document selection: copy/cut, paste, history, and transactions retain whole blocks. */
export class DocumentBlockSelection extends Selection {
  constructor(readonly anchorBlock: number, readonly headBlock: number, doc: Node) {
    const from = Math.min(anchorBlock, headBlock);
    const last = Math.max(anchorBlock, headBlock);
    super(doc.resolve(from), doc.resolve(last + doc.nodeAt(last)!.nodeSize));
    this.visible = false;
  }

  eq(other: Selection): boolean {
    return other instanceof DocumentBlockSelection && other.anchorBlock === this.anchorBlock && other.headBlock === this.headBlock;
  }

  map(doc: Node, mapping: Mappable): Selection {
    return blockSelection(doc, boundary(doc, mapping.map(this.anchorBlock)), boundary(doc, mapping.map(this.headBlock)));
  }

  toJSON() { return { type: 'compoundBlockRange', anchorBlock: this.anchorBlock, headBlock: this.headBlock }; }

  static fromJSON(doc: Node, json: { anchorBlock: number; headBlock: number }): Selection {
    return blockSelection(doc, boundary(doc, json.anchorBlock), boundary(doc, json.headBlock));
  }

  getBookmark(): SelectionBookmark {
    const bookmark = (anchor: number, head: number): SelectionBookmark => ({
      map: (mapping) => bookmark(mapping.map(anchor), mapping.map(head)),
      resolve: (doc) => blockSelection(doc, boundary(doc, anchor), boundary(doc, head)),
    });
    return bookmark(this.anchorBlock, this.headBlock);
  }
}

Selection.jsonID('compoundBlockRange', DocumentBlockSelection);

export function blockSelection(doc: Node, anchor: number, head: number): Selection {
  return anchor === head ? NodeSelection.create(doc, anchor) : new DocumentBlockSelection(anchor, head, doc);
}

export function isDocumentBlockSelection(selection: Selection): selection is NodeSelection | DocumentBlockSelection {
  return selection instanceof DocumentBlockSelection || (selection instanceof NodeSelection && selection.$from.depth === 0);
}

export function blockSelectionEnds(selection: Selection): { anchor: number; head: number } {
  return selection instanceof DocumentBlockSelection
    ? { anchor: selection.anchorBlock, head: selection.headBlock }
    : { anchor: selection.from, head: selection.from };
}
