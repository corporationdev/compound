/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The grid of a database: a folder with a `_table.yaml`, whose markdown
// files are its rows and whose frontmatter fields are its columns. TanStack
// Table underneath; a cell edits the row's file through the same
// split-and-join the document page uses, and the name cell opens the row.
// Used by the table page and by the inline database block inside a page.

import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js";
import { toast } from "somoto";
import { parseDocument } from "yaml";
import {
  createSortedRowModel,
  createTable,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  type ColumnDef,
  type SortingState,
} from "@tanstack/solid-table";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from "@/components/ui/popover";
import { cx } from "@/lib/cva";
import {
  baseName,
  createWorkspaceEntry,
  extensionOf,
  readWorkspaceFile,
  renameWorkspaceEntry,
  removeWorkspaceEntry,
  parentPath,
  stemOf,
  workspaceEntries,
  writeWorkspaceFile,
} from "@/lib/workspace";

import { PROPERTY_TYPE_LABELS, TABLE_SCHEMA_FILE, joinDocument, parseTableSchema, propertyToText, splitDocument, type Properties, type PropertySchema, type PropertyType, type TableSchema } from "./markdown";
import { PropertyValue, propertyNames, schemaFor } from "./properties";
import { compareDatabaseRows, compareDatabaseValues, createFileQueue, selectDatabaseRows } from "./database-model";

const queueFile = createFileQueue();
const TITLE_COLUMN = "__row_title__";
const PROPERTY_ICONS: Record<PropertyType, string> = { text: "prop-text", number: "prop-number", checkbox: "prop-checkbox", date: "prop-date", list: "prop-multiselect", select: "prop-select" };

export type DatabaseRow = {
  path: string;
  name: string;
  properties: Properties;
};

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
});

/** The table schema of `folder`, if it is a table. */
export async function loadSchema(folder: string): Promise<TableSchema | null> {
  const file = await readWorkspaceFile(folder ? `${folder}/${TABLE_SCHEMA_FILE}` : TABLE_SCHEMA_FILE).catch(() => null);
  return file?.kind === "text" ? parseTableSchema(file.text) : null;
}

/** Reads every row file of the table. */
async function loadRows(paths: string[]): Promise<DatabaseRow[]> {
  const loaded = await Promise.all(paths.map((path) => queueFile(path, async () => {
    const file = await readWorkspaceFile(path).catch(() => null);
    if (!file || file.kind !== "text") return null;
    const properties = splitDocument(file.text).properties ?? {};
    return { path, name: stemOf(baseName(path)), properties };
  })));
  return loaded.filter((row): row is DatabaseRow => row !== null);
}

/** Replaces one property of the row's file on disk, leaving its body alone. */
async function writeCell(path: string, name: string, value: unknown): Promise<void> {
  await queueFile(path, async () => {
    const file = await readWorkspaceFile(path);
    if (!file || file.kind !== "text") throw new Error("The row's file is not here any more");
    const { properties, body } = splitDocument(file.text);
    await writeWorkspaceFile(path, joinDocument({ ...(properties ?? {}), [name]: value }, body), file.text);
  });
}

