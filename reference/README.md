# compound CLI Reference

Reference for `compound`, the Compound CLI. Every canvas and project command talks to the running app over a local socket. Responses are JSON written to stdout; errors are human-readable messages on stderr with a non-zero exit.

Each feature command has its own file (linked below). The JSX code syntax specified in [jsx/](./jsx/README.md) is **pseudo-SVG**, mirroring SVG's shape-and-paint model with the editor's own tags and props rather than the SVG spec.

A project is a folder of that JSX, and **the source is the document**: the app compiles the entry file and renders every element into an editable node, and edits made on the canvas are written back to the element that authored them. So the loop is `compound open <dir>` once, then edit the files — there is no command that pushes content into the app. What the commands do is read the running app ([`context`](./context.md), [`capture`](./capture.md), [`logs`](./logs.md)), inspect media, and list what a declaration may name.

## Groups

**Top-level:** [`whoami`](./whoami.md), [`logs`](./logs.md), [`screenshot`](./screenshot.md), [`report`](./report.md), [`context`](./context.md) (alias `ctx`), [`capture`](./capture.md), [`check`](./check.md), [`export`](./export.md), [`models`](./models.md), [`voices`](./voices.md), [`fonts`](./fonts.md), [`fetch`](./fetch.md).

| Group | Alias | Scope |
| ----- | ----- | ----- |
| `media` | `m` | Inspect a media file by path, without adding it to the project. Local files and URLs work with or without an open project; library paths need one. |

How the surface is divided:

- Compound supports cloud transcription and Gemini analysis. Import other media from files; cloud generation and transforms are unavailable. `models` and `voices` return empty lists.
- Inspecting an existing asset (probe / transcribe / listen / filmstrip / waveform / grab) lives under `media`.

## Commands

### App

- [`compound whoami`](./whoami.md): print the authenticated account
- [`compound logs`](./logs.md): recent console output from the running app
- [`compound screenshot`](./screenshot.md): capture the entire application window as a PNG
- [`compound report`](./report.md): file a GitHub issue about a bug in the CLI or the app, with diagnostics attached

### Document

- [`compound open`](./open.md): launch the app and open (or create) a project folder, anywhere on disk
- [`compound context`](./context.md): which project the app has open, where its playhead sits, its registered fonts, and where its generations stand
- [`compound capture`](./capture.md): render frames of a scene, as an export would, to a labelled contact sheet or one PNG per position
- [`compound check`](./check.md): check a node's subtree for structural mistakes (black-frame gaps, never-visible nodes, failed sources) and report subtree stats
- [`compound export`](./export.md): encode a scene to a video file, with the settings saved in the project's `package.json`

### Media

- [`compound media probe`](./media/probe.md): container and track metadata
- [`compound media transcribe`](./media/transcribe.md): timed speech transcript
- [`compound media grab`](./media/grab.md): decode video frames to a labelled contact sheet, or one PNG per frame
- [`compound media filmstrip`](./media/filmstrip.md): grid of video frames as a PNG
- [`compound media waveform`](./media/waveform.md): audio waveform PNG with silence highlighting
- [`compound media listen`](./media/listen.md): AI description of an audio track

### Generation reference

- [`compound models`](./models.md): list generation models and constraints
- [`compound voices`](./voices.md): list speech voices

### Fonts

- [`compound fonts`](./fonts.md): list local fonts

### Download

- [`compound fetch`](./fetch.md): download a video with yt-dlp (installed separately)

## Shared types

```ts
Asset = { id: string; path: string; type: string }  // asset ids are content hashes; `path` is the library path
Time  = number | `${number}f` | "MM:SS"              // seconds, frames at 30 fps ("45f"), or a clock string; see jsx/timing.md
NodeId = string                                     // an element's `id` in the project's JSX; `file:id` when two files collide
```

Time inputs take the `Time` format unless noted otherwise. Times in **outputs** are plain seconds.

## Conventions

- **Stdout is JSON.** Commands that return a single record emit one JSON value. Commands that return a collection emit JSON Lines (one object per line, no surrounding array) so per-item results stay streamable. Exceptions: `fonts --names-only` writes plain family names; `logs` writes plain formatted log lines.
- **Unix-style names are canonical.** Commands without a natural Unix equivalent (`context`, `whoami`) keep their descriptive names.
- **Stderr:** human-readable error messages.
- **Exit codes:** `0` on success, `1` on any error (missing file, app not running, invalid input, IPC error).
- **App must be running:** every command except `fonts` and `fetch` talks to the open Compound instance. If the app isn't running, the CLI prints an instruction to launch it and exits `1`. `report` is the one command that reads from the app but tolerates its absence, recording it in the issue instead of failing.
