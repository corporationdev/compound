/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Editor } from '@tiptap/core';
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Icon } from '@/components/ui/icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { DocumentBlockSelection } from './document-block-selection';
import { blockItems } from './slash-items';

type HoveredBlock = { position: number; element: HTMLElement; rect: DOMRect };

/** The gutter follows the hovered top-level block without changing the document. */
export function BlockMenu(props: { editor: Editor; hidden?: boolean }) {
  const [block, setBlock] = createSignal<HoveredBlock | null>(null);
  const [open, setOpen] = createSignal(false);
  const [dropLine, setDropLine] = createSignal<{ left: number; top: number; width: number; position: number } | null>(null);
  let source: number | null = null;
  let pointerPending = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const select = () => {
    const hovered = block();
    if (!hovered) return;
    const selection = props.editor.state.selection;
    if (selection instanceof DocumentBlockSelection && hovered.position >= selection.from && hovered.position < selection.to) return;
    props.editor.commands.selectDocumentBlock(hovered.position);
  };
  const finish = () => { source = null; pointerPending = false; setDropLine(null); };
  const run = (action: () => void) => { select(); action(); setOpen(false); setBlock(null); };
  onMount(() => {
    const root = props.editor.view.dom;
    const host = root.parentElement!;
    const hover = (event: MouseEvent) => {
      if (open() || source !== null || !(event.target instanceof HTMLElement)) return;
      let element = event.target;
      while (element.parentElement && element.parentElement !== root && element !== root) element = element.parentElement;
      if (element.parentElement !== root) return;
      clearTimeout(hideTimer);
      const position = props.editor.view.posAtDOM(element, 0);
      const resolved = props.editor.state.doc.resolve(position);
      setBlock({ position: resolved.depth ? resolved.before(1) : position, element, rect: element.getBoundingClientRect() });
    };
    const leave = () => { hideTimer = setTimeout(() => { if (!open() && source === null) setBlock(null); }, 180); };
    const refresh = () => {
      const current = block();
      if (!current) return;
      if (!current.element.isConnected || current.position > props.editor.state.doc.content.size) { setBlock(null); return; }
      setBlock({ ...current, rect: current.element.getBoundingClientRect() });
    };
    const target = (event: DragEvent) => {
      if (source === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      let position = props.editor.state.doc.content.size;
      let top = root.getBoundingClientRect().bottom;
      for (const child of root.children) {
        const rect = child.getBoundingClientRect();
        if (event.clientY < rect.top + rect.height / 2) {
          const pos = props.editor.view.posAtDOM(child, 0);
          const resolved = props.editor.state.doc.resolve(pos);
          position = resolved.depth ? resolved.before(1) : pos;
          top = rect.top - 3;
          break;
        }
        top = rect.bottom + 3;
      }
      const bounds = root.getBoundingClientRect();
      setDropLine({ left: bounds.left, top, width: bounds.width, position });
    };
    const drop = (event: DragEvent) => {
      if (source === null) return;
      target(event);
      const destination = dropLine();
      if (destination) props.editor.commands.moveDocumentBlockTo(source, destination.position);
      finish(); setBlock(null);
    };
    host.addEventListener('mousemove', hover);
    host.addEventListener('mouseleave', leave);
    host.addEventListener('dragover', target, true);
    host.addEventListener('drop', drop, true);
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('resize', refresh);
    window.addEventListener('dragend', finish);
    props.editor.on('transaction', refresh);
    onCleanup(() => {
      clearTimeout(hideTimer);
      host.removeEventListener('mousemove', hover);
      host.removeEventListener('mouseleave', leave);
      host.removeEventListener('dragover', target, true);
      host.removeEventListener('drop', drop, true);
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
      window.removeEventListener('dragend', finish);
      props.editor.off('transaction', refresh);
    });
  });
  const convertible = () => {
    const current = block();
    if (!current) return false;
    const selection = props.editor.state.selection;
    const forbidden = ['database', 'table', 'horizontalRule'];
    if (selection instanceof DocumentBlockSelection && current.position >= selection.from && current.position < selection.to) {
      let supported = true;
      props.editor.state.doc.forEach((node, position) => {
        if (position >= selection.from && position < selection.to && forbidden.includes(node.type.name)) supported = false;
      });
      return supported;
    }
    const node = props.editor.state.doc.nodeAt(current.position);
    return !!node && !forbidden.includes(node.type.name);
  };
  return <>
    <Show when={block() && !props.hidden}>
      <Portal>
        <div class="workspace-block-gutter" onMouseEnter={() => clearTimeout(hideTimer)} onMouseLeave={() => { hideTimer = setTimeout(() => { if (!open() && source === null) setBlock(null); }, 180); }} style={{ left: `${Math.max(2, block()!.rect.left - 49)}px`, top: `${block()!.rect.top}px` }} onMouseDown={(event) => { if (!(event.target as HTMLElement).closest("[draggable]")) event.preventDefault(); }}>
          <button type="button" aria-label="Add block below" title="Add block below" class="workspace-block-button" onClick={() => run(() => { props.editor.chain().insertDocumentBlock('after').insertContent('/').focus().run(); })}>
            <Icon name="plus-add-small" class="size-4" />
          </button>
          <DropdownMenu open={open()} onOpenChange={(next) => { if (!next || !pointerPending) setOpen(next); }} placement="bottom-start">
            <DropdownMenuTrigger as="button" type="button" aria-label="Block actions" title="Drag to move · Click for actions" class="workspace-block-button" onPointerDown={() => { pointerPending = true; }}
              onPointerUp={() => { pointerPending = false; }}
              onClick={(event: MouseEvent) => {
                pointerPending = false;
                const current = block();
                if (current && event.shiftKey) props.editor.commands.selectDocumentBlock(current.position, true);
                else select();
                if (event.shiftKey) { setOpen(false); props.editor.commands.focus(); }
                else setOpen((value) => !value);
              }} draggable={true}
              onDragStart={(event: DragEvent) => {
                source = block()?.position ?? null;
                select(); setOpen(false);
                if (event.dataTransfer && source !== null) {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('application/x-compound-block', String(source));
                  event.dataTransfer.setDragImage(block()!.element, 0, 0);
                }
              }}>
              <span aria-hidden="true" class="workspace-block-grip">⠿</span>
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
              <DropdownMenuContent class="w-56 max-h-[70vh] overflow-y-auto">
                <DropdownMenuItem onSelect={() => run(() => { props.editor.chain().focus().duplicateDocumentBlock().run(); })}>Duplicate <span class="ml-auto text-muted-foreground">⌘D</span></DropdownMenuItem>
                <DropdownMenuItem onSelect={() => run(() => { props.editor.chain().focus().moveDocumentBlockUp().run(); })}>Move up</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => run(() => { props.editor.chain().focus().moveDocumentBlockDown().run(); })}>Move down</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => run(() => { props.editor.chain().focus().insertDocumentBlock('before').run(); })}>Insert above</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => run(() => { props.editor.chain().focus().insertDocumentBlock('after').run(); })}>Insert below</DropdownMenuItem>
                <Show when={convertible()}>
                  <div class="workspace-slash-group border-t border-border mt-1">Turn into</div>
                  <For each={blockItems().filter((item) => !['table', 'divider'].includes(item.id))}>
                    {(item) => <DropdownMenuItem onSelect={() => run(() => {
                      const position = props.editor.state.selection.from;
                      props.editor.commands.clearDocumentBlocks();
                      item.run(props.editor, { from: position, to: position });
                    })}>{item.title}</DropdownMenuItem>}
                  </For>
                </Show>
                <DropdownMenuItem class="text-destructive" onSelect={() => run(() => { props.editor.chain().focus().deleteDocumentBlock().run(); })}>Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenu>
        </div>
      </Portal>
    </Show>
    <Show when={dropLine()}>{(line) => <Portal><div class="workspace-block-drop" style={{ left: `${line().left}px`, top: `${line().top}px`, width: `${line().width}px` }} /></Portal>}</Show>
  </>;
}
