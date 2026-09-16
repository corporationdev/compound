# Cloud projects: organizations, Convex as source of truth, multi-client sync

Status: implemented on branch `cloud-sync` (2026-09-16). This is the plan
for making Convex the source of truth for project text while the desktop app
keeps a plain folder on disk for agents and the compiler. See
`docs/convex-migration-plan.md` for the backend that already existed.

Where things live: Convex functions in `packages/backend/convex/{organizations,
projects,files,assets}.ts` with the Better Auth component installed locally
under `convex/betterAuth/` (organization plugin); the sync engine in
`apps/desktop/src/sync/` (`ProjectSync`, the Convex adapter, the manager the
IPC channels talk to); asset originals in `apps/desktop/src/assets-cloud.ts`,
the Worker routes in `apps/server/src/index.ts`, and the renderer side in
`apps/web/src/engine/cloud-assets.ts`; editor view state in
`apps/web/src/engine/view-state.ts`; organizations, cloud projects and sync
status in `apps/web/src/lib/{organizations,cloud-projects}.ts` and
`apps/web/src/projects/sync.ts`.

Verification beyond the unit suites: `apps/desktop/src/sync/convex-functions.test.ts`
runs two engines against the real Convex functions in-process, and
`apps/desktop/scripts/sync-live-smoke.ts` runs two engines against a real
deployment over WebSocket given a signed native session token (it passed
against the dev deployment on 2026-09-16: publish, materialize, concurrent
merge, delete).

## Decisions

- **Convex rows are the truth for project text.** JSX, `package.json`,
  `assets.yml`, `tsconfig.json`, and every other small text file in the
  project folder are `projectFiles` rows with a version. Media bytes stay in
  R2 (originals only in this pass; proxies later).
- **The desktop folder is a checkout.** A sync component in the Electron main
  process materializes the folder from rows and pushes local changes back as
  versioned mutations. The renderer, esbuild, the file watcher, ts-morph
  write-back, MCP tools and the in-app chat keep working on the folder and do
  not know Convex exists.
- **Editor view state leaves the file.** `active`, `selected`, `playhead`,
  `timeline`, `expanded`, `clipHeight` and stage `camera` are no longer written
  back to JSX. They live in a per-project IndexedDB record and are re-applied
  after every mount. The file is still read as opening state.
- **Organizations** come from the Better Auth organization plugin, which needs
  the Convex Better Auth component installed locally so its schema can carry
  the plugin tables. Every project belongs to an organization; every query and
  mutation checks membership. Each user gets a personal organization on
  sign-up.
- **Conflicts** are resolved per file with a three-way merge against the last
  synced base. Non-overlapping edits from two clients merge cleanly. When
  hunks overlap, the local side wins and the other side's text is kept as
  `conflicts/<path>.<stamp>.conflict` inside the project, which syncs, so the
  machine whose edit lost sees the copy and gets a notice too. Versions
  guarantee no write lands on a stale base without a merge attempt.
- **A folder with no sync history does not overwrite the cloud.** A folder
  copied by hand, or pointed at a project after the fact, has no base to merge
  against: the cloud's text wins and the local text is kept as a conflict
  copy. A folder whose `.compound/sync/state.json` names a different project
  refuses to start. Duplicating a project strips the cloud binding and the
  sync state, so the copy is a new local project.
- **One writer per folder in the main process.** The inspector's write-back,
  id stamping at compile, manifest and config writes, and sync's own writes
  all take a per-folder lock around their read-and-write, so neither lands on
  the other's text.
- **Subscriptions carry metadata, not text.** `files.list` returns
  `{path, hash, version, deleted}`; the engine fetches text with `files.get`
  only for rows whose version moved. Text at 512 KiB or more, or with NUL
  bytes, does not sync and is reported in the status as skipped.
- **The file wins when the file changed.** The recorded view remembers what
  the file said about `active` and `camera` at the last mount; if the file
  changed since, the file's value is applied and recorded instead.
- **Not in this pass:** browser editing, proxies, live presence, shared chats,
  trim-aware uploads, invitations by email (members are added by email of an
  existing account). Known and accepted: `assets.finish` is a public mutation
  any organization member can call, so a member could mark an asset ready
  without the Worker's size check; moving that to a Worker-held admin key is
  a later step.

## Schema (Convex)

```
organizations, members, invitations, teams  – Better Auth component tables (local install)

projects
  organizationId: string       (Better Auth organization id)
  name: string
  entry: string                ("index.tsx")
  createdBy: string
  createdAt, updatedAt: number
  archivedAt?: number
  index by_org [organizationId]

projectFiles
  projectId: Id<'projects'>
  path: string                 ("/"-separated, project-relative)
  text: string                 (≤ 512 KiB, UTF-8, no NUL bytes)
  hash: string                 (sha256 hex of text)
  version: number              (starts at 1, +1 per write; tombstones bump too)
  deleted: boolean
  updatedAt: number
  updatedBy: string
  index by_project_path [projectId, path]
  index by_project [projectId]

assets
  organizationId: string
  sampleId: string             (16-hex library id from packages/assets hash.ts)
  size: number
  mimeType: string
  name: string
  originalKey?: string         (R2 key assets/<org>/<sampleId>/<name>)
  originalState: 'uploading' | 'ready'
  uploadedBy: string
  createdAt, updatedAt: number
  index by_org_sample [organizationId, sampleId]
```

