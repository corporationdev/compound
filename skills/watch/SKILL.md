---
name: watch
description: Inspect video or audio with Compound's compound CLI to summarize footage, locate moments, and verify what happens or is said.
---

# Watch footage with Compound

Use `compound --help`, `compound media --help`, and `compound context` to inspect the installed CLI and current project. The Compound desktop app must be running. Its CLI accepts media asset IDs and local paths; consult `.compound/docs/reference/README.md` in a project, or the repository's `reference/README.md`, for the relevant media command.

Probe the file first. Inspect representative frames with `media grab` or `media filmstrip`; use `media transcribe` for timed speech and `media listen` for questions that depend on audio. Read the command-specific help before supplying options. Transcription and media understanding need a signed-in Compound account with configured cloud services.

Ground descriptions in the frames and audio actually inspected. Return timestamps for located moments, distinguish dialogue from visual observations, and note coverage limits when sampling a long clip. Media inspection does not require changing the composition or exporting a new video.
