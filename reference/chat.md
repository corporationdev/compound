# Project chat

Open a project in the desktop app and choose **Chat** beside **Inspector**.
Choose Codex or Claude Code and a model. Each chat belongs to that project;
closing the panel or navigating elsewhere leaves an active turn running.
Drag the thin inner edge of either sidebar to resize it. Widths are remembered,
and Inspector/Chat share the right width. Double-click a divider to reset it;
focused dividers support arrow keys and Home/End. The timeline uses the same
divider behavior.
Use **New chat** to change providers. When a provider needs setup, the inline
status offers login guidance and a refresh action.

Compound uses your installed `codex` and `claude` commands and their existing
logins. It does not copy credentials or require a separate model API key.
If authentication expires, use `codex login` or `claude auth login`, refresh
the provider, and start a new chat if the provider requests it.
An expired or missing login appears as one sign-in notice with a copyable
command. Sending is paused for the failed conversation. After signing in,
choose **I've signed in** to refresh the provider and continue in a new chat;
the original conversation and any unsent draft remain saved. A CLI status
probe can still report a stale login, so runtime authentication errors take
precedence and the next provider turn remains the final verification.

Every message includes the project ID, directory, authoring references and a
snapshot of the current selection/playhead. This context is sent to the agent
without adding a disclosure to the transcript. Pending canvas edits are written
before a message is sent.
The context also supplies an exact CLI invocation bound to this app's bundled
executable, local socket and project. This remains correct when login shells
change PATH or a provider strips inherited environment variables.
Messages support Markdown, code, images, video, audio, and file links. Image
attachments support paste and the file picker. Provider approvals and questions
are shown inline. Messages have no speaker labels; user messages use an inset
bubble. Tool calls appear in time order as compact rows, with lifecycle updates
merged by call ID. Expand a row for commands, files, diffs, or output. Context
usage and other routine telemetry are omitted from the transcript. Only one
turn runs in a chat at a time; Stop interrupts it.
The composer permission picker follows T3: **Supervised**, **Auto-accept edits**,
**Auto**, and **Full access**. New projects default to Supervised; a chosen
new-chat mode is remembered for that project. Existing chats change their T3
runtime mode through `thread.runtime-mode.set`, including live provider sessions.
Auto behavior depends on provider support, as described in the picker.
Chats start with provider approvals enabled unless another mode is selected. Codex may request permission to
reach Compound's local socket; approve that command in the sidebar to let its
CLI call reach the app.

The CLI resolves its project from `--project <id-or-path>`, or from its working
directory and parents. `compound projects list` lists known projects. File
editing and media inspection can target a project that is not visible.
Capture, check and export require that exact project to be open. There is no
background renderer and a chat never opens another project automatically.

## Development

`bun run dev:desktop` stages and starts the local backend. The package scripts
also stage it. Startup uses the packaged runtime and never downloads code.
T3's database lives at `<Compound userData>/chat/userdata/state.sqlite`, separate
from the user's ordinary T3 data and provider homes.

The server is the locked `t3@0.0.40` npm package with a bundled Node 24.13.0
runtime for each Mac architecture. `packages/chat` contains the matching MIT
contract schemas, thread reducer and pending-request parser extracted from that
artifact's source maps, plus Compound's transport adapter. The reference
checkout declares the same version but has different protocol dependencies;
do not swap in its client source without upgrading the server too.

Main owns the localhost process, exchanges a bootstrap secret over an inherited
pipe for a bearer session, and opens a socket with a short-lived ticket. Only
signed asset URLs cross into the renderer. T3 owns persisted conversations and
provider sessions. Compound stores only drafts and selected-chat preferences.
On reconnect it loads a fresh snapshot and replays above its watermark; metadata
arrives through T3's separate shell stream. Earlier history loads a larger
authoritative window before resubscribing, avoiding overlapping text deltas.
Compound enables T3's `enableLegacyTokenStreaming` setting in its private
profile on startup, including existing profiles. The bundled T3 version defaults
to buffering assistant text; enabling this emits incremental message events.
The desktop bridge publishes the latest state at most every 40 ms during a
stream, and final message events replace the accumulated text.

Run the deterministic checks with:

```sh
bun test apps/cli/test/project-target.test.ts packages/chat/test
COMPOUND_TEST_CHAT_RUNTIME=1 bun test apps/desktop/test/chat-server.test.ts
```

The second check requires the staged runtime. It creates isolated temporary
data, probes installed providers, checks persistence/replay and signed assets,
and does not submit a model turn. A development test instance can use
`COMPOUND_CLI_SOCKET=/tmp/compound-test.sock` on both the desktop and CLI to
avoid the ordinary app's socket.
