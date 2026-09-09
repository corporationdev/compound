---
name: editor
description: Create and edit video compositions in Compound using the compound CLI and SolidJS project source. Use for editing footage, captions, motion graphics, and exporting a Compound project.
---

# Compound editor

Compound runs locally and exposes the `compound` CLI. Start with `compound --help` and `compound context` to discover the installed commands and current project. Use `compound open <folder>` to open or scaffold the user's chosen project.

Read the project's `AGENTS.md` and `.compound/docs/reference/README.md`. Read `.compound/docs/reference/jsx/README.md` before editing its composition source. Those versioned references describe the installed editor; repository copies live at `reference/` and examples at `examples/`.

The composition is SolidJS source using `@compound/jsx`. Save edits in the project files; the app recompiles them automatically. Inspect scene and element IDs through the CLI before capturing or exporting. Use the installed reference for command syntax and timing units.

Preserve existing edits and source media. Verify the result with `compound capture` for representative frames and `compound export` for the requested output. Report actual output paths. Automatic captions, transcription, and media understanding require the configured Compound cloud account; image, video, music, and voice generation are currently unavailable.
