# Agent Chat — Design Spec

> **How Compound uses this document.** Compound's chat panel follows this spec's
> UI, protocol shapes and interaction model — the item kinds, the transcript,
> the question card, the composer, the right-sidebar tabs and the home-view
> handoff — but it does **not** use the agent host described in §2–§9. The
> backend is the embedded **T3 Code** server (`packages/chat`,
> `apps/desktop/src/chat-server.ts`): T3 owns the harnesses, the persisted
> conversations and the MCP attachment, and `apps/web/src/agent-chat/store.ts`
> maps its thread snapshots into the `Item` model below. Where the two differ,
> Compound follows T3: permission modes and approval cards exist (§1 lists them
> as non-goals), attachments include uploaded images as well as local paths, the
> MCP server name is `compound`, and `packages/agent-chat` is not part of this
> repository. `docs/reference/chat.md` is the description of what Compound
> actually ships.

Status: draft · Branch: `mcp-support` · Inspiration: [pingdotgg/t3code](https://github.com/pingdotgg/t3code)

A chat panel in the editor's right sidebar that drives the user's locally installed **Claude Code** or **Codex** against the open project, with the app's own MCP server attached. Built as a near-standalone "app inside the app": one package for orchestration, one folder for UI, a handful of one-line touchpoints.

---

## 1. Goals and non-goals

**Goals**

- Core chat only: send, stream, stop, new chat, history, model picker.
- Claude Code and Codex, nothing else. A harness that isn't installed shows as unavailable; there is no in-app auth. The harness runs with the subscription the user already set up on the device.
- Cross-platform native side: macOS, Linux, Windows.
- **Full access only**: Claude `bypassPermissions`, Codex `approvalPolicy: never` + `danger-full-access`. There's no permission picker and no approval prompts (§5.3). If an admin policy forbids full access, the chat degrades instead of breaking (§5.4).
- Never stuck: the only thing an agent can wait on is a multiple-choice question. It's shown as an inline card that can be answered, skipped or stopped (§5.3).
- Environment independent: the orchestration runs in Electron today and in a remote sandbox later. The web app only swaps the WebSocket URL.
- Reliable access to the app's MCP (`diffusion`) from every chat, without depending on or disturbing the user's global agent config.
- Isolation: `packages/agent-chat` + `apps/web/src/agent-chat/`, about a dozen small touchpoints elsewhere (§12).

**Non-goals (v1)**

Permission modes and approval prompts (full access only, by decision) · option previews in questions · uploading files (attachments are always local paths, §4) · queueing or steering while a turn runs · rename/search/branch/rollback · diff viewer · token/usage display · LLM-generated titles · slash commands and plan mode · git checkpoints · multiple providers per harness · remote pairing/auth.

Things t3code does that we deliberately skip: event sourcing and projections, Effect RPC, generated Codex schema (we hand-type ~10 methods), provider instances, buffered-vs-token streaming modes, rate-limit probes.

---

## 2. Architecture

```
 apps/web (renderer)                         agent host (Node)                      harness processes
┌──────────────────────────┐   WebSocket   ┌────────────────────────────┐  stdio  ┌───────────────────────┐
│ src/agent-chat/          │ ◀──────────▶ │ packages/agent-chat/host   │ ◀─────▶ │ claude (via Agent SDK)│
│  RightSidebar, Panel,    │  JSON msgs    │  ws server · AgentHost     │         │ codex app-server      │
│  Composer, store         │  + token      │  Claude/Codex adapters     │         └──────────┬────────────┘
│  AgentChatClient ────────┘               │  JSONL store · env/PATH    │                    │ MCP (HTTP)
└──────────────────────────┘               └────────────────────────────┘                    ▼
        ▲  1 IPC call: "where is the host?"          ▲ utilityProcess.fork        ┌───────────────────────┐
        │                                            │                             │ dapi MCP server       │
 ┌──────┴────────────────────────────────────────────┴───┐                        │ 127.0.0.1:3274/mcp    │
 │ apps/desktop main: starts host, answers endpoint call │ ─── hosts ───────────▶ │ ?client=chat          │
 └───────────────────────────────────────────────────────┘                        └───────────────────────┘
```

Key decisions:

1. **The host is a plain Node program** (`packages/agent-chat/src/bin.ts`). Electron runs it in a `utilityProcess`; a sandbox runs the same file with `node`. It has no Electron imports.
2. **WebSocket is the only renderer↔host channel, even on desktop.** There are no per-feature IPC channels. The only desktop IPC is one request that returns the host URL. This is what makes "switch the websocket" true later, and it sidesteps the renderer bridge's one-subscriber-per-event-channel limit (`apps/web/src/lib/ipc.ts:79`).
3. **The host owns all state** (chats, transcripts, harness sessions). The UI is a view over snapshots + events and can reconnect at any time.
4. **One normalized event model** (§4) that both adapters emit, and one pure reducer (`reduce.ts`) shared by the host (snapshots, persistence) and the UI (live rendering).
5. **The harness binaries are the user's own.** The Claude Agent SDK is pointed at the user's `claude` via `pathToClaudeCodeExecutable`; Codex is the user's `codex app-server`. We never ship or download a harness.

Why `utilityProcess` rather than main: a crash or a runaway JSON stream in the host can't take down the editor, the host is literally a separate application with its own entry point, and dev/prod/sandbox run identical code. Cost: one extra esbuild entry and ~50 lines of lifecycle glue.

---

## 3. Package: `packages/agent-chat` (`@diffusionstudio/agent-chat`)

Follows the repo's package conventions (TS source exports, no build step, `check`/`test` scripts). Like `@diffusionstudio/dapi`, the root export is browser-safe and Node code lives behind a subpath.

```
packages/agent-chat/
  package.json            exports: "." (browser-safe), "./host" (Node-only)
  src/
    index.ts              re-exports protocol, client, reduce
    protocol.ts           wire envelopes, requests, events, Item/Chat/Harness types
    reduce.ts             pure: (Transcript, ChatEvent) → Transcript
    client.ts             AgentChatClient: WebSocket, request/response, subscriptions, reconnect
    host/
      index.ts            startAgentHost(config) → { url, stop }
      server.ts           ws server: loopback bind, random port, token + Origin check
      host.ts             AgentHost: chat registry, routing, turn lifecycle, idle reaping
      store.ts            JSONL persistence (§8)
      env.ts              login-shell env, which(), Windows shim resolution, killTree()
      harness.ts          Harness + HarnessSession interfaces
      claude.ts           Claude adapter (Agent SDK)
      codex.ts            Codex adapter (app-server)
      jsonrpc.ts          ~80-line JSONL JSON-RPC peer over child stdio
      fake.ts             deterministic fake harness for tests / UI dev (not user-visible)
    bin.ts                CLI entry: --port --host --token --data-dir --mcp-url
  test/                   vitest: reducer, store, protocol, fake-harness end-to-end
```

Dependencies: `ws` (pure JS; server side only), `@anthropic-ai/claude-agent-sdk` (JS only; its optional platform binaries are never used). No native modules.

### Host config

```ts
type AgentHostConfig = {
  host?: string;               // default "127.0.0.1"
  port?: number;               // default 0 (random)
  token: string;               // required; 32 random bytes, base64url
  dataDir: string;             // chat storage root
  allowedOrigins?: string[];   // default: file://, null, http://localhost:5173
  mcp: { name: "diffusion"; url: string } | null;  // injected into every session
  instructions?: string;       // appended to each harness's system/developer prompt
  version: string;
};
```

---

## 4. Protocol

JSON text frames. The token goes in the URL (`ws://127.0.0.1:PORT/?token=…`).

### Envelopes

```ts
type ClientMsg = { t: "req"; id: string; method: Method; params: unknown };
type HostMsg =
  | { t: "res"; id: string; ok: true; data: unknown }
  | { t: "res"; id: string; ok: false; error: { code: string; message: string } }
  | { t: "event"; chatId: string; seq: number; event: ChatEvent }
  | { t: "harnesses"; harnesses: HarnessInfo[] };          // pushed when probes change
```

### Core types

```ts
type HarnessId = "claude" | "codex";
type ModelRef = { harness: HarnessId; model: string };     // the single dropdown's value

type HarnessInfo = {
  id: HarnessId; label: string;                            // "Claude Code" | "Codex"
  status: "ready" | "not-installed" | "signed-out" | "error" | "checking";
  detail?: string;                                         // e.g. "Run `codex login` in a terminal"
  version?: string;
  models: { id: string; label: string }[];
  defaultModel?: string;
};

type ChatSummary = {
  id: string; projectId: string; title: string;
  harness: HarnessId; model: string;
  status: "idle" | "running" | "waiting";                  // waiting = a question needs the user
  createdAt: number; updatedAt: number;
};

type Item =
  | { id: string; kind: "user"; text: string; attachments?: string[] }   // absolute paths
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "reasoning"; text: string }
  | { id: string; kind: "tool"; name: string; title: string; detail?: string;
      status: "running" | "done" | "failed" }
  | { id: string; kind: "question"; questions: Question[];
      answers: Record<string, string[]> | null }         // null = skipped
  | { id: string; kind: "notice"; level: "info" | "error"; text: string };

type ChatEvent =
  | { type: "turn.started"; turnId: string; model: string; user: Item }
  | { type: "item.started"; item: Item }
  | { type: "item.delta"; itemId: string; text: string }   // assistant / reasoning append
  | { type: "item.completed"; item: Item }                 // full, final item (replaces)
  | { type: "turn.completed"; turnId: string;
      status: "completed" | "interrupted" | "failed"; error?: string }
  | { type: "request.opened"; request: PendingRequest }
  | { type: "request.resolved"; requestId: string; outcome: "answered" | "skipped" | "cancel" }
  | { type: "chat.updated"; chat: ChatSummary };

// The only kind of request in v1. Tagged, so approvals can be added later without a protocol change.
type PendingRequest = { id: string; type: "question"; questions: Question[] };

type Question = {
  id: string;            // Claude: the full question text (the SDK looks answers up by it); Codex: its id
  header: string;        // short chip label, ≤ 12 chars
  question: string;
  options: { label: string; description: string }[];      // empty = free text only
  multiSelect: boolean;
  allowOther: boolean;   // Claude: always; Codex: isOther
  secret: boolean;       // Codex isSecret → password field
};

type RequestResponse = { answers: Record<string, string[]> } | "skip" | "cancel";
```

### Methods

| Method | Params | Result |
|---|---|---|
| `harnesses.list` | `{ refresh?: boolean }` | `HarnessInfo[]` |
| `chats.list` | `{ projectId }` | `ChatSummary[]` (newest first) |
| `chats.open` | `{ chatId }` | `{ chat, items, seq }`, then events stream for that chat |
| `chats.close` | `{ chatId }` | unsubscribes |
| `chats.delete` | `{ chatId }` | stops the session, removes files |
| `turn.send` | `{ chatId?, projectId, cwd, text, attachments?, model: ModelRef }` | `{ chatId }`, as soon as the chat exists and the turn is accepted, not at turn end. No `chatId` means a new chat is created and auto-subscribed. |
| `turn.interrupt` | `{ chatId }` | cancels any pending question, then resolves when the turn has ended |
| `request.respond` | `{ chatId, requestId, response: RequestResponse }` | resolves once the harness has the answer |

Rules:

- **Snapshot + events.** `chats.open` returns items and the current `seq`; the client ignores events with `seq ≤ snapshot.seq`. On reconnect the client re-opens its subscribed chats. There is no replay protocol.
- A chat is created lazily on its first `turn.send`, so "New chat" never leaves empty chats in history.
- A chat's harness is fixed at creation. `turn.send` with a different harness is rejected (`harness-mismatch`); the UI prevents it (§10).
- Only one turn runs per chat at a time. `turn.send` while running or waiting is rejected (`busy`).
- Pending requests are part of the `chats.open` snapshot, so a reconnecting or late client can still answer them.
- Title = first user message, whitespace-collapsed, truncated to 60 chars.
- Attachments are absolute paths.
  - The host appends them to the text it sends to the harness: "Attached files and folders:", then one path per line.
  - The stored `user` item keeps text and paths apart, so the UI can show chips.
  - Nothing is ever copied or uploaded, from either composer: the agent reads the files where they are.
  - Paths come from Electron's `getPathForFile` (`window.desktop`), so dropping works only in the desktop app; in a browser the drop is ignored.

---

## 5. Harness adapters

```ts
interface Harness {
  id: HarnessId;
  probe(env: HostEnv, signal: AbortSignal): Promise<HarnessInfo>;
  open(opts: {
    cwd: string; model: string;
    resume?: ResumeCursor; mcp: McpConfig | null; instructions?: string; env: HostEnv;
  }): Promise<HarnessSession>;
}
interface HarnessSession {
  readonly resume: ResumeCursor;                 // persisted after every turn
  send(text: string, model: string, emit: (e: ChatEvent) => void): Promise<void>;  // resolves at turn end
  respond(requestId: string, response: RequestResponse): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
type ResumeCursor = { claude: { sessionId: string } } | { codex: { threadId: string } };
```

The host keeps **at most one live session per chat** and closes it after **10 minutes idle** (next send resumes from the cursor). This bounds process count without extra UX.

### 5.1 Claude Code — Agent SDK over the user's binary

One long-lived `query()` per live session. The SDK is a typed wrapper: it spawns the Claude Code CLI with `--output-format stream-json --input-format stream-json` and speaks a control protocol over stdio. By default it runs its **own bundled CLI** (per-platform optional dependencies), so `pathToClaudeCodeExecutable` must always be set, and the bundled binaries are never shipped. esbuild bundles only the SDK's JS. The prompt is an async-iterable queue of `SDKUserMessage`, and `send()` pushes to it.

```ts
query({
  prompt: queue,
  options: {
    cwd,
    model,
    pathToClaudeCodeExecutable: resolved.claudePath,          // §6; never the SDK's bundled binary
    permissionMode: "bypassPermissions",                      // §5.4 when a policy forbids it
    allowDangerouslySkipPermissions: true,
    ...(resume ? { resume: resume.claude.sessionId } : { sessionId: randomUUID() }),
    includePartialMessages: true,                             // token streaming
    settingSources: ["user", "project", "local"],             // user's CLAUDE.md, settings, plugins
    systemPrompt: { type: "preset", preset: "claude_code", append: instructions },
    mcpServers: mcp ? { diffusion: { type: "http", url: mcp.url } } : {},
    canUseTool,                                               // §5.3: AskUserQuestion → question card; anything else → allow
    env: childEnv,                                            // §6
  },
});
```

Mapping (SDK message → `ChatEvent`):

| SDK | Event |
|---|---|
| `stream_event` `content_block_start` (`text` / `thinking` / `tool_use`) | `item.started`: a new assistant, reasoning or tool (`running`) item, so text and tool calls interleave in order |
| `stream_event` `content_block_delta` `text_delta` / `thinking_delta` | `item.delta` on the open assistant / reasoning item |
| `assistant` message, `text` / `thinking` block | `item.completed` (assistant / reasoning) |
| `assistant` message, `tool_use` block | the tool item gets its input summary (re-emitted `item.started` with the same id replaces it). MCP names `mcp__diffusion__capture` become title "capture". |
| `user` message, `tool_result` block | `item.completed` (tool, `done` / `failed`, detail truncated to 2 KB) |
| `result` (`success` / `error_*`) | `turn.completed` |
| `result.permission_denials` | one `notice` per denied action. This only happens under the policy fallback (§5.4) or the user's own deny rules. |

- Model change within a chat: `q.setModel(model)` before pushing.
- **Interrupt = `q.close()`**, then `turn.completed{interrupted}`; the next send re-opens with `resume`. t3code found `interrupt()` can ack while background work keeps the CLI alive; closing is the robust option.
- The session id is generated by us up front, so the resume cursor is known before the first byte.

### 5.2 Codex — `codex app-server` (JSONL JSON-RPC over stdio)

One `codex app-server` child per live session, driven through `jsonrpc.ts`. The protocol is hand-typed; we use only these methods:

| Direction | Method | Use |
|---|---|---|
| → | `initialize` + `initialized` | `clientInfo: { name: "diffusion_studio", title: "Diffusion Studio", version }`, `capabilities: { experimentalApi: true }` (needed for `requestUserInput`) |
| → | `thread/start` / `thread/resume` | `{ cwd, model, approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions }`. Resume falls back to start on "not found" and posts a `notice` item ("Previous Codex session not found — started fresh"). |
| → | `turn/start` | `{ threadId, input: [{ type: "text", text }], model, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }`. Both are sent on every turn so a resumed thread can't keep older settings. |
| → | `turn/interrupt` | `{ threadId, turnId }` |
| ← | `item/agentMessage/delta`, `item/reasoning/textDelta` | `item.delta` |
| ← | `item/started`, `item/completed` | items: `agentMessage` → assistant, `reasoning` → reasoning, `commandExecution` / `fileChange` / `mcpToolCall` / `webSearch` → tool |
| ← | `turn/completed`, `error` | `turn.completed` |
| ← (request) | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/fileRead/requestApproval` | shouldn't arrive with `approvalPolicy: "never"`. If one does, answer `accept` at once so nothing can hang (`decline` under the §5.4 fallback). |
| ← (request) | `item/tool/requestUserInput` | → question `PendingRequest` (§5.3) |

Spawn args (MCP injected by config override, §7):

```
codex app-server
  -c mcp_servers.diffusion.url="http://127.0.0.1:3274/mcp?client=chat"
```

Model is passed per `turn/start`, so switching Codex models mid-chat needs nothing special.

### 5.3 Permissions and questions

Every chat runs with **full access**, the same as t3code's default mode. Nothing ever waits on an approval, which removes the permission picker, the approval UI, and Codex's sandbox and reviewer settings.

- **Claude:** `bypassPermissions`. `canUseTool` is still registered, but only to catch `AskUserQuestion`. Any other call it receives is allowed at once (`{ behavior: "allow", updatedInput: input }`).
- **Codex:** `approvalPolicy: "never"` with `danger-full-access`. Codex never sends an approval request. If one arrives anyway, it's accepted at once.

What this deliberately accepts:
- The agent can do anything the user can: delete or overwrite files (including the source footage in the project), use the network, run git.
- Anything the agent reads, such as web pages or media metadata, could try to steer it (prompt injection), and nothing gates the resulting commands.

Cheap mitigations that add no UI:
- `cwd` is the project folder.
- The empty chat says plainly that agents have full access (§10).
- The injected `instructions` (§7) tell the agent to ask with a question before deleting or overwriting source media, or before acting outside the project folder. This only works at the prompt level, so it's a guideline, not a guarantee.

**Clarifying questions (multiple choice)** are the one thing an agent can wait on:

- **Claude** (`AskUserQuestion`)
  - Shape: 1–4 questions, 2–4 options each, optional `multiSelect`, and "Other" added automatically.
  - It arrives through `canUseTool` with `toolName === "AskUserQuestion"`. The handler checks for it first: allowing it without answers would return nothing to Claude.
  - Answer with `{ behavior: "allow", updatedInput: { questions: input.questions, answers: { [questionText]: "Label" } } }`, keyed by the full question text, which is how the SDK looks answers up.
  - Multi-select labels are joined with `", "`. "Other" sends the typed text.
  - Skip returns `{ behavior: "deny", message: "The user skipped the question. Proceed with your best judgement." }`.
  - Option `preview`s are ignored in v1.
- **Codex** (`item/tool/requestUserInput`, experimental)
  - It is offered mainly in Codex's plan mode, and in default mode only when the tool is enabled for the turn, so it is rarer than Claude's.
  - Questions carry `id`, `header`, `question`, optional `options`, `isOther` and `isSecret`.
  - Answer `{ answers: { [id]: { answers: string[] } } }`. Skip sends empty arrays.
  - If Codex resolves it itself (`autoResolutionMs`, then `item/tool/requestUserInput/answered`), emit `request.resolved{cancel}`.
- Once resolved, a `question` item is appended to the transcript (e.g. "Format → 9:16" or "Skipped"), so history records what was decided.

Never-stuck guarantees:

| Situation | Outcome |
|---|---|
| User submits or skips | the harness continues with that answer |
| User presses Stop | pending question → `cancel`, then the turn is interrupted |
| User switches chat or tab, closes the panel, or reloads | the question stays pending in the host; history marks the chat "Needs you"; answering later continues the turn |
| Host or app restarts with a question pending | the harness process is gone; the turn is marked `interrupted`; the next message resumes the session |
| The harness withdraws the question (SDK `signal` aborts, Codex auto-resolves) | `request.resolved{cancel}`; the card disappears |

No timeouts.

### 5.4 When full access isn't allowed

Admins can forbid full access: Claude Code through managed settings that disable bypass mode, Codex through its admin requirements. Claude Code also refuses bypass mode when running as root unless it's told it's in a sandbox, which matters for §13. None of these cases may break the chat or quietly get around the policy:

- **Claude:** if the session fails to start because bypass is disallowed, open it once more with `permissionMode: "auto"`, or `"default"` if auto isn't available either. `canUseTool` then **denies** every call except `AskUserQuestion`; auto-allowing would override the admin's intent. Denials become `notice` items via `permission_denials`, and the agent carries on without that action, so it never hangs.
- **Codex:** if `thread/start` rejects `danger-full-access` / `never`, retry with `sandbox: "workspace-write"` + `approvalPolicy: "never"`. Writes outside the project and network calls fail inside the sandbox and are reported back to the model. No approvals are ever requested.
- Either way the chat shows one persistent `notice`: "Your organization doesn't allow full access. Some actions will be blocked." The fallback is remembered per harness while the host is running.

---

## 6. Detection, environment, cross-platform

All of this lives in `host/env.ts`. Nothing is added to `apps/desktop`.

**Environment hydration** runs once at host start and doesn't block listening; probes await it.

- macOS/Linux: run `$SHELL -ilc 'printf __S__; printenv PATH; printf __E__'`. Fallback shells: `os.userInfo().shell`, then `/bin/zsh` or `/bin/bash`. Timeout 5 s; parse between markers to skip rc-file noise. Prepend the result to `process.env.PATH`. This fixes the Finder-launched app's minimal launchd PATH, which the app has no answer for today.
- Windows: GUI apps already inherit the full user PATH; use `process.env` as is.
- `childEnv` = hydrated env minus `ELECTRON_*` / `NODE_OPTIONS`, so the user's Node-based CLIs behave normally.

**Binary lookup** (`which`): walk PATH (+ `PATHEXT` on Windows), then known install dirs: `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, `%APPDATA%\npm`, `%LOCALAPPDATA%\Programs`. Overrides: env `DIFFUSION_CLAUDE_PATH`, `DIFFUSION_CODEX_PATH`, matching the `YT_DLP_PATH` precedent.

**Windows shims**:

- Claude: the SDK can't spawn a `.cmd` (`EINVAL`). If `claude.cmd` resolves, follow it to `node_modules/@anthropic-ai/claude-code/cli.js`; the SDK runs `.js` with node. The native installer's `claude.exe` is used directly.
- Codex: if `codex.cmd`, spawn with `shell: true`. This is safe because argv is constant and built by us (quoted). Prompts only ever travel over stdin.

**Probes** are cached. They re-run on `harnesses.list {refresh:true}`, which the UI sends when the model dropdown opens if the cache is older than 60 s. The result is pushed to all clients.

| | Installed | Signed in + models |
|---|---|---|
| Claude | `claude --version` | SDK probe with a never-yielding prompt (no API call): `initializationResult().account`, `supportedModels()`. Options: `persistSession:false`, `strictMcpConfig:true`, `mcpServers:{}`, `settings:{disableAllHooks:true}`, env `CLAUDE_CODE_AUTO_CONNECT_IDE=0`. Timeout 25 s. |
| Codex | binary found | short-lived `app-server`: `initialize` → `account/read` (no account + `requiresOpenaiAuth` → `signed-out`) → `model/list`, then kill |

- Not installed means `not-installed`: shown disabled, never hidden, so the user learns it's supported.
- Signed out means `signed-out` with detail "Run `claude` / `codex login` in a terminal".
- If a probe times out but the binary exists, the status is `ready` with a static fallback model list, and a failure surfaces on first send.

**Process teardown** (`killTree`): POSIX sends `SIGTERM`, then `SIGKILL` after 2 s. Windows uses `taskkill /pid N /T /F`, which is required with `shell: true`. Claude sessions use `q.close()`, which does its own escalation. Every harness is stdio-attached and exits on stdin EOF, so even a hard host crash doesn't leave orphans.

---

## 7. MCP: attaching the app's server to every chat

Requirements: always available in chats, independent of whether the user ever ran "Connect Agents…", and no side effects on the editor UI or the user's global config.

1. **Inject per session; never rely on the global registration.** Claude gets SDK `mcpServers: { diffusion: {type:"http", url} }`. Codex gets `-c mcp_servers.diffusion.url=…`. Nothing is written to `~/.claude.json` or `~/.codex/config.toml` for the chat.
2. **Same server name `diffusion` as the global registration.** The injected entry replaces the global one instead of duplicating every tool (`mcp__diffusion__*` once). For Codex the `-c` override is deterministic by construction.
3. **Mark chat connections with `?client=chat`.** Today the first MCP connection switches the app into headless "Remote controlled" mode (`dapi/http.ts:111`), which would be wrong while the user is watching the chat. `DapiHttpServer` reads `client` from the URL on `initialize` and skips `onFirstConnection` for `chat`. Routing is untouched, because the path check only looks at `pathname`. This is about a 5-line change and the only edit inside dapi.
4. **The MCP URL is host config**, passed by desktop (`MCP_URL + "?client=chat"`), or `null` if the dapi HTTP server failed to bind. With `null`, chats still work, and the first turn posts a `notice`: "Editor tools unavailable".
5. **Instructions:** a short `instructions` string (§3) is appended: "You are running in Diffusion Studio's chat panel. The open project is at `<cwd>`. The `diffusion` MCP tools act on it live — use `capture`/`check` to verify edits. Before deleting or overwriting source media, or acting outside this folder, ask first with a question." The MCP server's own instructions (`knowledge/INSTRUCTIONS.md`) still apply.

Spike needed (§14): confirm the Claude SDK's `mcpServers.diffusion` overrides a user-scope `diffusion` from `~/.claude.json`. If it doesn't, set `strictMcpConfig: true` for chat sessions. That is deterministic, at the cost of the user's other MCP servers not loading in the in-app chat.

---

## 8. Persistence and history

Stored under `dataDir` (Electron: `app.getPath("userData")/agent-chat`), not in the project folder. This keeps projects clean and shareable.

```
<dataDir>/chats/<chatId>/
  meta.json      ChatSummary + { cwd, resume: ResumeCursor | null }   (atomic write: tmp + rename)
  events.jsonl   append-only: turn.started, item.completed, turn.completed   (no deltas)
```

- `chats.list` reads every `meta.json` and filters by `projectId`, which is cheap at hundreds of chats. There is no index file to get out of sync.
- The transcript is `events.jsonl` folded through `reduce()`. An unparsable trailing line (a crash mid-write) is skipped.
- In-flight deltas live only in memory; `chats.open` during a running turn snapshots from memory.
- Pending requests live only in host memory (they are meaningless without the live harness process).
- On host start, any chat with `status: running` or `waiting` gets a synthetic `turn.completed{interrupted}` and goes back to `idle`.
- Harnesses keep their own transcripts (`~/.claude/projects`, `~/.codex/sessions`). We store only the resume cursor and never read theirs.
- Chats are keyed by `projectId` (from `package.json`), so history survives moving or renaming the project folder. `cwd` is refreshed from each `turn.send`.

---

## 9. Security

Every chat is a full-access agent running as the user, so the WebSocket must not be reachable by arbitrary local web pages (browsers don't apply CORS to WebSockets).

- Bind `127.0.0.1`, random port.
- A 32-byte random token, required on upgrade, compared in constant time.
- `Origin` must be in `allowedOrigins`. Packaged: `file://` / `null`; dev: `http://localhost:5173`.
- The token never touches disk. Desktop main generates it, passes it to the utilityProcess, and hands `url?token=` to the renderer over the existing IPC.
- The MCP server keeps its current model (loopback + Host-header check). `?client=chat` is a UI marker, not a credential.

---

## 10. Web UI: `apps/web/src/agent-chat/`

Everything in one folder, built only from existing primitives (`Button`, `Tooltip`, `DropdownMenu*`, `ControlScrollArea`, `RemoveButton`, `Icon`, `createStoredSignal`) and existing tokens (`text-[12px] font-450`, `bg-accent`, `border-border`, `text-muted-foreground`).

```
agent-chat/
  index.ts               exports RightSidebar, SidebarTabs, rightSidebarWidth, ModelPicker, startChat, attachment helpers
  right-sidebar.tsx      <Show when={tab()==="chat"} fallback={props.editor()}> <ChatPanel/>
  sidebar-tabs.tsx       "Editor  Chat" labels; tab stored as store.define("rightSidebar.tab","editor")
  chat-panel.tsx         header (tabs + actions) · transcript · composer
  header-actions.tsx     plus (New chat) · history (Chat history)
  history-menu.tsx       DropdownMenu of this project's chats
  transcript.tsx         renders Items, top-anchored
  stick-to-bottom.ts     vendored use-stick-to-bottom (Solid port, MIT): pinned to bottom (see Scrolling)
  item-*.tsx             user · assistant · reasoning · tool · notice
  markdown.tsx           marked + DOMPurify, no syntax highlighting
  question-card.tsx      inline multiple choice: options, multi-select, Other, Skip / Submit
  attachments.tsx        drop → paths (getPathForFile), AttachmentTile chips; moved from home-view.tsx, shared by both composers
  composer.tsx           auto-grow textarea · attachment chips · model picker · send/stop
  model-picker.tsx       one dropdown for harness+model
  store.ts               Solid store over AgentChatClient + reduce()
  connection.ts          endpoint resolution (desktop IPC | configured URL) → AgentChatClient
```

### Layout

```
┌──────────────────────────────┐ h-12 px-4 (same as InspectorHeader)
│ Editor  Chat          [+] [⟲]│  active tab: text-foreground · inactive: text-muted-foreground
├──────────────────────────────┤  header controls: relative z-30, -webkit-app-region: no-drag
│                              │
│  transcript: top-anchored,   │
│  pinned to bottom            │
│                              │
├──────────────────────────────┤
│ ┌──────────────────────────┐ │ composer: always at the bottom, even when the chat is empty
│ │ Ask the agent…           │ │
│ │ ◆ Sonnet 5 ▾         (↑) │ │ (↑) send; (■) stop while running
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

On the Editor tab the right side of the header keeps the existing zoom dropdown, unchanged.

### Sidebar width

- **264 px on the Editor tab, 360 px on the Chat tab.** At 12 px text, 360 px gives about 53 characters per line after padding, against about 37 at 264 px. On a 1280 px screen the canvas keeps about 650 px.
- **Switching tabs animates the width**: `grid-template-columns`, ~200 ms, ease-out.
  - The canvas, timeline and soundboard reflow with it.
  - The soundboard shares the right column, so it widens too and the timeline narrows by 96 px.
- **No animation on load.** Opening a project page with Chat already selected starts at 360 px.
  - This includes arriving from a home-view handoff, which sets the tab before navigating.
  - The stored tab is read synchronously before first paint, and the transition is only switched on after the first frame.
- `prefers-reduced-motion` switches instantly.
- **Fixed width in v1.** Resizing (320–480 px, remembered) can come later, reusing the timeline's drag-handle pattern in `editor.tsx`.
- **Implementation:**
  - `agent-chat` exports `rightSidebarWidth()` (264 or 360, derived from the tab). `editor.tsx` builds the grid's `grid-template-columns` from it instead of the fixed `grid-cols-[264px_1px_1fr_1px_264px]` class, and adds the transition.
  - Chromium interpolates `grid-template-columns` as long as the track count stays the same. Toggling `uiVisible` changes the track count, so that still snaps as it does today.

### Behaviour

- **Tabs**: "Editor" and "Chat" as plain text labels, the unselected one muted. The selection persists across sessions.
- **Plus**: opens an empty draft chat (no host call until the first send). Disabled when the current chat is already empty. The first Enter sends `turn.send` without a `chatId`, and the returned id becomes the active chat. A turn running in another chat keeps running.
- **History**: a dropdown of this project's chats, newest first. Each row shows the title, relative time, a spinner if running, a dot + "Needs you" if waiting, and a check if active. A hover `RemoveButton` deletes the chat without confirmation. An empty list shows "No chats yet".
- **Composer**: always docked at the bottom of the panel, in every state: empty chat, running, question pending, no harness.
  - **No composer animation.** It never starts centered and moves down, never animates its position or height, and has a static placeholder ("Ask the agent…") instead of the dashboard's rotating, fading one.
  - The textarea grows instantly with its content up to `max-h-40`, then scrolls. The question card and the empty-state line above it appear and disappear without transitions.
  - Looks like the dashboard composer (`home-view.tsx:381-445`: rounded border, `bg-accent`, 12 px text), sized to the 360 px chat sidebar. Its placeholder fade is not reused.
  - **Drop files or folders** onto the composer, exactly as on the home view:
    - Each becomes a removable chip above the textarea that holds only its absolute path. Nothing is read, copied or uploaded.
    - While dragging, the composer shows the home view's static drop overlay (no transition).
    - Chips belong to the per-chat draft. They go out as `attachments` with the next message and are then cleared.
  - Enter sends; Shift+Enter inserts a newline; IME-safe (`isComposing`). Key events `stopPropagation` so editor shortcuts don't fire.
  - While the chat is running or waiting, the send button becomes stop (`turn.interrupt`) and the textarea stays editable, so the next prompt can be typed. Enter does nothing until the turn ends; there is no queue.
  - Drafts are kept per chat in the store, so switching chats doesn't lose them.
  - On send, the user message renders at once (optimistic) and is replaced by the host's `turn.started` item.
- **Question card**: pinned between the transcript and the composer while a question is pending. Send is disabled ("Waiting for your answer"), Stop still works, and questions are answered one at a time.
  - Each question shows its header chip, the question text, and one row per option (label plus muted description).
  - Inputs: radio buttons for single choice, checkboxes for multi-select, an "Other" row with an inline text field, and a password field when `secret`.
  - 1–4 questions are stacked. The card scrolls on its own if it is taller than half the sidebar.
  - Buttons: **Skip** (secondary) and **Submit** (enabled once every question has an answer). A card with one single-choice question submits on click.
- **Model picker** (single dropdown):
  - The trigger is the harness icon (the ones `lib/agents.ts` uses today: `claude-code` / `codex`) plus the model label.
  - Groups: **Claude Code** → models, **Codex** → models. An unavailable harness is one disabled row with "Not installed" or "Sign in: run `claude` in a terminal".
  - There's no permission setting; every chat has full access (§5.3).
  - The model persists in `localStorage` (`agentChat.model`).
  - In a non-empty chat, picking a model from the *other* harness opens a new draft chat with that model and carries the draft text over. The chat's harness never changes.
  - With no harness ready, the send button is disabled and the empty state explains why.
- **Items**:
  - *user*: full-width `bg-muted rounded-md px-2 py-1.5`, whitespace preserved. Attachments show as small chips (icon + name) under the text.
  - *assistant*: markdown at 12 px.
  - *reasoning*: collapsed "Thinking" row; expand to read.
  - *tool*: one muted 11 px line (`title · detail` truncated); click expands input/output. A spinner shows while running.
  - *question*: compact record of what was asked and answered ("Format → 9:16"), or "Skipped".
  - *notice*: muted, or destructive for errors.
- **Empty state**: a short muted line above the composer: "Agents run with full access to your files and terminal." When no harness is ready, it says why instead.
- **Streaming**: deltas are batched per animation frame in the store.
- **Scrolling** (transcript): top-anchored and pinned to bottom.
  - **Top-anchored.** Messages flow from the top of the transcript like a normal document. A short chat sits at the top with empty space below. Messages are not stacked from the bottom, and a sent message is not snapped to the top.
  - **Pinned to bottom.** Once content is taller than the transcript, the end of the streaming text stays right above the prompt box.
    - It follows with use-stick-to-bottom's spring (`damping 0.7`, `stiffness 0.05`, `mass 1.25`), which smooths out bursty token chunks.
    - Opening a chat jumps to the end instantly (`initial: "instant"`).
  - **Pinned** when a chat opens (at the end, not a remembered offset), after every send (`scrollToBottom()`), and whenever the view is within 70 px of the bottom. A chat that doesn't overflow counts as pinned.
  - **Unpinned** as soon as the user scrolls up; a wheel-up always unpins. New content then grows below without moving the view. While the user is selecting text in the transcript it doesn't auto-scroll. Scrolling back near the bottom pins it again.
  - There's no "jump to latest" button in v1. `isAtBottom()` is there if one is added later.
  - **Implementation:** vendor the SolidJS port of [use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom) (`@conciv/solid-stick-to-bottom` 0.0.19, ~190 lines, MIT) into `agent-chat/stick-to-bottom.ts`, keeping both MIT notices.
    - Its two `@solid-primitives` helpers (`event-listener`, `timer`) are swapped for plain `addEventListener` / `setTimeout`, so there are no new dependencies.
    - It's vendored rather than installed because the port is a month old, has one maintainer and about 10 downloads a week. The React original (about 2M a week) is the proven one and the reference for fixes.
    - API: `createStickToBottom(() => scrollEl, { initial: "instant" })` → `{ isAtBottom, scrollToBottom, stopScroll }`. `resize` keeps the default spring.
  - `ControlScrollArea` isn't reused or changed: it only pins once the view already overflows (`isAtBottom` requires `max > 0`), it can't re-pin on send, and it restores offsets per key.
- **Switching chats or tabs** never stops a running turn. Transcripts live in the store, so remounting is free.
- **No host** (web build without an endpoint): the Chat tab shows "Chat runs in the desktop app" and links the existing get-desktop-app flow.
- **Icons**: add `history.svg` (and `stop.svg` if no suitable icon exists) to `src/assets/icons/`, 24×24, `fill="currentColor"`, same as `arrow-left.svg`.

### Starting a chat from the home view

Scenario: the user types a prompt on the home view, drops a footage folder, picks Fable 5.1 and submits. They land in the editor with the chat open, and the reply is already streaming.

1. **Model picker.** The home composer uses the same `ModelPicker` as the chat (exported from `agent-chat`), fed by live probes.
   - It replaces `AgentPicker` and the static list in `lib/agents.ts`, which already lists models (the same one-dropdown idea) but detects nothing.
   - Both composers share one remembered model: `agentChat.model` replaces `home.agent`.
2. **Submit.** `home-view.tsx` keeps its `resolveTarget()` (existing project, picked folder, or new project) and then calls `startChat({ project, text, attachments, model })` from `agent-chat`. That call:
   - sends `turn.send` without a `chatId`, so the host creates the chat and starts the harness;
   - waits only for the `{ chatId }` reply, which is immediate, not for the turn;
   - makes that chat the project's active chat;
   - switches the right sidebar to the Chat tab, and shows the sidebar if the user had hidden the UI (the `layout.uiVisible` stored key).

   Then home navigates, as it does today.
3. **Survives navigation.** The chat store lives at module level, not inside the editor page, so the subscription made by `turn.send` survives the page switch. Events that arrive mid-switch are already in the store, and the `chats.open` snapshot covers any gap.
4. **Attachments.** Paths from the drop go into `attachments`, the same as a drop on the sidebar composer. The drop code (`droppedAttachments`, `AttachmentTile`) moves from `home-view.tsx` into `agent-chat/attachments.tsx`, so both composers share one implementation.
5. **Failure.** If `startChat` fails (no host, harness not ready, send rejected), home still navigates. The sidebar opens a new chat with the text as an unsent draft, and the error shows as a toast, so nothing typed is lost.

**Which chat the panel shows:** the project's active chat (remembered per project in `localStorage`), else its newest chat, else an empty draft.

### Connection

```ts
// connection.ts
async function resolveEndpoint(): Promise<string | null> {
  if (window.desktop) return (await mainBridge.call(MAIN_CHANNELS.AGENT_CHAT_ENDPOINT, {}))?.url ?? null;
  return import.meta.env.VITE_AGENT_CHAT_URL ?? null;     // sandbox later: from the session API
}
```

`AgentChatClient` reconnects with backoff (0.5 s → 5 s) and re-resolves the endpoint on each attempt, which covers a restarted host on a new port. It then re-opens subscribed chats.

---

## 11. Desktop integration

New `apps/desktop/src/agent-chat.ts` (~50 lines):

```ts
export function startAgentChat(opts: { dataDir: string; mcpUrl: string | null; version: string }): void
export function agentChatEndpoint(): { url: string } | null
export function stopAgentChat(): void
```

- Generates the token and forks `dist/agent-host.mjs` via `utilityProcess.fork(path, [], { serviceName: "Agent Chat" })`.
- Posts the config to the child over `parentPort` (not argv). The child answers `{ port }` once it is listening.
- Restarts the child on unexpected exit with backoff: 1, 2, 5, 10 s, capped. The renderer reconnects on its own.
- `stopAgentChat()` asks the host to stop, which kills harness trees, then kills the child after 3 s.

The host bundle is built by esbuild as **ESM** (`.mjs`), because the Agent SDK is ESM and uses `import.meta`. It lands in `dist/`, which forge already ships, so nothing changes in packaging.

---

## 12. Touchpoints outside the two isolated folders

| File | Change | Size |
|---|---|---|
| `apps/web/src/pages/editor.tsx` | `<Inspector />` → `<RightSidebar editor={() => <Inspector />} />`; right grid column from `rightSidebarWidth()` with a width transition | ~6 lines + import |
| `apps/web/src/components/sidebar-right/inspector/inspector-header.tsx` | `<span>Editor</span>` → `<SidebarTabs />` | 1 line + import |
| `apps/web/src/components/dashboard/home-view.tsx` | `AgentPicker` → `ModelPicker`; the drop helpers and `AttachmentTile` move to `agent-chat/attachments.tsx` and are imported back; after `resolveTarget()`, call `startChat(...)` before navigating | ~15 lines changed, ~60 moved out |
| `apps/web/src/lib/agents.ts` | removed once home uses `ModelPicker` (probes replace the static list) | delete |
| `apps/web/src/assets/icons/` | `history.svg` (+ `stop.svg` if needed) | 1–2 files |
| `apps/web/package.json` | `@diffusionstudio/agent-chat`, `marked`, `dompurify` | 3 deps |
| `apps/desktop/src/agent-chat.ts` | new: host process lifecycle | ~50 lines |
| `apps/desktop/src/main.ts` | `startAgentChat` in `whenReady`, `stopAgentChat` in `before-quit`, endpoint handler | ~4 lines |
| `apps/desktop/src/main-channels.ts` | `AGENT_CHAT_ENDPOINT: { request: {}; response: { url: string } \| null }` | ~3 lines |
| `apps/desktop/package.json` | `build:agent-host` esbuild step, chained into `build` | 1–2 lines |
| `apps/desktop/src/dapi/http.ts` | `?client=chat` sessions skip `onFirstConnection` | ~5 lines |

No preload change: the endpoint request rides the existing `main:request` wire. Removing the feature means deleting the two folders and reverting these lines.

---

## 13. Running in a web sandbox later

- Run `node agent-host.mjs --host 0.0.0.0 --port 8787 --token $T --data-dir /data --mcp-url …` in the sandbox, behind TLS (`wss://`).
- The web app sets the endpoint (`VITE_AGENT_CHAT_URL` or a session API). The UI code is unchanged.
- Differences to solve then, deliberately out of scope now:
  - `cwd` is a sandbox path, so the host gets a `resolveCwd(projectId)` hook.
  - The MCP server must be reachable from the sandbox, as a config value only.
  - Harness auth inside the sandbox.
  - Claude Code refuses bypass mode as root. Run as a non-root user, or declare the sandbox (§5.4).
  - Attachments are paths on the host's filesystem. A sandbox can't see the user's local files, so dropping stays desktop-only unless a way to get files into the sandbox is designed then.
- Keep the protocol free of Electron and local-path assumptions. That is the only discipline this requires today.

---

## 14. Risks and spikes (do these first, ~1 day total)

1. **Claude MCP precedence**: does SDK `mcpServers.diffusion` shadow the user-scope `diffusion` in `~/.claude.json`? Fallback: `strictMcpConfig: true` for chats.
2. **Policy fallback (§5.4)**: find the exact errors for Claude bypass disabled by managed settings, Claude running as root, and a Codex admin-requirements rejection, so the fallback triggers on those and nothing else.
3. **Bundling the Agent SDK** into an ESM utilityProcess bundle, with `pathToClaudeCodeExecutable` set and no bundled binaries.
4. **Windows**:
   - `claude.cmd` → `cli.js` resolution.
   - `codex.cmd` with `shell: true`.
5. **Codex app-server drift**: hand-typed methods. Read the version from `initialize.userAgent`, enforce a minimum, and show "Update Codex" below it.
6. **Login-shell hydration** on slow rc files: 5 s timeout, then fall back to the inherited PATH plus known dirs.
7. **SDK ↔ CLI version skew**: we bundle one SDK version but talk to whatever `claude` the user has. Read `claude --version` in the probe and show "Update Claude Code" below a minimum version.
8. **Questions**:
   - Confirm `AskUserQuestion` reaches `canUseTool` under `bypassPermissions`. t3code checks for it before its auto-allow, which suggests it does. If it doesn't, disable the tool with `disallowedTools` so Claude asks in plain text.
   - Confirm the multi-select answer format.
   - Confirm Codex skip semantics: empty arrays vs. an error.
9. **Tool calls before the editor mounts**: after a home handoff, the agent may call a `diffusion` tool before the project page has mounted its editor session. Renderer tools would then throw `no-project`.
   - Usually model latency hides this, and a failed tool call isn't fatal: the agent retries.
   - If testing shows it happening, make `requireEditorSession()` wait a few seconds for the session before throwing.
10. **Width animation**: the canvas resizes on every frame of the ~200 ms tab-switch transition. Confirm it stays smooth; if not, switch the width instantly.

---

## 15. Milestones

1. **Package core**: protocol, reducer, store, ws server + client, fake harness, vitest end-to-end over a real socket.
2. **Claude adapter** + env/which/probe; run via `bin.ts` from a terminal.
3. **UI**: tabs, panel, composer, picker, history, question card against the fake harness (which can ask questions), then Claude.
4. **Desktop wiring**: utilityProcess, endpoint IPC, `?client=chat` in dapi, esbuild entry, home-view handoff.
5. **Codex adapter.**
6. **Cross-platform pass**: Windows + Linux smoke test (install detection, send, stop, quit leaves no processes).

## 16. Open questions

- **User's other MCP servers**: load them in in-app chats (proposed, if the spike passes) or deliberately isolate with `strictMcpConfig`?
- **Scope of history**: per project (proposed) or global across projects?
- **Parallel chats in one project**: two chats can run at once (the only rule is one turn per chat), so two agents may edit the same files. Allow it (proposed), or allow only one running chat per project?