/** The rows, schema and columns of the database at `path`, kept in step with the listing. */
export function createDatabase(path: () => string) {
  const rowFiles = createMemo(() => {
    const prefix = path() ? `${path()}/` : "";
    return (workspaceEntries() ?? [])
      .filter((entry) => entry.kind === "file" && entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes("/"))
      .filter((entry) => extensionOf(entry.name) === "md");
  });
  // Rows and schema follow their files: re-read when one of them changes
  // (by its modification time), not on every change elsewhere in the workspace.
  const schemaKey = createMemo(() => {
    const entry = (workspaceEntries() ?? []).find((candidate) => candidate.path === (path() ? `${path()}/${TABLE_SCHEMA_FILE}` : TABLE_SCHEMA_FILE));
    return `${path()}\0${entry?.mtime ?? 0}`;
  });
  const rowsKey = createMemo(() => rowFiles().map((entry) => `${entry.path}\0${entry.mtime}`).join("\n"));
  const [schema, { refetch: refetchSchema }] = createResource(schemaKey, () => loadSchema(path()));
  const pendingRows = new Map<string, DatabaseRow>();
  let editRevision = 0;
  const latestEdits = new Map<string, Map<string, { value: unknown; revision: number }>>();
  const [rows, { mutate, refetch }] = createResource(rowsKey, async () => {
    const startedAt = editRevision;
    const loaded = await loadRows(rowFiles().map((entry) => entry.path));
    // New pages appear immediately, even before the directory watcher has listed them.
    for (const [path, row] of pendingRows) {
      if (loaded.some((candidate) => candidate.path === path)) pendingRows.delete(path);
      else loaded.push(row);
    }
    // Reads wait for earlier writes. Edits made after this read began stay optimistic
    // until their queued write is observed, rather than being replaced by stale data.
    return loaded.map((row) => {
      const edits = latestEdits.get(row.path);
      if (!edits) return row;
      const properties = { ...row.properties };
      for (const [name, edit] of edits) if (edit.revision > startedAt) properties[name] = edit.value;
      return { ...row, properties };
    });
  });
  const columnNames = createMemo(() => {
    const names = new Set<string>(Object.keys(schema.latest?.properties ?? {}));
    for (const row of rows.latest ?? []) for (const name of propertyNames(row.properties, schema.latest)) names.add(name);
    return [...names];
  });
  const propertySchema = (name: string, value?: unknown): PropertySchema => {
    const spec = schemaFor(name, value, schema.latest);
    if (spec.type !== "select" && spec.type !== "list") return spec;
    const options = new Set(spec.options ?? []);
    for (const row of rows.latest ?? []) {
      const current = row.properties[name];
      const values = Array.isArray(current) ? current.map(String) : [propertyToText(current)];
      for (const option of values) if (option) options.add(option);
    }
    return { ...spec, options: [...options] };
  };
  const title = () => schema.latest?.name ?? baseName(path());
  const count = () => rows.latest?.length ?? 0;

  const edit = async (row: DatabaseRow, name: string, value: unknown) => {
    const revision = ++editRevision;
    const edits = latestEdits.get(row.path) ?? new Map<string, { value: unknown; revision: number }>();
    edits.set(name, { value, revision });
    latestEdits.set(row.path, edits);
    // Shown at once; the file follows, and the listing's refresh re-reads it.
    mutate((current) => current?.map((candidate) => (candidate.path === row.path ? { ...candidate, properties: { ...candidate.properties, [name]: value } } : candidate)));
    try {
      await writeCell(row.path, name, value);
    } catch (error) {
      if (edits.get(name)?.revision === revision) edits.delete(name);
      await refetch();
      toast.error("Could not update the row", { description: (error as Error).message });
      throw error;
    }
  };

  /** Makes a row with the schema's properties empty; answers its path. */
  const addRow = async (): Promise<string | null> => {
    try {
      const created = await createWorkspaceEntry(`${path() ? `${path()}/` : ""}Untitled.md`, "file");
      const properties: Properties = {};
      for (const [name, spec] of Object.entries(schema.latest?.properties ?? {})) {
        properties[name] = spec.type === "checkbox" ? false : spec.type === "list" ? [] : "";
      }
      await writeWorkspaceFile(created, joinDocument(properties, ""));
      const row = { path: created, name: stemOf(baseName(created)), properties };
      pendingRows.set(created, row);
      mutate((current) => current?.some((candidate) => candidate.path === created) ? current : [...(current ?? []), row]);
      return created;
    } catch (error) {
      toast.error("Could not add a row", { description: (error as Error).message });
      return null;
    }
  };

  const rename = async (row: DatabaseRow, value: string) => {
    const name = value.trim();
    if (!name || name === row.name) return;
    if (/[\\/]/.test(name) || name === "." || name === "..") {
      toast.error("A page name cannot contain slashes");
      return;
    }
    const target = `${parentPath(row.path) ? `${parentPath(row.path)}/` : ""}${name}.md`;
    try {
      await queueFile(row.path, () => renameWorkspaceEntry(row.path, target));
      pendingRows.delete(row.path);
      pendingRows.set(target, { ...row, path: target, name });
      await refetch();
    } catch (error) {
      toast.error("Could not rename the row", { description: (error as Error).message });
    }
  };

  const duplicate = async (row: DatabaseRow) => queueFile(row.path, async () => {
    const file = await readWorkspaceFile(row.path);
    if (!file || file.kind !== "text") throw new Error("This page is no longer available");
    const created = await createWorkspaceEntry(`${parentPath(row.path) ? `${parentPath(row.path)}/` : ""}${row.name} copy.md`, "file");
    await writeWorkspaceFile(created, file.text);
    return created;
  });

  const remove = async (row: DatabaseRow) => {
    await queueFile(row.path, () => removeWorkspaceEntry(row.path));
    pendingRows.delete(row.path);
    mutate((current) => current?.filter((candidate) => candidate.path !== row.path));
  };

  const addProperty = async (name: string, type: PropertyType) => {
    const trimmed = name.trim();
    if (!trimmed || columnNames().includes(trimmed)) throw new Error("Choose a unique property name");
    const schemaPath = path() ? `${path()}/${TABLE_SCHEMA_FILE}` : TABLE_SCHEMA_FILE;
    await queueFile(schemaPath, async () => {
      const file = await readWorkspaceFile(schemaPath);
      const doc = parseDocument(file?.kind === "text" ? file.text : "properties: {}\n");
      if (doc.errors.length) throw new Error("The database schema contains invalid YAML");
      doc.setIn(["properties", trimmed], { type });
      await writeWorkspaceFile(schemaPath, doc.toString(), file?.kind === "text" ? file.text : null);
    });
    await refetchSchema();
  };

  return { schema, rows, columnNames, title, count, edit, addRow, rename, duplicate, remove, addProperty, propertySchema };
}

