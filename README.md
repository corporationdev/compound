> **Compound fork:** cloud services use Convex + Better Auth, a Cloudflare Worker, Deepgram, and Gemini. See [setup and secrets](docs/cloud-setup.md). Billing and in-app media generation are removed; local editing, the music/SFX library, and automatic captions remain.

<p align="center">
  <a href="https://github.com/corporationdev/compound">
    <img src="assets/compound-banner.png" alt="Compound — the video editor built for agents" width="700" />
  </a>
</p>

<p align="center">The professional video editor built for agents</p>

<p align="center">
  <a href="https://github.com/corporationdev/compound/releases/latest">Download for macOS</a> ·
  <a href="https://github.com/corporationdev/compound/issues">Support</a> ·
  <a href="docs/reference/tools/README.md">Tool reference</a>
</p>

<p align="center">
  <code>npx skills add corporationdev/compound</code>
</p>

<br />

## Compound

Edit videos with Claude Code, Codex, Cursor, Copilot, or Gemini CLI. Refine any output in a fully featured editing environment.

Every edit you make is written to real code, so the agent always sees the latest version.

## What people do with it

Drop your raw footage and files into a folder, then ask for the video you want. That's it.

The agent handles everything from there:

- Cuts the clips
- Removes filler words
- Adds subtitles
- Applies color correction and filters
- Handles animations
- Renders the final video

Beyond finishing a cut, it covers:

- **Motion graphics**: explainers, promos, and title sequences
- **Music and sound effects**: searched, auditioned, and imported from the library
- **Clipping**: highlights from a long video, reformatted for social
- **Video understanding**: summaries, scene search, quotes with timestamps

## How it works

