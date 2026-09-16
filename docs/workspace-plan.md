# Workspace: one synced folder per organization

Status: in progress on branch `cloud-sync` (2026-09-16). Builds on
`docs/cloud-projects-plan.md`, which made Convex the truth for project text
and the desktop folder a checkout. This pass generalizes that from "a
project" to "an organization's workspace": one folder per organization on
disk, one file table per organization in Convex, projects as folders inside
it, and a Notion-style document editor over any markdown file in it.

## Decisions

- **One workspace per organization, one to one.** The workspace is the
  organization; there is no separate table. Files key by
  `organizationId + path`. Splitting an organization into several trees can
  be added later with a column, and there is no reason to today.
- **Convex is the truth.** `files` rows (path, text, hash, version) are the
  canonical copy. The folder on disk is a checkout. Anything Convex derives
  from the text (a project list, table rows, views) is an index that can be
  rebuilt from the rows and is never written to directly.
- **Disk layout.** `~/Movies/<stage folder>/<organization slug>/` is the
  checkout. `.compound/` inside it holds sync state, base texts and per-user
  state. `projects/` is a starter folder, nothing structural: a project is
  any folder holding a Compound `package.json`, wherever it sits.
- **Projects are derived.** The dashboard lists projects by walking the
  workspace for folders with a `package.json` and an entry file. There is no
  `projects` table any more. A project's identity stays its `projectId` in
  `package.json`; its URL does not change.
- **Publish and materialize go away.** Binding a workspace is `start`: the
  engine's startup reconcile pushes local-only files as creates, brings
  cloud-only files down, and keeps the cloud's text for files that exist on
  both sides with no sync history (local copy kept as a conflict file). That
  is what "publish" and "materialize" used to do, with one path.
- **Migration on disk.** The first time an organization's workspace folder is
  created, project folders sitting directly in the old projects root move
  into `<workspace>/projects/`. Their `cloudProjectId` field is dropped.
- **Migration in Convex.** `migrations.projectsToWorkspace` copies each
  legacy project's rows into its organization's `files` at
  `projects/<folder name>/<path>` when nothing is there yet. The legacy
  tables stay in the schema until that has run everywhere.
- **Assets** register against the organization, not a project. They were
  already deduplicated per organization by content hash.
- **Markdown with frontmatter is the document format.** The editor is
  WYSIWYG (Tiptap) but what lands on disk is markdown, so an agent editing
  the file with its own tools sees the same thing the user sees.
  Frontmatter is the property store; the body is prose.
- **Tables are folders with `_table.yaml`.** Rows are markdown files in the
  folder (frontmatter = properties, body = document) or one `rows.jsonl`
  for machine-written rows. The grid is TanStack Table; Tiptap's table
  extension is only for prose tables inside a document.
- **Not in this pass.** Browser editing, kanban and calendar views, an
  inline database block inside a document, Yjs on bodies, connectors,
  merging an outside edit into a document that has unsaved local edits
  (the local save wins, same as between machines).

## Convex

```
files
  organizationId: string
  path, text, hash, version, deleted, updatedAt, updatedBy   (as projectFiles)
  index by_org_path [organizationId, path], by_org [organizationId]

files.list({ organizationId })                 -> RemoteFileMeta[]   (subscription target)
files.get({ organizationId, path })            -> RemoteFile | null
files.write({ organizationId, path, text, hash, expectedVersion })
files.remove({ organizationId, path, expectedVersion })
files.writeMany({ organizationId, files })

assets.register({ organizationId, sampleId, size, mimeType, name })
assets.get({ organizationId, sampleId })

migrations.projectsToWorkspace()               (internal; run once per deployment)
```

`projects` and `projectFiles` stay in the schema as legacy tables; the
`projects.ts` functions are removed.

## Desktop (main process)

- `sync/workspace-sync.ts` is the engine, keyed by organization id. Same
  rules, same merge, same conflict copies. The state file records the
  organization id and refuses a folder bound to another.
- `sync/rules.ts` ignores `cache/`, `exports/`, `assets/`, `node_modules/`,
  `.git/`, `.compound/`, `.claude/` at any depth.
- `sync/locks.ts` serializes writers across nested folders: a lock on the
  workspace waits for locks on any project inside it and vice versa, so the
  inspector's write-back and the workspace sync never interleave.
- `sync/manager.ts` runs one engine per workspace: `start({ dir,
  organizationId, sessionToken })`, `stop`, `status`, `setSession`.
- `workspace.ts` is new: the folder for an organization (created on first
  use, legacy projects migrated in), a tree listing that skips the ignored
  folders, read/write/create/rename/remove for entries, a recursive walk for
  projects, and a watcher that reports changes to the renderer.
- Channels: `WORKSPACE_OPEN`, `WORKSPACE_TREE`, `WORKSPACE_PROJECTS`,
  `WORKSPACE_READ`, `WORKSPACE_WRITE`, `WORKSPACE_CREATE`,
  `WORKSPACE_RENAME`, `WORKSPACE_REMOVE`, `WORKSPACE_WATCH`,
  `WORKSPACE_UNWATCH`, event `WORKSPACE_CHANGED`. `SYNC_START` takes an
  organization id. `SYNC_PUBLISH` and `SYNC_MATERIALIZE` are gone.
  `ProjectInfo` loses `cloudProjectId`.

## Renderer

- `lib/workspace.ts` is the store: the active organization's folder, its
  tree (refetched on `WORKSPACE_CHANGED`), its projects, and the sync status.
  Sync starts when a signed-in user has an active organization and stops
  when either goes away. Replaces `projects/sync.ts` and
  `lib/cloud-projects.ts`.
- `projects/host.ts`: the projects root is `<workspace>/projects`; the
  folder picker for a root is gone. Opening any folder as a single project
  stays. `listProjects` answers the workspace's projects merged with the
  records (covers, last opened) plus records for folders outside it.
- Dashboard sidebar: Home and Projects at the top, then a "Workspace"
  section styled like them (Notion-style rows: a page icon, a folder's icon
  turns into a chevron on hover, "New page" at the bottom). Projects are not
  in the tree; they have the Projects view. Pages show their title, not
  `.md`. Route `/workspace/*path` opens a file in the dashboard shell.
- `components/ui/tree.tsx`: rows with indent, chevrons, keyboard navigation,
  inline rename, context menus through the existing wrapper.
- `components/workspace/`: file tree, document page (title, properties,
  Tiptap body), properties strip, table page (TanStack grid), plain text
  fallback for other text files.
- Projects view: no cloud section, no publish; the folder bar shows the
  workspace. Project card loses the cloud badge.
- Editor: the sync pill reads the workspace's status when the project sits
  inside it. Cloud assets use the organization id.

## Tests

- Desktop: engine tests renamed to the workspace engine; manager tests for
  start, refuse another organization, sign-out; rules tests for the new
  ignore list; workspace tests for migration, tree listing, project walk,
  and entry operations; lock tests for nested folders; convex-functions
  tests against the organization-keyed functions.
- Web: markdown frontmatter split and join; tree building from a flat
  listing; workspace path helpers; the cloud-logic tests minus
  `matchCloudToLocal`.

## Order

1. Convex functions and schema, Worker routes.
2. Desktop sync engine, locks, manager, workspace module, channels, main.
3. Renderer store, host, dashboard shell, tree, projects view.
4. Document page with Tiptap, markdown round-trip, properties.
5. Table page.
6. Type checks, tests, run the app and look at the editor.
7. Independent review.
