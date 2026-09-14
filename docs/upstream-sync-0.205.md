# Upstream sync: diffusionstudio/editor v0.205.0

Compound is a fork of `diffusionstudio/editor`. Fork point: `4a652f5` (2026-09-06).
This sync merges upstream `main` at `2593b92` (v0.205.0, 2026-09-14) into ours.

Branch: `sync/upstream-v0.205`. The merge is started with `git merge --no-commit`;
conflicts are resolved by area, then the whole thing is committed once.

## The rule

Bring in everything upstream did. Keep only our intentional changes. After the
sync, the one architectural difference is: **our chat panel is backed by the
embedded T3 Code server; theirs is their own host.** The chat UI must match theirs.

## Our intentional changes (keep)

1. **Brand**: Compound, not Diffusion Studio. Binary `compound`, not `dapi`.
   Project data dir `.compound/`, socket/env `COMPOUND_*`, userData `Compound`,
   `brand-migration.ts` migrates old Diffusion Studio data. Icons and banner are ours.
2. **Cloud**: Supabase, tRPC, billing, AI credits, checkout, and in-app media
   generation are removed. Auth is Convex + Better Auth; a Cloudflare Worker;
   Deepgram transcription (`packages/backend`, `apps/server`, `packages/infra`,
   `scripts/*` preview deployments). `packages/config` holds runtime config.
3. **Chat**: `packages/chat` + `apps/desktop/src/chat-server.ts` embed T3 Code.
   Providers: Claude Code and Codex via the user's CLIs. Permission modes,
   approvals, image upload attachments, editor context injection per message.
4. **Library** (sfx/music): `library search|get|resolve|import` CLI commands,
   library sidebar, Convex catalog, `docs/media-library.md`, `reference/library.md`.
5. **Captions / transcription**: `packages/runtime/src/media/caption`, wav2vec aligner.
6. **Releases**: `scripts/release.mjs`, release workflow, versions kept off main.
7. **Bun** as package manager (`bun.lock`; no `package-lock.json`).

## What upstream did since the fork (take)

- **Tool catalog + MCP** (`packages/dapi`): every tool is `defineTool({name, input, output, environment})`.
  The desktop app serves them as an MCP server over Streamable HTTP on a fixed
  loopback port (`apps/desktop/src/dapi/`). The CLI is a thin MCP client over
  the catalog (`apps/cli`), with `dapi mcp` as a stdio proxy. `mcp-config.ts` /
  `mcp-install.ts` write the server into each agent's config. The old Unix-socket
  CLI RPC (`cli-channels`, `cli-socket-path`, `protocol.ts`, `cli-server.ts`,
  `cli-rpc.ts`, `context/dapi/*`) is gone. Tool handlers live in
  `apps/web/src/dapi/handlers` (renderer) and `apps/desktop/src/dapi/handlers` (main).
- **Knowledge base**: `reference/` moved to `docs/reference`, plus `docs/INSTRUCTIONS.md`,
  `docs/brand`, `docs/guides`, `docs/examples`, `docs/skills`. Staged into the app
  as a resource; the MCP `instructions` text points agents at it. `skills-install.ts`
  symlinking and `stage-skills.mjs` are removed. Onboarding page and headless mode removed.
- **Agent chat** (`packages/agent-chat`, `apps/web/src/agent-chat`, `apps/desktop/src/agent-chat.ts`):
  their own host. **We take the UI only** and bind it to T3.
- **Editor**: project scanning (`PROJECTS_SCAN`), atomic file writes, project init tests,
  partial assets, transform refactor, playhead shortcuts (seek to selection / edges),
  default camera settings, `fetch` command removed, icon changes, dashboard refactor
  (project card, sidebar sections, delete dialog, home view starts a chat).
- Versions to 0.205.0.

## Naming decisions

