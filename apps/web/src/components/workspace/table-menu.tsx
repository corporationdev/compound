/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CellSelection } from '@tiptap/pm/tables';
import type { Editor } from '@tiptap/core';
import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Icon } from '@/components/ui/icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

/** Markdown tables preserve rows and columns. Unsupported merged cells are not offered. */
export function TableMenu(props: { editor: Editor; hidden?: boolean }) {
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  const update = () => {
    const selection = props.editor.state.selection;
    if (!selection.empty && !(selection instanceof CellSelection)) { setRect(null); return; }
    const { $from } = selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type.name !== 'table') continue;
      const element = props.editor.view.nodeDOM($from.before(depth));
      setRect(element instanceof HTMLElement ? element.getBoundingClientRect() : null);
      return;
    }
    setRect(null);
  };
  onMount(() => {
    props.editor.on('transaction', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    onCleanup(() => {
      props.editor.off('transaction', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    });
  });
  return <Show when={rect() && !props.hidden}>
    <Portal>
      <div role="toolbar" aria-label="Table actions" class="workspace-table-toolbar" style={{ left: `${Math.max(8, Math.min(rect()!.left, window.innerWidth - 258))}px`, top: `${Math.max(8, rect()!.top - 36)}px` }} onMouseDown={(event) => event.preventDefault()}>
        <button type="button" onClick={() => props.editor.chain().focus().addRowAfter().run()}>+ Row</button>
        <button type="button" onClick={() => props.editor.chain().focus().addColumnAfter().run()}>+ Column</button>
        <DropdownMenu placement="bottom-start">
          <DropdownMenuTrigger as="button" type="button" aria-label="More table actions"><Icon name="more-three-dots-small-horizontal" class="size-4" /></DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent class="w-52">
              <DropdownMenuItem onSelect={() => props.editor.chain().focus().addRowBefore().run()}>Insert row above</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => props.editor.chain().focus().addRowAfter().run()}>Insert row below</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => props.editor.chain().focus().addColumnBefore().run()}>Insert column left</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => props.editor.chain().focus().addColumnAfter().run()}>Insert column right</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => props.editor.chain().focus().deleteRow().run()}>Delete row</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => props.editor.chain().focus().deleteColumn().run()}>Delete column</DropdownMenuItem>
              <DropdownMenuItem class="text-destructive" onSelect={() => props.editor.chain().focus().deleteTable().run()}>Delete table</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenu>
      </div>
    </Portal>
  </Show>;
}