export type DatabaseGridProps = {
  path: string;
  /** A row's name was clicked, or a new row made. */
  onOpen: (path: string) => void;
  /** Shown above the grid: the row count and the new-row button. Off inside a page, where the block has its own header. */
  header?: boolean;
  /** Inline database title shares the same row as search, filters and New page. */
  onOpenTitle?: () => void;
};

export function DatabaseGrid(props: DatabaseGridProps) {
  const db = createDatabase(() => props.path);
  const [sorting, setSorting] = createSignal<SortingState>([]);
  const [query, setQuery] = createSignal("");
  const [selection, setSelection] = createSignal<Set<string>>(new Set());
  const [anchor, setAnchor] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [newRowPath, setNewRowPath] = createSignal<string | null>(null);
  const [bulkProperty, setBulkProperty] = createSignal("");
  const [bulkValue, setBulkValue] = createSignal<unknown>("");
  const [bulkOpen, setBulkOpen] = createSignal(false);
  const [addPropertyOpen, setAddPropertyOpen] = createSignal(false);
  const [propertyName, setPropertyName] = createSignal("");
  const [propertyType, setPropertyType] = createSignal<PropertyType>("text");
  const [columnWidths, setColumnWidths] = createSignal<Record<string, number>>({});
  const [filterProperty, setFilterProperty] = createSignal("");
  const [filterValue, setFilterValue] = createSignal("");
  const [filterOpen, setFilterOpen] = createSignal(false);
  let grid: HTMLDivElement | undefined;

  const filteredRows = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    const filter = filterValue().trim().toLocaleLowerCase();
    return (db.rows.latest ?? []).filter((row) => {
      const values = [row.name, ...Object.values(row.properties).map(propertyToText)];
      return (!needle || values.some((value) => value.toLocaleLowerCase().includes(needle))) &&
        (!filterProperty() || !filter || propertyToText(row.properties[filterProperty()]).toLocaleLowerCase().includes(filter));
    }).sort(compareDatabaseRows);
  });
  const columns = createMemo<ColumnDef<typeof features, DatabaseRow>[]>(() => [
    { id: TITLE_COLUMN, accessorFn: (row) => row.name, header: "Name" },
    ...db.columnNames().map((name): ColumnDef<typeof features, DatabaseRow> => ({
      id: `property:${name}`,
      accessorFn: (row) => {
        const value = row.properties[name];
        return typeof value === "number" || typeof value === "boolean" ? value : propertyToText(value);
      },
      sortFn: (left, right, id) => compareDatabaseValues(left.getValue(id), right.getValue(id)),
      header: name,
    })),
  ]);
  const table = createTable({
    features,
    get data() { return filteredRows(); },
    get columns() { return columns(); },
    state: { get sorting() { return sorting(); } },
    onSortingChange: (updater) => setSorting((current) => typeof updater === "function" ? updater(current) : updater),
  });
  const visiblePaths = () => table.getRowModel().rows.map((row) => row.original.path);
  const rowsByPath = createMemo(() => new Map((db.rows.latest ?? []).map((row) => [row.path, row])));
  const columnIds = createMemo(() => columns().map((column) => column.id!));
  const selectedRows = createMemo(() => (db.rows.latest ?? []).filter((row) => selection().has(row.path)));
  const allSelected = () => visiblePaths().length > 0 && visiblePaths().every((path) => selection().has(path));
  const someSelected = () => visiblePaths().some((path) => selection().has(path));
  const bulkSchema = () => db.propertySchema(bulkProperty(), selectedRows()[0]?.properties[bulkProperty()]);

  createEffect(() => {
    // A database switch must never carry selection or view settings into another table.
    props.path;
    setSelection(new Set<string>());
    setAnchor(null);
    setQuery("");
    setSorting([]);
    setFilterProperty("");
    setFilterValue("");
  });
  const toggleRow = (path: string, range = false) => {
    setSelection((current) => selectDatabaseRows(current, visiblePaths(), path, anchor(), range));
    if (!range || !anchor()) setAnchor(path);
  };
  const toggleAll = () => {
    const remove = allSelected();
    setSelection((current) => {
      const next = new Set(current);
      for (const path of visiblePaths()) { if (remove) next.delete(path); else next.add(path); }
      return next;
    });
  };
  const runBulk = async (action: (row: DatabaseRow) => Promise<unknown>, message: string) => {
    if (busy()) return;
    setBusy(true);
    const rows = [...selectedRows()];
    const failed = new Set<string>();
    // Sequential operations avoid flooding the file watcher with a large selection.
    for (const row of rows) {
      try { await action(row); } catch { failed.add(row.path); }
    }
    setBusy(false);
    if (failed.size) {
      setSelection(failed);
      toast.error(`${failed.size} row${failed.size === 1 ? "" : "s"} could not be updated`);
    } else {
      setSelection(new Set<string>());
      setBulkOpen(false);
      toast.success(message);
    }
  };
  createEffect(() => {
    const path = newRowPath();
    if (!path || !rowsByPath().has(path)) return;
    queueMicrotask(() => {
      const input = [...(grid?.querySelectorAll<HTMLInputElement>("input[data-row-title]") ?? [])].find((candidate) => candidate.dataset.rowTitle === path);
      if (!input) return;
      input.focus();
      input.select();
      setNewRowPath(null);
    });
  });
  const newRow = async () => {
    if (busy()) return;
    setBusy(true);
    const created = await db.addRow();
    setBusy(false);
    if (created) {
      setQuery("");
      setFilterProperty("");
      setFilterValue("");
      setNewRowPath(created);
    }
  };
  const addProperty = async () => {
    setBusy(true);
    try {
      await db.addProperty(propertyName(), propertyType());
      setAddPropertyOpen(false);
      setPropertyName("");
    } catch (error) {
      toast.error("Could not add property", { description: (error as Error).message });
    } finally { setBusy(false); }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.isContentEditable || target.closest('input:not([type="checkbox"]), textarea, select')) return;
    if (event.key === "Escape") { setSelection(new Set<string>()); setBulkOpen(false); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault(); event.stopPropagation();
      setSelection(new Set(visiblePaths()));
    }
    if (!selectedRows().length || busy()) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
      event.preventDefault(); event.stopPropagation();
      void runBulk(db.duplicate, "Rows duplicated");
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "/") {
      event.preventDefault(); event.stopPropagation(); setBulkOpen(true);
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault(); event.stopPropagation();
      void runBulk(db.remove, "Rows moved to trash");
    }
    if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const checkbox = target.closest<HTMLInputElement>("input[data-row-select]");
      if (!checkbox) return;
      const paths = visiblePaths();
      const next = paths[paths.indexOf(checkbox.dataset.rowSelect!) + (event.key === "ArrowUp" ? -1 : 1)];
      if (!next) return;
      event.preventDefault(); event.stopPropagation();
      setSelection((current) => new Set([...current, next]));
      grid?.querySelectorAll<HTMLInputElement>("input[data-row-select]").forEach((input) => { if (input.dataset.rowSelect === next) input.focus(); });
    }
  };
  const resizeColumn = (event: PointerEvent, id: string, initial: number) => {
    event.preventDefault(); event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    const start = event.clientX;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => setColumnWidths((widths) => ({ ...widths, [id]: Math.max(100, initial + next.clientX - start) }));
    const end = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const inputClass = "h-8 min-w-0 rounded-md border border-border-strong bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring select-text";

  return (
    <div ref={grid} class="flex flex-col gap-2" tabindex="0" aria-label={`${db.title()} database`} onKeyDown={onKeyDown}>
      <div class="flex h-8 min-w-0 items-center gap-2">
      <Show when={selectedRows().length > 0}>
        <div role="toolbar" aria-label="Selected rows" class="flex h-8 shrink-0 items-center gap-0.5 rounded-md border border-border-strong bg-popover px-1 text-xs shadow-sm">
          <span class="mr-1 whitespace-nowrap px-1 font-medium text-foreground" aria-live="polite">{selectedRows().length} selected</span>
          <Popover open={bulkOpen()} onOpenChange={setBulkOpen} placement="bottom-start">
            <PopoverTrigger as="button" type="button" disabled={busy() || !db.columnNames().length} aria-label="Edit property" title="Edit property" class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"><Icon name="prop-select" class="size-4" /></PopoverTrigger>
            <PopoverPortal><PopoverContent class="flex w-64 flex-col gap-3 p-3">
              <span class="text-xs font-medium">Edit {selectedRows().length} selected rows</span>
              <select aria-label="Property to edit" value={bulkProperty()} class={inputClass} onChange={(event) => { setBulkProperty(event.currentTarget.value); setBulkValue(bulkSchema().type === "checkbox" ? false : bulkSchema().type === "list" ? [] : ""); }}>
                <option value="">Choose a property</option>
                <For each={db.columnNames()}>{(name) => <option value={name}>{name}</option>}</For>
              </select>
              <Show when={bulkProperty()}><PropertyValue label={bulkProperty()} value={bulkValue()} schema={bulkSchema()} onChange={setBulkValue} /></Show>
              <Button variant="secondary" disabled={!bulkProperty() || busy()} onClick={() => { const name = bulkProperty(); const value = bulkValue(); void runBulk((row) => db.edit(row, name, value), "Properties updated"); }}>Apply to selected rows</Button>
            </PopoverContent></PopoverPortal>
          </Popover>
          <button type="button" disabled={busy()} onClick={() => void runBulk(db.duplicate, "Rows duplicated")} aria-label="Duplicate selected rows" title="Duplicate" class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"><svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" class="size-4"><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M12 5V3H3v9h2" /></svg></button>
          <button type="button" disabled={busy()} onClick={() => void runBulk(db.remove, "Rows moved to trash")} aria-label="Move selected rows to trash" title="Move to trash" class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"><Icon name="trash" class="size-4" /></button>
          <button type="button" aria-label="Clear row selection" disabled={busy()} onClick={() => setSelection(new Set<string>())} class="grid size-7 place-items-center rounded-md hover:bg-accent"><Icon name="close-remove-small" class="size-4" /></button>
        </div>
      </Show>
        <Show when={selectedRows().length === 0}>
        <Show when={props.onOpenTitle}>
          <Icon name="page-table" class="size-4 shrink-0 text-muted-foreground" />
          <button type="button" onClick={() => props.onOpenTitle?.()} class="min-w-0 truncate text-left text-sm font-medium text-foreground hover:underline">{db.title()}</button>
        </Show>
        <Show when={props.header !== false || props.onOpenTitle}><span class="shrink-0 text-xs text-muted-foreground">{filteredRows().length} row{filteredRows().length === 1 ? "" : "s"}</span></Show>
        </Show>
        <span class="flex-1" />
        <input aria-label="Search database" type="search" placeholder="Search…" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} class={cx(inputClass, "w-36 border-transparent bg-transparent focus:border-border-strong")} />
        <Popover open={filterOpen()} onOpenChange={setFilterOpen} placement="bottom-end">
          <PopoverTrigger as="button" type="button" class={cx("h-7 rounded-md px-2 text-xs hover:bg-accent", filterProperty() && filterValue() ? "text-primary" : "text-muted-foreground")}>Filter</PopoverTrigger>
          <PopoverPortal><PopoverContent class="flex w-64 flex-col gap-2 p-3">
            <label class="text-xs font-medium">Filter rows</label>
            <select aria-label="Filter property" value={filterProperty()} onChange={(event) => setFilterProperty(event.currentTarget.value)} class={inputClass}>
              <option value="">Choose a property</option>
              <For each={db.columnNames()}>{(name) => <option value={name}>{name}</option>}</For>
            </select>
            <input aria-label="Filter contains" placeholder="Contains…" value={filterValue()} onInput={(event) => setFilterValue(event.currentTarget.value)} class={inputClass} />
            <button type="button" class="h-7 rounded-md text-xs text-muted-foreground hover:bg-accent" onClick={() => { setFilterProperty(""); setFilterValue(""); }}>Clear filter</button>
          </PopoverContent></PopoverPortal>
        </Popover>
        <Show when={sorting().length}><button type="button" onClick={() => setSorting([])} class="h-7 rounded-md px-2 text-xs text-primary hover:bg-accent">Clear sort</button></Show>
        <Button variant="secondary" disabled={busy()} onClick={newRow}>New page</Button>
      </div>
      <div class="-ml-7 overflow-x-auto pl-7">
        <table class="w-full border-collapse text-[14px]" aria-label={db.title()}>
          <thead><For each={table.getHeaderGroups()}>{(group) => (
            <tr class="group/database-header">
              <For each={group.headers}>{(header) => {
                const sorted = () => header.column.getIsSorted();
                const width = () => columnWidths()[header.column.id] ?? (header.column.id === TITLE_COLUMN ? 240 : 160);
                return (
                  <th class="relative h-8 border-b border-r border-border-strong px-2 text-left font-450 text-muted-foreground" style={{ width: `${width()}px`, "min-width": `${width()}px`, "max-width": `${width()}px` }} aria-sort={sorted() === "asc" ? "ascending" : sorted() === "desc" ? "descending" : "none"}>
                    <Show when={header.column.id === TITLE_COLUMN && visiblePaths().length > 0}>
                      <span class="absolute -left-7 top-0 flex h-full w-7 items-center justify-center">
                        <input type="checkbox" aria-label="Select all rows" title="Select all rows" checked={allSelected()} ref={(input) => createEffect(() => { input.indeterminate = someSelected() && !allSelected(); })} disabled={busy()} onChange={toggleAll}
                          class={cx("size-3.5 cursor-pointer accent-primary transition-opacity group-hover/database-header:opacity-100 focus-visible:opacity-100", someSelected() ? "opacity-100" : "opacity-0")} />
                      </span>
                    </Show>
                    <button type="button" title="Sort this property · Shift-click to sort by multiple properties" onClick={header.column.getToggleSortingHandler()} class="flex h-full w-full items-center gap-1 text-left hover:text-foreground">
                      <Show when={header.column.id !== TITLE_COLUMN} fallback={<span aria-hidden="true" class="mr-1 text-[14px] font-medium opacity-70">Aa</span>}>
                        <Icon name={PROPERTY_ICONS[db.propertySchema(header.column.id.slice("property:".length)).type]} class="mr-1 size-4 shrink-0 opacity-70" />
                      </Show>
                      <span class="min-w-0 flex-1 truncate">{String(header.column.columnDef.header ?? header.column.id)}</span>
                      <Show when={sorted()}><Icon name={sorted() === "desc" ? "chevron-down" : "arrow-top"} class="size-4 shrink-0" /></Show>
                    </button>
                    <div role="separator" aria-label={`Resize ${String(header.column.columnDef.header)}`} aria-orientation="vertical" class="absolute -right-0.5 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-primary" onPointerDown={(event) => resizeColumn(event, header.column.id, width())} />
                  </th>
                );
              }}</For>
              <th class="w-10 min-w-10 border-b border-border-strong">
                <Popover open={addPropertyOpen()} onOpenChange={setAddPropertyOpen} placement="bottom-end">
                  <PopoverTrigger as="button" type="button" aria-label="Add database property" title="Add a property" class="grid size-8 place-items-center text-muted-foreground hover:text-foreground"><Icon name="plus-add-small" class="size-4" /></PopoverTrigger>
                  <PopoverPortal><PopoverContent class="flex w-64 flex-col gap-2 p-3">
                    <span class="text-xs font-medium">New property</span>
                    <input aria-label="Property name" placeholder="Property name" value={propertyName()} onInput={(event) => setPropertyName(event.currentTarget.value)} class={inputClass} />
                    <select aria-label="Property type" value={propertyType()} onChange={(event) => setPropertyType(event.currentTarget.value as PropertyType)} class={inputClass}><For each={Object.entries(PROPERTY_TYPE_LABELS)}>{([value, label]) => <option value={value}>{label}</option>}</For></select>
                    <Button variant="secondary" disabled={!propertyName().trim() || busy()} onClick={() => void addProperty()}>Add property</Button>
                  </PopoverContent></PopoverPortal>
                </Popover>
              </th>
            </tr>
          )}</For></thead>
          <tbody><For each={visiblePaths()}>{(path) => {
            // Stable file/column keys preserve active inputs and open menus across writes and sorting.
            const row = createMemo<DatabaseRow>((previous) => rowsByPath().get(path) ?? previous!, rowsByPath().get(path)!);
            return (
            <tr aria-selected={selection().has(row().path)}
              onClick={(event) => {
                if (busy() || (event.target as HTMLElement).closest("input,button,select,textarea,a,[role=combobox]")) return;
                toggleRow(row().path, event.shiftKey);
                grid?.focus({ preventScroll: true });
              }}
              class={cx("group border-b border-border-strong", selection().has(row().path) ? "bg-primary/10" : "hover:bg-accent/30")}>
              <For each={columnIds()}>{(columnId) => {
                const name = () => columnId.slice("property:".length);
                return <td class="relative border-r border-border-strong p-0 align-middle" onKeyDown={(event) => {
                  if (event.key !== "Enter" || (event.target as HTMLElement).tagName !== "INPUT") return;
                  const input = event.target as HTMLInputElement;
                  if (input.type === "checkbox") return;
                  event.preventDefault(); input.blur();
                }}>
                  <Show when={columnId === TITLE_COLUMN}>
                    <span class="absolute -left-7 top-0 flex h-full w-7 items-center justify-center" onClick={(event) => event.stopPropagation()}>
                      <input type="checkbox" data-row-select={row().path} aria-label={`Select ${row().name}`} checked={selection().has(row().path)} disabled={busy()} onClick={(event) => toggleRow(row().path, event.shiftKey)}
                        class={cx("size-3.5 cursor-pointer accent-primary transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100", selection().has(row().path) ? "opacity-100" : "opacity-0")} />
                    </span>
                  </Show>
                  <Show when={columnId !== TITLE_COLUMN} fallback={
                    <div class="flex min-h-8 items-center gap-1 px-2">
                      <Icon name="page" class="size-4 shrink-0 text-muted-foreground" />
                      <input data-row-title={row().path} aria-label={`Name of ${row().name}`} type="text" value={row().name} onChange={(event) => {
                        const input = event.currentTarget;
                        void db.rename(row(), input.value).then(() => { if (input.isConnected) input.value = row().name; });
                      }} onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                        if (event.key === "Escape") { event.currentTarget.value = row().name; event.currentTarget.blur(); }
                      }} class="h-7 w-0 min-w-0 flex-1 rounded-sm bg-transparent px-1 text-[14px] text-foreground outline-none focus:bg-input focus:ring-1 focus:ring-ring select-text" />
                      <button type="button" aria-label={`Open ${row().name}`} title="Open page" onClick={() => props.onOpen(row().path)} class="shrink-0 rounded border border-border-strong bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100">OPEN</button>
                    </div>
                  }><div class="flex min-h-8 items-center px-0.5"><PropertyValue label={`${row().name}: ${name()}`} value={row().properties[name()]} schema={db.propertySchema(name(), row().properties[name()])} onChange={(value) => void db.edit(row(), name(), value).catch(() => {})} compact /></div></Show>
                </td>;
              }}</For>
              <td />
            </tr>
          ); }}</For>
          <Show when={!filteredRows().length && !db.rows.loading}><tr><td colSpan={columns().length + 1} class="h-14 px-3 text-muted-foreground">{db.count() ? "No rows match your search or filter." : "No pages yet."}</td></tr></Show>
          </tbody>
        </table>
        <button type="button" disabled={busy()} onClick={newRow} class="flex h-8 w-full items-center gap-1 px-2 text-left text-[14px] text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-40"><Icon name="plus-add-small" class="size-4" />New page</button>
      </div>
    </div>
  );
}
