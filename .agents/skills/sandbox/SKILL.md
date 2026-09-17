---
name: sandbox
description: Run, sign in to, seed, drive, and clean up an isolated Compound stack in a git worktree. Use when you need the app running to verify a change, when a task says to test in the app, or when working in a worktree that is not the main checkout.
---

# Sandbox stages

A linked git worktree of this repo is its own stage. `bun dev` there starts a
full stack that shares nothing with the main checkout or other worktrees: a
local Convex backend, a Worker and R2 bucket in Cloudflare named after the
stage, Vite, and Electron with its own profile. The main checkout is
different: it runs the machine's `dev-` stage against the team's cloud Convex
deployment, and only one of those can run per person.

Everything about a stage follows from its name. Ask for it:

```sh
bun run sandbox:info
```

That prints the stage, its ports, the URLs, the Electron profile path, the
CDP endpoint, and the sign-in code. Read it instead of guessing ports.

## Start

From the worktree root:

```sh
cp ../compound/.env .env          # 1Password token; not in git. T3 Code's setup script does this.
bun install --frozen-lockfile
bun run setup                     # injects secrets, writes runtime config, creates the local Convex
bun dev                           # Convex watch + Worker + tunnel + Vite + Electron
```

`bun dev` is long-running. Start it in the background and wait for the
inspector port from `sandbox:info` to listen before driving the app. It
fails fast if a port is taken; nothing is shared silently.

Requirements on a new machine: Node 20, 22 or 24 first on PATH (the local
Convex backend refuses newer ones; a private install such as
`~/.local/node22/bin` prepended to PATH is enough), Bun 1.3.11, the 1Password
CLI, cloudflared, and the Convex CLI logged in once with `npx convex login`.

### Linux over SSH

Electron needs the desktop session's display. From an SSH shell on a GNOME
Wayland machine, export these before `bun dev`, or Electron exits with
"Missing X server or $DISPLAY":

```sh
export DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland \
  XDG_RUNTIME_DIR=/run/user/$(id -u) \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus \
  ELECTRON_OZONE_PLATFORM_HINT=auto \
  XAUTHORITY=$(ls /run/user/$(id -u)/.mutter-Xwaylandauth.* | head -1)
```

Start the stack detached so it outlives the SSH session, and keep its log:

```sh
nohup bun dev > /tmp/dev-sandbox.log 2>&1 < /dev/null &
```

Main-process output only reaches that log. Drive the app from another
machine by forwarding the inspector port, then attach as usual:

```sh
ssh -N -L 22904:127.0.0.1:22904 thinkpad &      # port from sandbox:info on the remote
agent-browser connect 22904
```

A machine already running `bun dev:client` for someone's dev stage is fine;
the sandbox uses its own ports and profile.

## Sign in

Developer stages accept the fixed code `000000` for any email address and
never send mail. Sign in as `agent@compound.mov` unless the task says
otherwise. Production and preview stages still email the code.

## Seed

With `bun dev` running:

```sh
bun run sandbox:seed
```

Signs in as `agent@compound.mov` (creating the user and their personal
organization), then writes one project, `projects/sample`, into that
organization's workspace through Convex. The desktop checks it out into the
stage's projects folder on its next sync. The composition is
`docs/examples/01-basics.tsx`; its media are public URLs, so nothing is
uploaded. Rerunning is safe.

## Drive the app

The desktop runs with a Chromium remote debugging port. Attach with
agent-browser, which needs version 0.38 or newer:

```sh
PORT=$(bun run sandbox:info | jq -r .ports.inspector)
agent-browser --cdp $PORT snapshot          # accessibility tree with element refs
agent-browser --cdp $PORT click @e12
agent-browser --cdp $PORT fill @e7 "agent@compound.mov"
agent-browser --cdp $PORT screenshot /tmp/after.png
```

CDP sees only the renderer. Native file dialogs, menus, and OS notifications
are out of reach; open projects with the `compound` CLI or the app's
project commands instead of the picker.

## Clean up

From the worktree, when the branch is done:

```sh
bun run sandbox:clean             # destroys the stage's Cloudflare resources, local Convex data, profile, projects folder
cd .. && git worktree remove <worktree>
```

`--keep-cloud` skips the Cloudflare part. The main checkout's `dev-` stage
must never be cleaned this way; the script refuses non-sandbox stages.

## How it fits together

- `packages/config/src/stage.ts` resolves the stage: `dev-<user>-<hash>` in the main checkout, `sandbox-<worktree>-<hash>` in a linked worktree.
- `packages/config/src/ports.ts` derives the port block from the stage name.
- `scripts/backend.ts` runs Convex locally for sandbox stages; state lives in `packages/backend/.convex/`.
- `scripts/dev-desktop.mjs` starts Electron with the stage's profile, inspector port, and Vite URL.
- `packages/backend/convex/auth.ts` issues the fixed sign-in code on developer stages.
- Details: `docs/cloud-setup.md`, section "Worktrees: one sandbox stage each".