| Upstream | Ours |
|---|---|
| `dapi` binary, `@diffusionstudio/dapi` | `compound` binary, `@compound/dapi` |
| MCP server name `diffusion` (`mcp__diffusion__*`) | `compound` (`mcp__compound__*`) |
| `http://127.0.0.1:3274/mcp` | `http://127.0.0.1:3284/mcp` (coexists with DS on a dev box) |
| `.diffusion/` | `.compound/` |
| `@diffusionstudio/agent-chat` | not used; `@compound/chat` (T3) |
| `Diffusion Studio` in UI/docs | `Compound` |

Tool names stay upstream's. Our library commands become catalog tools:
`library_search`, `library_get`, `library_resolve`, `library_import`. `projects list`
becomes `projects_list`. `media_transcribe` keeps our Deepgram backend. `fetch` is dropped.

## Areas and ownership

Four agents work in the same tree at once. Each edits only its files. Nobody runs
`git commit`, `git checkout`, `git stash`, `git merge --abort`, or `git reset`.
`git add <own files>` is allowed (retry on index.lock). Conflict markers must be gone
from owned files when done.

**A. cli-mcp** — `apps/cli/**`, `packages/dapi/**`, `apps/desktop/src/dapi/**`,
`apps/desktop/src/{cli-install,cli-server,mcp-config,mcp-install,main-channels,main,preload,menu,headless,skills-install}.ts`,
`apps/desktop/scripts/{stage-cli,stage-skills,stage-runtime,stage-docs}.mjs`,
`apps/desktop/package.json`, `apps/desktop/forge.config.ts`, `apps/desktop/.gitignore`,
`apps/web/package.json`, `apps/web/src/dapi/**`, `apps/web/src/context/dapi/**`,
`apps/web/src/lib/{cli-rpc,ipc,desktop-app}.ts`, `apps/web/src/engine/source-errors.ts`,
`apps/web/src/engine/library.ts`, `apps/web/src/lib/db.ts`,
`packages/assets/**`, `packages/encoder/**`, root `package.json`, `package-lock.json` (delete).

**B. chat-ui** — `apps/web/src/agent-chat/**`, `apps/web/src/components/chat/**`,
`packages/chat/**`, `packages/agent-chat/**` (delete), `apps/desktop/src/agent-chat.ts` (delete),
`apps/desktop/src/chat-server.ts`, `apps/web/src/pages/editor.tsx`,
`apps/web/src/components/dashboard/home-view.tsx`, `docs/reference/chat.md`, `docs/agent-chat.md`.

**C. docs-brand** — `docs/**` (except the two chat docs), `reference/**` (delete after
folding into `docs/reference`), `skills/**`, `examples/**`, `README.md`, `NOTICE.md`,
`assets/**`, `apps/web/public/**`, `apps/web/src/assets/**`, `docs/reference/library.md`.

**D. app-core** — everything else: `apps/desktop/src/{projects,edit,atomic,brand-migration,cloud,...}.ts`,
`apps/desktop/test/**`, `apps/web/src/app.tsx`, `apps/web/src/components/**` (except chat and
home-view), `apps/web/src/context/**` (except dapi), `apps/web/src/engine/**` (except
source-errors, library), `apps/web/src/lib/**` (except the three A owns), `apps/web/src/pages/**`
(except editor), `apps/web/src/projects/**`, `apps/web/src/utils/**`, `apps/web/src/hooks/**`,
`apps/web/test/**`, `packages/{jsx,reconciler,runtime,config,backend,infra}/**`, `apps/server/**`.

## Done means

- No conflict markers anywhere (`git grep -n '^<<<<<<<\|^>>>>>>>'` is empty).
- `bun install` clean, `bun run check` passes, `bun test packages/chat/test apps/desktop/test apps/web/test` passes.
- `apps/desktop` builds (`bun run --cwd apps/desktop build`).
- The chat panel looks like upstream's and is driven by T3.
- `compound --help` lists the catalog including library tools; the MCP server serves them.
