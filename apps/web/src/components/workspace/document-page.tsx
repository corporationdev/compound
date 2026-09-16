/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A markdown document: where it sits, its title (the file name), its
// properties, and its body in the WYSIWYG editor. Edits land on disk after
// a short pause; a change to the file from outside — a teammate through
// sync, an agent through its own tools — comes back through the watcher
// and replaces what is shown. When both happen at once, the save is merged
// three ways against the text this page last agreed on, the way sync
// merges between machines, and the merged text is what is shown.

import { useNavigate } from "@solidjs/router";
import { Match, Show, Switch, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { toast } from "somoto";

import { Icon } from "@/components/ui/icon";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import {
  baseName,
  createWorkspaceEntry,
  extensionOf,
  onWorkspaceChange,
  parentPath,
  readWorkspaceFile,
  renameWorkspaceEntry,
  stemOf,
  workspaceEntries,
  workspaceRoute,
  writeWorkspaceFile,
} from "@/lib/workspace";
import { buildTree } from "./tree-model";

import { BubbleMenu } from "./bubble-menu";
import { DATABASE_NODE, DatabaseBlock } from "./database-block";
import { loadSchema } from "./database-grid";
import { createDocumentEditor, replaceContent } from "./document-editor";
import { SlashMenu, blockItems, createSlashExtension, type SlashItem, type SlashState } from "./slash-menu";
import { joinDocument, splitDocument, TABLE_SCHEMA_FILE, type Properties } from "./markdown";
import { PropertiesPanel } from "./properties";
import { WorkspaceBreadcrumbs } from "./breadcrumbs";

import type { Editor } from "@tiptap/core";

/** How long after the last edit the file is written. */
const SAVE_DELAY_MS = 400;

export { loadSchema };

export function DocumentPage(props: { path: string }) {
  const navigate = useNavigate();
  const [state, setState] = createSignal<"loading" | "ready" | "missing" | "binary">("loading");
  const [properties, setProperties] = createSignal<Properties | null>(null);
  const [slash, setSlash] = createSignal<SlashState | null>(null);
  const [editorReady, setEditorReady] = createSignal<Editor | null>(null);
  const slashKeys: { current: ((event: KeyboardEvent) => boolean) | null } = { current: null };
  const [schema] = createResource(() => parentPath(props.path), loadSchema);

  let host: HTMLDivElement | undefined;
  let editor: Editor | undefined;
  let lastWritten = "";
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> = Promise.resolve();

  const serialize = (): string => joinDocument(properties(), editor?.getMarkdown() ?? "");

  const save = (): Promise<void> => {
    saving = saving.then(async () => {
      if (!editor) return;
      const text = serialize();
      dirty = false;
      if (text === lastWritten) return;
      const base = lastWritten;
      lastWritten = text;
      try {
        const result = await writeWorkspaceFile(props.path, text, base);
        if (result.status === "merged") {
          // Someone else's edit landed while this one was typed: what is on
          // disk now is the merge, and it is what the page shows.
          lastWritten = result.text;
          const { properties: found, body } = splitDocument(result.text);
          setProperties(found);
          replaceContent(editor, body);
          if (result.conflicted) {
            toast.warning("Merged an outside edit to this page", { description: "Where both changed the same lines, yours were kept." });
          }
        }
      } catch (error) {
        dirty = true;
        lastWritten = base;
        toast.error("Could not save the document", { description: (error as Error).message });
      }
    });
    return saving;
  };

  const scheduleSave = () => {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), SAVE_DELAY_MS);
  };

  const load = async () => {
    let file;
    try {
      file = await readWorkspaceFile(props.path);
    } catch {
      file = null;
    }
    if (!host) return;
    if (!file) return setState("missing");
    if (file.kind === "binary") return setState("binary");
    const { properties: found, body } = splitDocument(file.text);
    lastWritten = file.text;
    setProperties(found);
    editor = createDocumentEditor(host, {
      content: body,
      onChange: scheduleSave,
      onLinkClick: followLink,
      extensions: [DatabaseBlock, createSlashExtension({ items: slashItems, onChange: setSlash, keys: slashKeys })],
    });
    setEditorReady(editor);
    setState("ready");
  };

  /** A link in the body: the web opens outside, a path opens in the workspace. */
  const followLink = (href: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      void mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url: href }).catch(() => window.open(href, "_blank"));
      return;
    }
    const parent = parentPath(props.path);
    const target = href.startsWith("/") ? href.slice(1) : parent ? `${parent}/${href}` : href;
    navigate(workspaceRoute(decodeURI(target).replace(/\/+$/, "")));
  };

  /** The slash menu: the block items, plus making a page or a database beside this one. */
  const slashItems = (): SlashItem[] => [
    ...blockItems(),
    {
      id: "page",
      title: "New page",
      description: "A page next to this one, linked here",
      icon: "page",
      keywords: ["document", "note", "subpage"],
      run: async (current) => {
        const parent = parentPath(props.path);
        const created = await createWorkspaceEntry(parent ? `${parent}/Untitled.md` : "Untitled.md", "file");
        const name = baseName(created);
        current.chain().focus().insertContent({ type: "text", text: stemOf(name), marks: [{ type: "link", attrs: { href: encodeURI(name) } }] }).run();
        await save();
        navigate(workspaceRoute(created));
      },
    },
    {
      id: "database",
      title: "New database",
      description: "A table in this page; its rows are pages",
      icon: "page-table",
      keywords: ["table", "db", "collection", "inline"],
      run: async (current) => {
        const parent = parentPath(props.path);
        const folder = await createWorkspaceEntry(parent ? `${parent}/Untitled database` : "Untitled database", "directory");
        const name = baseName(folder);
        await writeWorkspaceFile(`${folder}/${TABLE_SCHEMA_FILE}`, `name: ${name}\nproperties:\n  status:\n    type: select\n    options: [Idea, In progress, Done]\n  tags: multiselect\n`);
        current.chain().focus().insertContent([{ type: DATABASE_NODE, attrs: { path: folder } }, { type: "paragraph" }]).run();
      },
    },
    // Every database already in the workspace, to embed here.
    ...databaseFolders().map((folder): SlashItem => ({
      id: `embed:${folder.path}`,
      title: `Database: ${folder.name}`,
      description: `Show ${folder.path} in this page`,
      icon: "page-table",
      keywords: ["embed", "linked", "database", folder.name.toLowerCase()],
      run: (current) => current.chain().focus().insertContent([{ type: DATABASE_NODE, attrs: { path: folder.path } }, { type: "paragraph" }]).run(),
    })),
  ];

  /** Every table folder in the workspace, by path. */
  const databaseFolders = (): Array<{ path: string; name: string }> => {
    const found: Array<{ path: string; name: string }> = [];
    const walk = (nodes: ReturnType<typeof buildTree>): void => {
      for (const node of nodes) {
        if (node.kind !== "directory") continue;
        if (node.table) found.push({ path: node.path, name: node.name });
        walk(node.children);
      }
    };
    walk(buildTree(workspaceEntries() ?? []));
    return found;
  };

  onMount(() => void load());

  onCleanup(() => {
    clearTimeout(saveTimer);
    // A page that went away (deleted here or elsewhere) is not written back into being.
    const stillThere = (workspaceEntries() ?? []).some((entry) => entry.path === props.path);
    if (dirty && stillThere) void save();
    saving.finally(() => editor?.destroy());
  });

  // The file changed on disk. Not by us: our writes come back with the text
  // we sent, which matches `lastWritten`. While an edit here is still
  // waiting to be written, nothing is done now: the save that follows
  // merges against the text on disk and shows the result.
  onCleanup(onWorkspaceChange(async (changed) => {
    if (changed !== props.path || !editor) return;
    await saving;
    const file = await readWorkspaceFile(props.path).catch(() => null);
    if (!file || file.kind !== "text" || file.text === lastWritten || dirty) return;
    lastWritten = file.text;
    const { properties: found, body } = splitDocument(file.text);
    setProperties(found);
    replaceContent(editor, body);
  }));

  const changeProperties = (next: Properties | null) => {
    setProperties(next);
    scheduleSave();
  };

  const title = () => stemOf(baseName(props.path));

  const commitTitle = async (value: string) => {
    const next = value.trim();
    if (!next || next === title() || next.includes("/")) return;
    const extension = extensionOf(baseName(props.path));
    const parent = parentPath(props.path);
    const name = extension ? `${next}.${extension}` : next;
    const target = parent ? `${parent}/${name}` : name;
    await save();
    try {
      await renameWorkspaceEntry(props.path, target);
      navigate(workspaceRoute(target), { replace: true });
    } catch (error) {
      toast.error("Could not rename the document", { description: (error as Error).message });
    }
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" onClick={(event) => {
      // A click on the page's empty space below the text puts the cursor at the end.
      if (event.target === event.currentTarget) editor?.commands.focus("end");
    }}>
      <div class="mx-auto flex w-full max-w-3xl flex-col px-12 pb-40 pt-14">
        <WorkspaceBreadcrumbs path={props.path} />
        <input
          type="text"
          value={title()}
          aria-label="Title"
          placeholder="Untitled"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
              editor?.commands.focus("start");
            }
            if (event.key === "Escape") {
              event.currentTarget.value = title();
              event.currentTarget.blur();
            }
          }}
          onBlur={(event) => void commitTitle(event.currentTarget.value)}
          class="mt-3 w-full bg-transparent text-6xl font-450 leading-tight text-foreground outline-none placeholder:text-muted-foreground/40 select-text"
        />
        <Show when={state() === "ready"}>
          <div class="mt-4">
            <PropertiesPanel properties={properties()} schema={schema.latest} onChange={changeProperties} />
          </div>
        </Show>
        <Switch>
          <Match when={state() === "missing"}>
            <p class="mt-6 text-xs text-muted-foreground">This file is no longer here.</p>
          </Match>
          <Match when={state() === "binary"}>
            <p class="mt-6 text-xs text-muted-foreground">This file is not text, so it cannot be edited here.</p>
          </Match>
        </Switch>
        <div
          ref={host}
          class="mt-6 min-h-40"
          classList={{ hidden: state() !== "ready" && state() !== "loading" }}
        />
        <Show when={editorReady()}>
          {(ready) => <BubbleMenu editor={ready()} hidden={slash() !== null} />}
        </Show>
        <SlashMenu state={slash()} keys={slashKeys} />
        <Show when={state() === "ready"}>
          <p class="mt-8 text-xxs text-muted-foreground/50">Type / for blocks, select text to format.</p>
        </Show>
        <Show when={state() === "loading"}>
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon name="spinner-loader" class="size-4 animate-spin" />
          </div>
        </Show>
      </div>
    </div>
  );
}
