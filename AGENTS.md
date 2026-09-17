# Working in this repository

Compound is an Electron video editor with a Convex backend and a Cloudflare
Worker. `bun run check` typechecks everything; `bun test <path>` runs tests.

- Skills live in `.agents/skills/` (the cross-tool location; `.claude/skills/` symlinks into it for Claude Code). To run the app and verify a change in it, use the `sandbox` skill: worktree stages, sign-in, seeding, driving the app, and cleanup.
- Cloud, stages, and secrets: `docs/cloud-setup.md`.
- The `docs/skills/` folder is for agents working *inside* Compound on video projects, not for developing Compound.
