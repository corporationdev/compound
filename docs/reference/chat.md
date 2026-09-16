# Project chat

Open a project in the desktop app and choose **Chat** beside **Editor** in the
right sidebar. The panel drives the `claude` and `codex` you already have
installed, against the project that is open. Each chat belongs to that project;
closing the panel or navigating elsewhere leaves an active turn running.

The header carries the two tabs, **New chat**, and a history menu of this
project's chats — newest first, with a spinner while one runs, a dot while one
needs you, and a remove button on hover. An empty chat lists the five most
recent above the composer. Drag the thin inner edge of either sidebar to resize
it; widths are remembered and the Editor and Chat tabs share the right width.

## Sending

The composer is docked at the bottom in every state. Enter sends,
shift+Enter breaks the line, and while a turn runs the send button becomes
**Stop**. Its row carries the model picker.

- **Model.** One dropdown for both agents: Claude Code's models, then Codex's,
  fed by T3's provider probes. An agent that is not ready is one disabled row
  saying why, so the picker also says what this works with. A chat keeps the
  model it started with; choosing another starts a new draft and carries the
  typed text across. The dashboard's composer shares the same picker and the
  same remembered choice.
- **Permissions.** Not a choice. Every chat runs with full access, as the
  reference editor's host does, so nothing waits on an approval and thinking
  stays at each model's default. If a managed policy refuses full access, the
  chat steps down to T3's Auto mode once, retries the same turn, and every
  later chat starts there; approvals that mode asks for appear as cards.
- **Attachments.** Drop files or folders onto the composer and the agent reads
  them where they are — nothing is copied, and the paths ride in the message.
  Images pasted or picked with the paperclip are uploaded with the message
  instead: up to 8 per message, 10 MB each, PNG/JPEG/WebP/GIF.

Every message also carries the project ID, directory, authoring references and
a snapshot of the current scene, playhead and selection. That context is
appended to the message and hidden from the transcript. Pending canvas edits are
written to disk before the message is sent.

## The transcript

Items are small and flat, in time order, with stable ids so an open row stays
open while its output streams in:

| Item | What it is |
|---|---|
| `user` | What you sent, with attachment chips and any uploaded images |
| `assistant` | Markdown: code, tables, links, images, video and audio |
| `reasoning` | The model's own thinking — see the note below |
| `tool` | One call: a title, a one-line detail, and the output when expanded |
| `question` | The compact record of a question that was answered |
| `notice` | A runtime error, or an interrupted turn |

Tool rows merge every lifecycle event for one call ID, so a row keeps its place
and its identity from `started` to `completed`. The detail line is the command,
the path or the query; expanding shows the diff, the content and the output.
Context usage and other routine telemetry never appear. Only one turn runs in a
chat at a time. **Load earlier messages** fetches a larger authoritative window.

**Reasoning is not available from T3.** Its orchestration read model projects
only tool lifecycle, approvals, user input, plans and errors into thread
activities, and messages carry assistant text alone — `item.*` events for
`reasoning` items are filtered out server-side before they reach any client. The
`reasoning` item kind and its component are kept so a future T3 that surfaces it
needs no UI change; today nothing produces one.

## Approvals and questions

When an agent needs a decision, a card appears between the transcript and the
composer and the composer is disabled until it is answered:

- **Approvals** — running a command, reading or changing a file. The buttons are
  the decisions the provider offered.
- **Questions** — multiple choice, single or multi select, with a free-text
  *Other* row when the agent allows one. A single-choice question submits on
  click.

## Signing in

Compound uses your installed `codex` and `claude` commands and their existing
logins. It does not copy credentials or require a separate model API key. An
expired or missing login appears as one notice with a copyable command
(`codex login`, `claude auth login`). Sending is paused for the failed
conversation. After signing in, choose **I've signed in** to re-probe the
provider and continue in a new chat; the original conversation and any unsent
draft are saved. A CLI status probe can report a stale login, so runtime
authentication errors take precedence and the next provider turn remains the
final verification.

