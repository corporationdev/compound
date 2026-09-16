/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Any text file that is not a document: source, config, captions. A plain
// monospace editor with the same save-after-a-pause and follow-the-disk
// behaviour as the document page, and nothing else.

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import { revealPath } from "@/lib/shell";
import { absolutePath, baseName, onWorkspaceChange, readWorkspaceFile, writeWorkspaceFile } from "@/lib/workspace";

import { WorkspaceBreadcrumbs } from "./breadcrumbs";

const SAVE_DELAY_MS = 400;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function TextFilePage(props: { path: string }) {
  const [state, setState] = createSignal<"loading" | "ready" | "missing" | "binary">("loading");
  const [size, setSize] = createSignal(0);
  const [text, setText] = createSignal("");

  let lastWritten = "";
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> = Promise.resolve();

  const save = (): Promise<void> => {
    saving = saving.then(async () => {
      const current = text();
      dirty = false;
      if (current === lastWritten) return;
      const base = lastWritten;
      lastWritten = current;
      try {
        const result = await writeWorkspaceFile(props.path, current, base);
        if (result.status === "merged") {
          lastWritten = result.text;
          if (!dirty) setText(result.text);
          if (result.conflicted) toast.warning("Merged an outside edit to this file", { description: "Where both changed the same lines, yours were kept." });
        }
      } catch (error) {
        dirty = true;
        lastWritten = base;
        toast.error("Could not save the file", { description: (error as Error).message });
      }
    });
    return saving;
  };

  const edit = (value: string) => {
    setText(value);
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), SAVE_DELAY_MS);
  };

  onMount(async () => {
    const file = await readWorkspaceFile(props.path).catch(() => null);
    if (!file) return setState("missing");
    if (file.kind === "binary") {
      setSize(file.size);
      return setState("binary");
    }
    lastWritten = file.text;
    setText(file.text);
    setState("ready");
  });

  onCleanup(() => {
    clearTimeout(saveTimer);
    if (dirty) void save();
  });

  onCleanup(onWorkspaceChange(async (changed) => {
    if (changed !== props.path) return;
    await saving;
    const file = await readWorkspaceFile(props.path).catch(() => null);
    if (!file || file.kind !== "text" || file.text === lastWritten || dirty) return;
    lastWritten = file.text;
    setText(file.text);
  }));

  const reveal = async () => {
    const absolute = absolutePath(props.path);
    if (absolute) await revealPath(absolute).catch(() => { });
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 flex-col gap-1 px-6 pt-6 pb-3">
        <WorkspaceBreadcrumbs path={props.path} />
        <div class="flex items-center gap-3">
          <h1 class="min-w-0 flex-1 truncate font-mono text-lg text-foreground">{baseName(props.path)}</h1>
          <Show when={state() === "binary"}>
            <span class="text-xs text-muted-foreground">{formatSize(size())}</span>
          </Show>
          <Button variant="secondary" onClick={reveal}>Reveal in Finder</Button>
        </div>
      </div>
      <Show when={state() === "ready"}>
        <textarea
          value={text()}
          onInput={(event) => edit(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Tab") {
              event.preventDefault();
              const target = event.currentTarget;
              const { selectionStart, selectionEnd } = target;
              target.setRangeText("  ", selectionStart, selectionEnd, "end");
              edit(target.value);
            }
          }}
          spellcheck={false}
          aria-label={baseName(props.path)}
          class="min-h-0 flex-1 resize-none bg-transparent px-6 pb-10 font-mono text-xs leading-5 text-foreground outline-none select-text"
        />
      </Show>
      <Show when={state() === "binary"}>
        <p class="px-6 text-xs text-muted-foreground">This file is not text. Open it from Finder, or drop it into a project to use it there.</p>
      </Show>
      <Show when={state() === "missing"}>
        <p class="px-6 text-xs text-muted-foreground">This file is no longer here.</p>
      </Show>
    </div>
  );
}
