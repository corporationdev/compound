/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The grid of a database: a folder with a `_table.yaml`, whose markdown
// files are its rows and whose frontmatter fields are its columns. TanStack
// Table underneath; a cell edits the row's file through the same
// split-and-join the document page uses, and the name cell opens the row.
// Used by the table page and by the inline database block inside a page.

import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { toast } from "somoto";
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
import { cx } from "@/lib/cva";
import {
  baseName,
  createWorkspaceEntry,
  extensionOf,
  readWorkspaceFile,
  stemOf,
  workspaceEntries,
  writeWorkspaceFile,
} from "@/lib/workspace";

import { TABLE_SCHEMA_FILE, joinDocument, parseTableSchema, propertyToText, splitDocument, type Properties, type TableSchema } from "./markdown";
import { PropertyValue, propertyNames, schemaFor } from "./properties";

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
  return Promise.all(paths.map(async (path) => {
    const file = await readWorkspaceFile(path).catch(() => null);
    const properties = file?.kind === "text" ? splitDocument(file.text).properties ?? {} : {};
    return { path, name: stemOf(baseName(path)), properties };
  }));
}

/** Replaces one property of the row's file on disk, leaving its body alone. */
async function writeCell(path: string, name: string, value: unknown): Promise<void> {
  const file = await readWorkspaceFile(path);
  if (!file || file.kind !== "text") throw new Error("The row's file is not here any more");
  const { properties, body } = splitDocument(file.text);
  await writeWorkspaceFile(path, joinDocument({ ...(properties ?? {}), [name]: value }, body));
}

/** The rows, schema and columns of the database at `path`, kept in step with the listing. */
export function createDatabase(path: () => string) {
  const rowFiles = createMemo(() => {
    const prefix = `${path()}/`;
    return (workspaceEntries() ?? [])
      .filter((entry) => entry.kind === "file" && entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes("/"))
      .filter((entry) => extensionOf(entry.name) === "md");
  });
  // Rows and schema follow their files: re-read when one of them changes
  // (by its modification time), not on every change elsewhere in the workspace.
  const schemaKey = createMemo(() => {
    const entry = (workspaceEntries() ?? []).find((candidate) => candidate.path === `${path()}/${TABLE_SCHEMA_FILE}`);
    return `${path()}\0${entry?.mtime ?? 0}`;
  });
  const rowsKey = createMemo(() => rowFiles().map((entry) => `${entry.path}\0${entry.mtime}`).join("\n"));
  const [schema] = createResource(schemaKey, () => loadSchema(path()));
  const [rows, { mutate }] = createResource(rowsKey, () => loadRows(rowFiles().map((entry) => entry.path)));
  const columnNames = createMemo(() => {
    const names = new Set<string>(Object.keys(schema.latest?.properties ?? {}));
    for (const row of rows.latest ?? []) for (const name of propertyNames(row.properties, schema.latest)) names.add(name);
    return [...names];
  });
  const title = () => schema.latest?.name ?? baseName(path());
  const count = () => rows.latest?.length ?? 0;

  const edit = async (row: DatabaseRow, name: string, value: unknown) => {
    // Shown at once; the file follows, and the listing's refresh re-reads it.
    mutate((current) => current?.map((candidate) => (candidate.path === row.path ? { ...candidate, properties: { ...candidate.properties, [name]: value } } : candidate)));
    try {
      await writeCell(row.path, name, value);
    } catch (error) {
      toast.error("Could not update the row", { description: (error as Error).message });
    }
  };

  /** Makes a row with the schema's properties empty; answers its path. */
  const addRow = async (): Promise<string | null> => {
    try {
      const created = await createWorkspaceEntry(`${path()}/Untitled.md`, "file");
      const properties: Properties = {};
      for (const [name, spec] of Object.entries(schema.latest?.properties ?? {})) {
        properties[name] = spec.type === "checkbox" ? false : spec.type === "list" ? [] : "";
      }
      await writeWorkspaceFile(created, joinDocument(properties, ""));
      return created;
    } catch (error) {
      toast.error("Could not add a row", { description: (error as Error).message });
      return null;
    }
  };

  return { schema, rows, columnNames, title, count, edit, addRow };
}

export type DatabaseGridProps = {
  path: string;
  /** A row's name was clicked, or a new row made. */
  onOpen: (path: string) => void;
  /** Shown above the grid: the row count and the new-row button. Off inside a page, where the block has its own header. */
  header?: boolean;
};

