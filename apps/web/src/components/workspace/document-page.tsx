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
import { buildTree, withoutProjects } from "./tree-model";
import { workspaceLinkPages } from "./page-link-items";

import { BlockMenu } from "./block-menu";
import { TableMenu } from "./table-menu";
import { BubbleMenu } from "./bubble-menu";
import { DATABASE_NODE, DatabaseBlock } from "./database-block";
import { loadSchema } from "./database-grid";
import { createDocumentEditor, replaceContent } from "./document-editor";
import { createDocumentPersistence } from "./document-persistence";
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
  let disposed = false;
  let persistence: ReturnType<typeof createDocumentPersistence> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const serialize = (): string => joinDocument(properties(), editor?.getMarkdown() ?? "");
  const applyDocument = (text: string) => {
    if (!editor) return;
    const { properties: found, body } = splitDocument(text);
    setProperties(found);
    replaceContent(editor, body);
  };
  const save = (): Promise<boolean> => persistence?.save() ?? Promise.resolve(true);

  const scheduleSave = () => {
    persistence?.markDirty();
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
    if (!host || disposed) return;
    if (!file) return setState("missing");
    if (file.kind === "binary") return setState("binary");
    const { properties: found, body } = splitDocument(file.text);
    persistence = createDocumentPersistence(file.text, {
      read: serialize,
      apply: applyDocument,
      write: (text, base) => writeWorkspaceFile(props.path, text, base),
      onError: (error) => toast.error("Could not save the document", { description: (error as Error).message }),
      onConflict: () => toast.warning("Merged an outside edit to this page", { description: "Where both changed the same lines, yours were kept." }),
    });
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
    try {
      const parts: string[] = [];
      for (const part of decodeURIComponent(target).split("/")) {
        if (part === "..") parts.pop();
        else if (part && part !== ".") parts.push(part);
      }
      navigate(workspaceRoute(parts.join("/")));
    } catch {
      toast.error("Could not open this page link");
    }
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
        current.chain().focus().insertContent({ type: "text", text: stemOf(name), marks: [{ type: "link", attrs: { href: encodeURIComponent(name) } }] }).run();
        if (await save()) navigate(workspaceRoute(created));
      },
    },
    {
      id: "link-to-page",
      title: "Link to page",
      description: "Link to an existing page in your workspace",
      icon: "page",
      keywords: ["link", "page", "mention", "existing"],
      picker: {
        title: "Select a page",
        placeholder: "Search for a page…",
        noun: "pages",
        items: () => workspaceLinkPages(workspaceEntries() ?? [], props.path).map((page): SlashItem => ({
          id: `link:${page.path}`,
          title: stemOf(page.name),
          description: parentPath(page.path) || "Workspace",
          icon: "page",
          keywords: [page.path.toLowerCase()],
          run: (current) => current.chain().focus().insertContent({ type: "text", text: stemOf(page.name), marks: [{ type: "link", attrs: { href: `/${page.path.split("/").map(encodeURIComponent).join("/")}` } }] }).run(),
        })),
      },
      run: () => {},
    },
    {
      id: "database",
      group: "Databases",
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
    {
      id: "linked-database",
      title: "Linked database",
      description: "Show an existing database on this page",
      icon: "page-table",
      group: "Databases",
      keywords: ["embed", "linked", "database", "existing"],
      picker: {
        title: "Select a database",
        placeholder: "Search databases…",
        noun: "databases",
        items: () => databaseFolders().map((folder): SlashItem => ({
          id: `embed:${folder.path}`,
          title: folder.name,
          description: folder.path,
          icon: "page-table",
          keywords: [folder.path.toLowerCase()],
          run: (current) => current.chain().focus().insertContent([{ type: DATABASE_NODE, attrs: { path: folder.path } }, { type: "paragraph" }]).run(),
        })),
      },
      run: () => {},
    },
    { id: "duplicate", title: "Duplicate block", description: "Make a copy of this block", icon: "page", group: "Actions", keywords: ["copy"], run: (current) => current.chain().focus().duplicateDocumentBlock().run() },
    { id: "delete", title: "Delete block", description: "Remove this block", icon: "trash", group: "Actions", keywords: ["remove"], run: (current) => current.chain().focus().deleteDocumentBlock().run() },
  ];

  /** Every table folder in the workspace, by path. */
  const databaseFolders = (): Array<{ path: string; name: string }> => {
    const found: Array<{ path: string; name: string }> = [];
    const walk = (nodes: ReturnType<typeof buildTree>): void => {
      for (const node of nodes) {
        if (node.kind !== "directory" || node.name.startsWith(".") || node.name.startsWith("_")) continue;
        if (node.table) found.push({ path: node.path, name: node.name });
        walk(node.children);
      }
    };
    walk(withoutProjects(buildTree(workspaceEntries() ?? [])));
    return found;
  };

  onMount(() => void load());

  onCleanup(() => {
    disposed = true;
    clearTimeout(saveTimer);
    persistence?.stopWatching();
    // A page that went away (deleted here or elsewhere) is not written back into being.
    const stillThere = (workspaceEntries() ?? []).some((entry) => entry.path === props.path);
    if (!stillThere) persistence?.cancelFutureWrites();
    const flushed = persistence?.dirty && stillThere ? save() : persistence?.pending;
    void (flushed ?? Promise.resolve()).finally(() => editor?.destroy());
  });

  // A pending local draft is merged by the next save. Clean pages accept
  // outside changes only if no newer edit/write happened during the read.
  onCleanup(onWorkspaceChange(async (changed) => {
    if (changed !== props.path || !editor || disposed) return;
    await persistence?.refresh(async () => {
      const file = await readWorkspaceFile(props.path).catch(() => null);
      return file?.kind === "text" ? file.text : null;
    });
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
    if (!(await save())) return;
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
      <div class="mx-auto flex w-full max-w-3xl flex-col px-8 pb-40 pt-14 sm:px-12" onClick={(event) => { if (event.target === event.currentTarget) editor?.commands.focus("end"); }}>
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
          class="workspace-document-host relative mt-6 min-h-40"
          classList={{ hidden: state() !== "ready" && state() !== "loading" }}
        />
        <Show when={editorReady()}>
          {(ready) => <>
            <BubbleMenu editor={ready()} hidden={slash() !== null} />
            <BlockMenu editor={ready()} hidden={slash() !== null} />
            <TableMenu editor={ready()} hidden={slash() !== null} />
          </>}
        </Show>
        <SlashMenu state={slash()} keys={slashKeys} />
        <Show when={state() === "loading"}>
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon name="spinner-loader" class="size-4 animate-spin" />
          </div>
        </Show>
      </div>
    </div>
  );
}
