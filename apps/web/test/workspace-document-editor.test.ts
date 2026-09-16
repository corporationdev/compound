import { afterEach, describe, expect, test } from 'bun:test';
import type { Editor } from '@tiptap/core';
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import { DocumentBlockSelection, documentBlockPositions } from '../src/components/workspace/document-block-selection';
import { blockItems } from '../src/components/workspace/slash-items';
import { createDocumentEditor, replaceContent } from '../src/components/workspace/document-editor';

const editors: Editor[] = [];
function editor(content: string) {
  const instance = createDocumentEditor(null, { content, onChange: () => {} });
  editors.push(instance);
  return instance;
}
afterEach(() => { editors.splice(0).forEach((instance) => instance.destroy()); });

function blocks(instance: Editor) {
  const result: string[] = [];
  instance.state.doc.forEach((node) => result.push(node.textContent));
  return result;
}

describe('document block editing', () => {
  test('selects, duplicates, moves, and deletes a complete block, preserving marks', () => {
    const e = editor('First\n\n## **Second**\n\nThird');
    e.commands.selectDocumentBlock(10);
    expect(e.state.selection).toBeInstanceOf(NodeSelection);
    expect((e.state.selection as NodeSelection).node.type.name).toBe('heading');
    e.commands.duplicateDocumentBlock();
    expect(blocks(e)).toEqual(['First', 'Second', 'Second', 'Third']);
    e.commands.moveDocumentBlockDown();
    expect(blocks(e)).toEqual(['First', 'Second', 'Third', 'Second']);
    expect(e.commands.moveDocumentBlockDown()).toBe(false);
    e.commands.moveDocumentBlockUp();
    e.commands.deleteDocumentBlock();
    expect(e.getMarkdown()).toBe('First\n\n## **Second**\n\nThird');
  });

  test('dragging moves lists intact and rejects targets inside blocks', () => {
    const e = editor('Intro\n\n- One\n- Two\n\nEnd');
    const start = e.state.doc.firstChild!.nodeSize;
    expect(e.commands.moveDocumentBlockTo(start, 2)).toBe(false);
    expect(e.commands.moveDocumentBlockTo(start, e.state.doc.content.size)).toBe(true);
    expect(blocks(e)).toEqual(['Intro', 'End', 'OneTwo']);
    expect(e.state.doc.lastChild!.type.name).toBe('bulletList');
    expect(e.commands.moveDocumentBlockTo(e.state.doc.content.size - e.state.doc.lastChild!.nodeSize, 0)).toBe(true);
    expect(blocks(e)).toEqual(['OneTwo', 'Intro', 'End']);
  });

  test('supports block ranges and keeps an editable paragraph when the final block is deleted', () => {
    const e = editor('One\n\nTwo\n\nThree');
    e.commands.setTextSelection({ from: 2, to: 8 });
    e.commands.duplicateDocumentBlock();
    expect(blocks(e)).toEqual(['One', 'Two', 'One', 'Two', 'Three']);
    e.commands.selectAll();
    e.commands.deleteDocumentBlock();
    expect(e.state.doc.childCount).toBe(1);
    expect(e.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(e.state.doc.textContent).toBe('');
  });

  test('inserts empty paragraphs adjacent to the selected block', () => {
    const e = editor('## Heading\n\nText');
    e.commands.selectDocumentBlock(0);
    e.commands.insertDocumentBlock('before');
    expect(blocks(e)).toEqual(['', 'Heading', 'Text']);
    expect(e.state.selection.$from.parent.type.name).toBe('paragraph');
    e.commands.selectDocumentBlock(2);
    e.commands.insertDocumentBlock('after');
    expect(blocks(e)).toEqual(['', 'Heading', '', 'Text']);
  });

  test('converting selected list containers preserves and converts every item', () => {
    const e = editor('- One\n- **Two**\n\nAfter');
    e.commands.selectDocumentBlock(0);
    e.commands.clearDocumentBlocks();
    e.commands.setHeading({ level: 2 });
    expect(e.getMarkdown()).toBe('## One\n\n## **Two**\n\nAfter');
    expect(blocks(e)).toEqual(['One', 'Two', 'After']);
  });

  test('can checks do not edit the document and chained selection targets the selected block', () => {
    const e = editor('One\n\nTwo');
    const original = e.getMarkdown();
    expect(e.can().moveDocumentBlockDown()).toBe(true);
    expect(e.getMarkdown()).toBe(original);
    e.chain().selectDocumentBlock(7).duplicateDocumentBlock().run();
    expect(blocks(e)).toEqual(['One', 'Two', 'Two']);
  });
});

describe('selected block keyboard behavior', () => {
  test('Enter edits the selected text at its end without adding or replacing content', () => {
    const e = editor('First\n\n## Heading\n\nLast');
    const content = e.getMarkdown();
    e.commands.selectDocumentBlock(8);
    expect(e.commands.editDocumentBlock()).toBe(true);
    expect(e.state.selection).toBeInstanceOf(TextSelection);
    expect(e.state.selection.$from.parent.textContent).toBe('Heading');
    expect(e.state.selection.$from.parentOffset).toBe(7);
    expect(e.getMarkdown()).toBe(content);
    expect(e.commands.editDocumentBlock()).toBe(false);
    expect(e.commands.navigateDocumentBlock(1)).toBe(false);
  });

  test('arrow navigation stays in block mode and stops at page boundaries', () => {
    const e = editor('First\n\n---\n\nLast');
    e.commands.selectDocumentBlock(0);
    e.commands.navigateDocumentBlock(-1);
    expect(e.state.selection.from).toBe(0);
    e.commands.navigateDocumentBlock(1);
    expect((e.state.selection as NodeSelection).node.type.name).toBe('horizontalRule');
    e.commands.navigateDocumentBlock(1);
    e.commands.navigateDocumentBlock(1);
    expect((e.state.selection as NodeSelection).node.textContent).toBe('Last');
  });

  test('Shift arrows expand, shrink, and reverse from a stable anchor', () => {
    const e = editor('First\n\nMiddle\n\nLast');
    const positions = documentBlockPositions(e.state.doc);
    e.commands.selectDocumentBlock(positions[1]);
    e.commands.navigateDocumentBlock(1, true);
    expect(e.state.selection).toBeInstanceOf(DocumentBlockSelection);
    expect(e.state.selection.content().content.textBetween(0, e.state.selection.content().content.size, '|')).toBe('Middle|Last');
    e.commands.navigateDocumentBlock(-1, true);
    expect(e.state.selection).toBeInstanceOf(NodeSelection);
    expect((e.state.selection as NodeSelection).node.textContent).toBe('Middle');
    e.commands.navigateDocumentBlock(-1, true);
    expect((e.state.selection as DocumentBlockSelection).anchorBlock).toBe(positions[1]);
    expect((e.state.selection as DocumentBlockSelection).headBlock).toBe(0);
    e.commands.navigateDocumentBlock(-1, true);
    expect(e.state.selection.from).toBe(0);
    expect(e.state.selection.to).toBe(positions[2]);
  });

  test('block ranges duplicate, move, delete and undo as complete blocks', () => {
    const e = editor('First\n\n**Middle**\n\nLast');
    e.commands.selectDocumentBlock(0);
    e.commands.navigateDocumentBlock(1, true);
    e.commands.duplicateDocumentBlock();
    expect(blocks(e)).toEqual(['First', 'Middle', 'First', 'Middle', 'Last']);
    expect(e.state.selection).toBeInstanceOf(DocumentBlockSelection);
    e.commands.moveDocumentBlockDown();
    expect(blocks(e)).toEqual(['First', 'Middle', 'Last', 'First', 'Middle']);
    expect(e.state.selection).toBeInstanceOf(DocumentBlockSelection);
    e.commands.deleteDocumentBlock();
    expect(e.getMarkdown()).toBe('First\n\n**Middle**\n\nLast');
    e.commands.undo();
    expect(e.state.doc.textContent).toContain('Middle');
  });

  test('range bookmarks and JSON resolve after transaction mapping', () => {
    const e = editor('First\n\nMiddle\n\nLast');
    e.commands.selectDocumentBlock(0);
    e.commands.navigateDocumentBlock(1, true);
    const selection = e.state.selection;
    expect(Selection.fromJSON(e.state.doc, selection.toJSON()).eq(selection)).toBe(true);
    const paragraph = e.state.schema.nodes.paragraph!.create(null, e.state.schema.text('New'));
    const tr = e.state.tr.insert(0, paragraph);
    const mapped = selection.getBookmark().map(tr.mapping).resolve(tr.doc);
    expect(mapped.from).toBe(paragraph.nodeSize);
    expect(mapped).toBeInstanceOf(DocumentBlockSelection);
    expect(mapped.content().content.textBetween(0, mapped.content().content.size, '|')).toBe('First|Middle');
  });

  test('full list and multi-block menu conversions preserve all text and marks', () => {
    const e = editor('- One\n- **Two**\n\nThree\n\nAfter');
    e.commands.selectDocumentBlock(0);
    e.commands.navigateDocumentBlock(1, true);
    e.commands.clearDocumentBlocks();
    blockItems().find((item) => item.id === 'h2')!.run(e, { from: 0, to: 0 });
    expect(e.getMarkdown()).toBe('## One\n\n## **Two**\n\n## Three\n\nAfter');
  });

  test('Enter on an atom inserts an editable paragraph and can checks preserve state', () => {
    const e = editor('---');
    e.commands.selectDocumentBlock(0);
    expect(e.can().editDocumentBlock()).toBe(true);
    expect(e.state.doc.childCount).toBe(1);
    e.commands.editDocumentBlock();
    expect(e.state.doc.childCount).toBe(2);
    expect(e.state.selection.$from.parent.type.name).toBe('paragraph');
  });
});

describe('Markdown editor persistence', () => {
  test('all supported blocks and inline marks survive save and reopen', () => {
    const content = '# Heading\n\nPlain **bold**, *italic*, ~~strike~~, ++underline++, `code`, and [link](https://example.com).\n\n- One\n  - Nested\n- Two\n\n1. First\n2. Second\n\n- [ ] Open\n- [x] Done\n\n> A quote\n\n```typescript\nconst x = 1;\n```\n\n---\n\n| Name | Value |\n| --- | --- |\n| Alpha | 42 |';
    const e = editor(content);
    const saved = e.getMarkdown();
    expect(editor(saved).getJSON()).toEqual(e.getJSON());
    expect(saved).toContain('++underline++');
    expect(saved).toContain('```typescript');
  });

  test('table row and column edits survive a Markdown roundtrip', () => {
    const e = editor('| Name | Value |\n| --- | --- |\n| Alpha | 42 |');
    e.commands.setTextSelection(4);
    expect(e.commands.addRowAfter()).toBe(true);
    expect(e.commands.addColumnAfter()).toBe(true);
    expect(e.state.doc.firstChild!.childCount).toBe(3);
    expect(e.state.doc.firstChild!.firstChild!.childCount).toBe(3);
    expect(editor(e.getMarkdown()).getJSON()).toEqual(e.getJSON());
    expect(e.commands.deleteColumn()).toBe(true);
    expect(e.commands.deleteRow()).toBe(true);
    expect(e.state.doc.firstChild!.childCount).toBe(2);
    expect(e.state.doc.firstChild!.firstChild!.childCount).toBe(2);
  });

  test('external updates keep selection in bounds without reporting an edit', () => {
    let changes = 0;
    const e = createDocumentEditor(null, { content: 'A long initial paragraph', onChange: () => { changes++; } });
    editors.push(e);
    e.commands.setTextSelection(20);
    replaceContent(e, 'Short');
    expect(e.getMarkdown()).toBe('Short');
    expect(e.state.selection.to).toBeLessThanOrEqual(e.state.doc.content.size);
    expect(changes).toBe(0);
  });
});
