/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A database as a page of its own: its name, where it sits, and its grid,
// on the same column a document uses so the two read as one kind of page.

import { useNavigate } from "@solidjs/router";

import { baseName, workspaceRoute } from "@/lib/workspace";

import { WorkspaceBreadcrumbs } from "./breadcrumbs";
import { DatabaseGrid, createDatabase } from "./database-grid";

export { loadSchema } from "./database-grid";

export function TablePage(props: { path: string }) {
  const navigate = useNavigate();
  const db = createDatabase(() => props.path);
  const title = () => db.schema.latest?.name ?? baseName(props.path);

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div class="mx-auto flex w-full max-w-3xl flex-col px-12 pb-40 pt-14">
        <WorkspaceBreadcrumbs path={props.path} />
        <h1 class="mt-3 min-w-0 truncate text-6xl font-450 leading-tight text-foreground">{title()}</h1>
        <div class="mt-8">
          <DatabaseGrid path={props.path} onOpen={(path) => navigate(workspaceRoute(path))} />
        </div>
        <p class="mt-3 text-xxs text-muted-foreground/70">
          Each row is a markdown file in this folder. Columns come from <code class="font-mono">_table.yaml</code> and the rows' properties.
        </p>
      </div>
    </div>
  );
}