## The Compound tools

A chat reaches the editor through the app's MCP server (`mcp__compound__*`),
not through a shell command. `capture` shows the current frame and `check`
verifies that an edit actually rendered; `context` reports what the editor has
open. Capture, check and export require that exact project to be open — there is
no background renderer, and a chat never opens another project automatically.

How the server gets attached depends on the agent, because T3 gives a session
exactly one MCP server of its own (`t3-code`) and has no user-configurable
server list: its settings schema has no MCP section, and both drivers hardcode
their own entry.

- **Claude Code.** T3 runs it with `settingSources: ["user", "project",
  "local"]` and no `strictMcpConfig`, so a project-scoped `.mcp.json` is read.
  When a chat is first created or sent to in a project, `chat-server.ts` merges
  a `compound` entry (`{"type": "http", "url": …}`) into `<project>/.mcp.json`
  and adds `"compound"` to `enabledMcpjsonServers` in
  `<project>/.claude/settings.local.json`, which is what pre-approves an
  `.mcp.json` server where there is no terminal to answer a prompt. Both merges
  preserve anything already in those files.
- **Codex.** There is no project scope. T3 passes its own server as
  `-c mcp_servers.t3-code.*` and everything else comes from
  `~/.codex/config.toml`. The first time a chat runs Codex, main writes the
  `compound` server into that file (`registerMcp` in
  `apps/desktop/src/mcp-install.ts`), leaving other servers alone. A failure
  is shown in the panel and the turn still runs, with the editor context in
  its prompt but no tools.

## Development

`bun run dev:desktop` stages and starts the local backend. The package scripts
also stage it. Startup uses the packaged runtime and never downloads code.
T3's database lives at `<Compound userData>/chat/userdata/state.sqlite`,
separate from the user's ordinary T3 data and provider homes.

The server is the locked `t3@0.0.40` npm package, run with Electron's built-in
Node. `packages/chat` contains the matching MIT contract schemas, thread reducer
and pending-request parser extracted from that artifact's source maps, plus
Compound's transport adapter (`rpc.ts`) and the presentation layer
(`presentation.ts`) that turns a thread snapshot into the item list above. The
reference checkout declares the same version but has different protocol
dependencies; do not swap in its client source without upgrading the server too.

Main owns the localhost process, exchanges a bootstrap secret over an inherited
pipe for a bearer session, and opens a socket with a short-lived ticket. Only
signed asset URLs cross into the renderer. T3 owns persisted conversations and
provider sessions. Compound stores only drafts, the sidebar tab, the active chat
per project, and the model / permission / thinking choices a new chat starts
with. On reconnect it loads a fresh snapshot and replays above its watermark;
metadata arrives through T3's separate shell stream. Earlier history loads a
larger authoritative window before resubscribing, avoiding overlapping text
deltas. Compound enables T3's `enableLegacyTokenStreaming` setting in its
private profile on startup, including existing profiles: the bundled version
buffers assistant text by default, and enabling this emits incremental message
events. The desktop bridge publishes the latest state at most every 40 ms during
a stream, and final message events replace the accumulated text.

The UI lives in `apps/web/src/agent-chat/`. `store.ts` is the only module that
talks to the bridge (`MAIN_CHANNELS.CHAT_REQUEST` out, `CHAT_STATE` in); it is
module-level, so the panel can be unmounted — a tab switch, a page change —
without touching a running turn. `chat-panel.tsx` is the only place that knows
about the editor, because it is the only thing that can read the world.
`docs/agent-chat.md` is the upstream design spec the UI follows.

Run the deterministic checks with:

```sh
bun test packages/chat/test apps/desktop/test/chat-server.test.ts
COMPOUND_TEST_CHAT_RUNTIME=1 bun test apps/desktop/test/chat-server.test.ts
```

The second check requires the staged runtime. It creates isolated temporary
data, probes installed providers, checks persistence/replay and signed assets,
and does not submit a model turn.