Compound uses [SolidJS](https://www.solidjs.com) modules as the document source. Think IDE, but it renders a video canvas instead of text.

Editing works both ways: change something on the canvas and the code updates; change the code and the canvas redraws.

The desktop app serves its editing tools as an MCP server, and ships the same set as a command-line client, so agents can watch and listen to footage, edit it on a timeline, and render the result.

## Getting started

Download the desktop app, it walks you through setting everything up:

<a href="https://github.com/corporationdev/compound/releases/latest"><img src="https://img.shields.io/badge/Download-Compound-161616?style=for-the-badge&logo=apple&logoColor=F8F8F8&labelColor=000000" alt="Download Compound" /></a>

Use with Claude Code, Codex, Cursor, Copilot, or Gemini CLI. The app registers its MCP server with your agent, so just ask for what you want in plain language. Every session's instructions carry the editing and watching skills, so the agent reads the guidance it needs up front. `compound` is the same set of tools as a CLI.

## Prompt examples

<details open>
<summary><b>Motion graphics</b></summary>

```text
Create a ~20-second promo for vercel-labs/native in Vercel's presentation style. Research its official website, GitHub, and brand guidelines; use authentic assets and verified product features, with crisp typography, polished motion, and a strong final CTA.
```

```text
Recreate the 3blue1brown animation from https://youtu.be/HEfHFsfGXjs, closely matching its visual style, pacing, framing, colors, labels, and transitions. Use the exact collision mathematics from Gregory Galperin's original paper, do not approximate the physics.
```

</details>

<details>
<summary><b>Video editing</b></summary>

```text
Edit the footage in /path/to/folder
```

```text
Turn this footage into a polished YouTube video. Add readable captions and an attention-grabbing graphic in the opening to give viewers a strong visual hook.
```

</details>

<details>
<summary><b>Clipping</b></summary>

```text
Can you pull the best 30-second moment from https://youtu.be/MtQ0qxyf-Ds and make a vertical version for social?
```

```text
Make a 15-second version of this launch video. https://x.com/claudeai/status/2045156267690213649
```

</details>

<details>
<summary><b>Video understanding and reasoning</b></summary>

```text
In three bullets, explain what starts the conflict. Include timestamps. https://youtu.be/aqz-KE-bpKQ
```

```text
Name three recurring locations and give one visual cue that distinguishes each. https://youtu.be/dQw4w9WgXcQ
```

</details>

## Compositions as code

A project is a folder of JSX: `open` a folder once (`compound open <dir>` from a shell), then edit the files. Saving recompiles the entry file and mounts it directly into the editor's ECS.

Every element carries an `id`, which is how the write-back finds its target: a rect dragged on the canvas, a clip trimmed on the timeline, or a retyped line lands as a prop on the element that authored it.

The root is a `<stage>` holding one `<scene>` per frame you cut in:

```tsx
import { For } from "solid-js";

const TITLES = [
  { text: "The Grid", start: 0, end: 2.5 },
  { text: "Neon Nights", start: 2.5, end: 5 },
];

export default function Project() {
  return (
    <stage camera={[0.3, 0, 0, 0.3, 85, 150]}>
      <scene name="Intro" width={1920} height={1080} fill="black" active>
        <video src="b-roll/city.mp4" start={0} end={5} width={1920} height={1080} />
        <audio src="music/track.m4a" start={0} end={5} sourceIn={15} />
        <For each={TITLES}>
          {(t) => (
            <text
              width={1920}
              height={1080}
              textAlign="center"
              textBaseline="middle"
              fontSize={128}
              color="#FFFFFF"
              start={t.start}
              end={t.end}
            >
              {t.text}
            </text>
          )}
        </For>
      </scene>
    </stage>
  );
}
```

Everything a mount produces stays a first-class editor node, so a person can pick up in the UI exactly where the script left off.

## Seeing and hearing the media

Cutting footage requires understanding it. The app exposes the inspection tools an agent needs to work with media it cannot watch — as MCP tools, and as the same commands in a shell:

```sh
compound media probe clip.mp4                                # container + codec metadata, like ffprobe
compound media grab clip.mp4 -t 0 12 45                      # decode frames to PNGs
compound media filmstrip clip.mp4                            # grid of video frames
compound media waveform track.mp3                            # audio waveform, silence flagged
compound media transcribe interview.wav                      # timed, word-level transcript
compound media listen interview.mp4 -p "what is said in the intro?"   # ask a multimodal model
compound capture intro -t 0 2 4                              # the frames a render would produce, by scene id
```

Each command is the MCP tool of the same name: `compound media grab` is `media_grab`, `--per-sheet` is `perSheet`.

| Command | Purpose |
| --- | --- |
| `compound projects list` | List the projects the app knows about, with their ids and folders |
| `compound open` | Launch the app and open (or create) a project folder, anywhere on disk |
| `compound context` | Summary of app state |
| `compound capture` | Render frames of a scene, as an export would, to a labelled contact sheet or one PNG per position |
| `compound check` | Check a node's subtree for structural mistakes (black-frame gaps, never-visible nodes, failed sources) and report subtree stats |
| `compound export` | Encode a scene to a video file, the same render the app's export runs |
| `compound library …` | Music and sound effects: `search`, `get`, `resolve`, `import` |
| `compound media …` | Inspect a file by id or path: `probe`, `grab`, `filmstrip`, `waveform`, `transcribe`, `listen` |
| `compound models` / `compound voices` / `compound fonts` | Discover generation models, speech voices, local fonts |
| `compound screenshot` / `compound logs` | The app itself: capture the window, read recent console output |
| `compound whoami` | The authenticated account |
| `compound report` | Report a bug in the tools or the app: diagnostics bundled, filed as a GitHub issue via `gh` |

There is no download command: `yt-dlp` from a shell handles YouTube, TikTok, Instagram and the rest, and a file that lands under the project's `assets/` folder is a library asset.

Conventions throughout: every result is one JSON object, the same structured content the MCP tool returns; errors go to stderr with exit code `1`. Everything is built to be piped, grepped, and driven by a program.

## Documentation

- [Tool reference](docs/reference/tools/README.md): every tool and CLI command, its options, and its output
- [Library](docs/reference/library.md): finding, inspecting, and importing music and sound effects
- [JSX reference](docs/reference/jsx/README.md): the composition markup with elements, timing, paints, and captions
- [Examples](docs/examples/README.md): runnable compositions, from basic scenes to three.js and raw WebGPU
- [Cloud setup](docs/cloud-setup.md): Convex, the Cloudflare Worker, Deepgram, and the secrets they need
- [Releases](docs/releases.md): how a version is cut and published

## Repository layout

| Path | Package | What it is |
| --- | --- | --- |
| `apps/web` | `@compound/web` | The editor UI (Solid + Vite) |
| `apps/desktop` | `@compound/desktop` | Electron shell hosting the editor, and the MCP server |
| `apps/cli` | `@compound/cli` | The `compound` CLI: a client of the app's MCP server |
| `apps/server` | `@compound/server` | The Cloudflare Worker behind transcription and analysis |
| `packages/dapi` | `@compound/dapi` | The tool catalog: every tool's name, input, output, and environment |
| `packages/runtime` | `@compound/runtime` | Headless editor runtime: the koota world, traits, actions, systems, media decoding, capture. No DOM, no Solid |
| `packages/reconciler` | `@compound/reconciler` | Evaluates a compiled project bundle and reconciles its element tree onto runtime entities, via Solid's universal renderer |
| `packages/jsx` | `@compound/jsx` | The authoring API: element vocabulary and types |
| `packages/assets` | `@compound/assets` | A project's asset library: the `assets.yml` manifest, content hashing, probing, resolution |
| `packages/encoder` | `@compound/encoder` | Offline video/audio/image encoding over runtime worlds (mediabunny) |
| `packages/chat` | `@compound/chat` | The embedded T3 Code server behind the in-app chat panel |
| `packages/backend` | `@compound/backend` | Convex functions: auth, the media catalog, transcription jobs |
| `packages/koota-solid` | `@compound/koota-solid` | Solid bindings for koota, ported from `@koota/react` |

## Contributing / local setup

Requirements: Node 22 and Bun 1.3.11. Cloud setup also requires the 1Password CLI and cloudflared; see [cloud setup](docs/cloud-setup.md).

```sh
git clone https://github.com/corporationdev/compound.git
cd compound
bun install

# Set OP_SERVICE_ACCOUNT_TOKEN in root .env; configure the vault fields first.

bun run dev
```

To put `compound` on your PATH (macOS/Homebrew layout; adjust the link target for other setups), link it once:

```sh
bun run --cwd apps/cli symlink:create
```

The link points at the CLI build, which `bun run dev:desktop` refreshes on every start, so the linked `compound` always runs the latest code.

Before sending a PR:

```sh
bun run check    # typecheck all workspaces
bun run lint     # lint all workspaces
```

## License

[MPL-2.0](LICENSE)

Compound uses its own brand assets. See [NOTICE.md](NOTICE.md) for upstream attribution and [the branding audit](docs/branding-audit.md) for compatibility details.