## Functions (Convex) — the contract both sides code against

```
organizations.listMine()                       -> { id, name, slug, role }[]
organizations.create({ name })                 -> { id }                (action)
organizations.addMemberByEmail({ organizationId, email, role? }) -> void (action; caller owner/admin; target must exist)

projects.list({ organizationId })              -> Project[]            (member)
projects.get({ projectId })                    -> Project | null       (member)
projects.create({ organizationId, name, entry? }) -> { projectId }     (member)
projects.rename({ projectId, name })           -> void
projects.archive({ projectId })                -> void

files.list({ projectId })                      -> RemoteFileMeta[]  (no text; tombstones included; subscription target)
files.get({ projectId, path })                 -> RemoteFile | null
files.write({ projectId, path, text, hash, expectedVersion: number | null })
   -> { status: 'ok', version } | { status: 'conflict', current: RemoteFile | null }
   expectedVersion null means "create": ok only if absent or tombstoned.
files.remove({ projectId, path, expectedVersion }) -> same result shape
files.writeMany({ projectId, files: { path, text, hash }[] }) -> void   (publish; force, no version check; chunked by caller)

assets.register({ projectId, sampleId, size, mimeType, name }) -> { assetId, state, uploadNeeded }
assets.get({ projectId, sampleId })            -> Asset | null

RemoteFile = { path, text, hash, version, deleted, updatedAt, updatedBy }
RemoteFileMeta = RemoteFile without text
Creates that differ from an existing path only by case are refused (case-insensitive disks).
```

Worker (apps/server) additions for originals:

```
POST /media/asset-upload-url   { projectId, sampleId, size, mimeType, name } -> { assetId, uploadUrl }   (signed PUT, ≤ 4 GiB)
POST /media/asset-upload-finish{ assetId }                                  -> { ok }  (HEAD object, mark ready)
POST /media/asset-download-url { projectId, sampleId }                       -> { url, size, mimeType, name }
```

## Sync engine (apps/desktop/src/sync)

- `SyncBackend` interface (subscribe / write / remove / writeMany) with a
  Convex implementation and an in-memory fake for tests.
- `ProjectSync` per open cloud project:
  - state in `.compound/sync/state.json` (`{ projectId, files: { [path]: { version, hash } } }`)
    and base texts in `.compound/sync/base/<path>`.
  - **Down:** on each subscription snapshot, for every remote file with
    `version > known`: if the disk file equals the base (clean) write it and
    advance; if dirty, three-way merge (base, local, remote), write the
    merged text, advance the base to remote, then push the merged text with
    `expectedVersion = remote.version` if it differs from remote.
  - **Up:** on any change under the folder (raw watcher events, before the
    renderer's echo filter), read the file; if its hash differs from base,
    push with the known version. A conflict result is handled by the down
    path (the subscription delivers the newer row, and the file is dirty).
  - **Deletes:** local delete → `remove`. Remote tombstone → delete the local
    file only if it is clean; a dirty local file is re-pushed as a create.
  - **Startup reconcile:** walk the folder and the snapshot; push local-only
    files as creates, write remote-only files, resolve the rest as above.
  - **Ignore list:** `node_modules/`, `.compound/`, `cache/`, `exports/`,
    `assets/`, `.git/`, `.claude/`, `.mcp.json`, `.DS_Store`, `.dstmp-*`,
    any file over 512 KiB, any file with a NUL byte in its first 8 KiB.
  - **Echo:** sync writes are not claimed with `noteContent`, so the renderer
    sees them as outside edits and recompiles. The up path sees them too and
    finds hash == base, so nothing bounces.
  - **Offline:** failed pushes stay dirty and retry with backoff. Status is
    reported to the renderer as `synced | syncing | offline | error` with a
    pending count.
- Auth: the renderer passes its signed native session token when starting a
  sync; main mints Convex JWTs through the existing `authRequest('token')`
  path for `ConvexClient.setAuth`.

## Renderer

- Dashboard lists cloud projects for the active organization next to local
  folders; a local project gets a "Publish to cloud" action; opening a cloud
  project that has no folder here materializes one under the projects root.
- Settings gets an Organization section: switch, create, add member by email.
- Editor header shows sync status.
- View state: divert the seven prop names at the `editor.onEdit` wiring in
  `pages/editor.tsx` into `engine/view-state.ts`, which persists to an
  IndexedDB `views` store keyed by project id and re-applies after mount.

## Tests

- Backend: convex-test for membership enforcement, personal org creation,
  version conflicts, tombstones, publish, asset registration.
- Sync: unit tests over the fake backend for every rule above, plus a
  two-client convergence test (two `ProjectSync` instances in two temp
  folders against one fake backend, interleaved edits, asserts identical
  folders and no lost non-overlapping edit). A second convergence test runs
  the same scenario against the real Convex functions in-process through
  convex-test.
- Merge: diff3 cases (clean, overlapping, delete vs edit, whole-file replace).
- View state: pure reducer tests.

## Order

1. Backend (orgs, projects, files, assets) + tests.
2. Sync engine + fake backend + tests.
3. View state out of the file.
4. Convex adapter, IPC channels, dashboard and settings UI.
5. Asset originals (Worker endpoints, main upload/download, library hook).
6. Review pass.