export function DatabaseGrid(props: DatabaseGridProps) {
  const db = createDatabase(() => props.path);
  const [sorting, setSorting] = createSignal<SortingState>([]);

  const columns = createMemo<ColumnDef<typeof features, DatabaseRow>[]>(() => [
    { id: "name", accessorFn: (row) => row.name, header: "Name" },
    ...db.columnNames().map((name): ColumnDef<typeof features, DatabaseRow> => ({
      id: name,
      accessorFn: (row) => propertyToText(row.properties[name]),
      header: name,
    })),
  ]);

  const table = createTable({
    features,
    get data() {
      return db.rows.latest ?? [];
    },
    get columns() {
      return columns();
    },
    state: {
      get sorting() {
        return sorting();
      },
    },
    onSortingChange: (updater) => setSorting((current) => (typeof updater === "function" ? updater(current) : updater)),
  });

  const newRow = async () => {
    const created = await db.addRow();
    if (created) props.onOpen(created);
  };

  return (
    <div class="flex flex-col gap-2">
      <Show when={props.header !== false}>
        <div class="flex items-center gap-3">
          <span class="text-xs text-muted-foreground">{db.count()} row{db.count() === 1 ? "" : "s"}</span>
          <span class="flex-1" />
          <Button variant="secondary" onClick={newRow}>New row</Button>
        </div>
      </Show>
      <div class="overflow-x-auto rounded-lg border border-border-strong">
        <table class="w-full border-collapse text-xs">
          <thead>
            <For each={table.getHeaderGroups()}>
              {(group) => (
                <tr>
                  <For each={group.headers}>
                    {(header) => {
                      const sorted = () => header.column.getIsSorted();
                      return (
                        <th
                          class={cx(
                            "h-8 border-b border-r border-border-strong bg-accent/60 px-2 text-left font-450 text-muted-foreground last:border-r-0",
                            header.column.id === "name" ? "w-56 min-w-44" : "min-w-32",
                          )}
                        >
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            class="flex h-full w-full items-center gap-1 text-left hover:text-foreground"
                          >
                            <span class="min-w-0 flex-1 truncate">{String(header.column.columnDef.header ?? header.column.id)}</span>
                            <Show when={sorted()}>
                              <Icon name={sorted() === "desc" ? "chevron-down" : "arrow-top"} class="size-4 shrink-0" />
                            </Show>
                          </button>
                        </th>
                      );
                    }}
                  </For>
                </tr>
              )}
            </For>
          </thead>
          <tbody>
            <For each={table.getRowModel().rows}>
              {(row) => (
                <tr class="group border-b border-border-strong last:border-b-0 hover:bg-accent/40">
                  <For each={row.getAllCells()}>
                    {(cell) => (
                      <td class="border-r border-border-strong p-0 align-middle last:border-r-0">
                        <Show
                          when={cell.column.id !== "name"}
                          fallback={
                            <button
                              type="button"
                              onClick={() => props.onOpen(row.original.path)}
                              class="flex h-8 w-full items-center gap-2 px-2 text-left text-foreground hover:underline"
                            >
                              <Icon name="page" class="size-5 shrink-0 text-muted-foreground" />
                              <span class="min-w-0 flex-1 truncate">{row.original.name || "Untitled"}</span>
                            </button>
                          }
                        >
                          <div class="flex min-h-8 items-center px-0.5">
                            <PropertyValue
                              value={row.original.properties[cell.column.id]}
                              schema={schemaFor(cell.column.id, row.original.properties[cell.column.id], db.schema.latest)}
                              onChange={(value) => void db.edit(row.original, cell.column.id, value)}
                              compact
                            />
                          </div>
                        </Show>
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
            <Show when={db.count() === 0 && !db.rows.loading}>
              <tr>
                <td colSpan={columns().length} class="h-10 px-2 text-muted-foreground">
                  No rows yet. Add one, or drop markdown files into this folder.
                </td>
              </tr>
            </Show>
          </tbody>
        </table>
        <button
          type="button"
          onClick={newRow}
          class="flex h-8 w-full items-center gap-1 px-2 text-left text-xs text-muted-foreground/70 hover:bg-accent/40 hover:text-foreground"
        >
          <Icon name="plus-add-small" class="size-4" />
          New row
        </button>
      </div>
    </div>
  );
}
