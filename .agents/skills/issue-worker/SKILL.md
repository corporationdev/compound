---
name: issue-worker
description: Implement one GitHub issue that the issue worker assigned to this thread, verify it in the app, and open a pull request. Use when a thread's first message names the issue-worker skill, or when working in a worktree on an `issue/<number>-<slug>` branch.
---

# Implementing an assigned issue

The issue worker (`scripts/issue-worker.ts`) picked a GitHub issue labeled
`ready` on `corporationdev/compound`, labeled it `in-progress`, and started
this T3 Code thread in a new worktree created for exactly that issue. The
first message names the issue number, the branch (`issue/<number>-<slug>`)
and the base branch it was created from, then gives the issue's title and
body. The issue is a plan someone already agreed to; implement it, do not
redesign it.

## 1. Read the issue

```sh
gh issue view <number> -R corporationdev/compound --comments
```

The body on GitHub is the source of truth if it changed after the thread
started. Check you are where you should be:

```sh
git branch --show-current          # issue/<number>-<slug>
git rev-parse --show-toplevel      # this worktree, not ~/code/compound
```

## 2. Wait for setup

When T3 Code created the worktree it started the project's setup script
(`t3.json`: copy `.env` from the main checkout, `bun install --frozen-lockfile`,
`bun run setup`) in this thread's setup terminal. It may still be running when
you start. Do not run a second install beside it. It is finished when no
`bun` process has this worktree as its working directory:

```sh
for p in $(pgrep bun); do readlink /proc/$p/cwd; done | grep -Fx "$PWD"
```

If it finished but `.env` or `node_modules` is missing, the script failed; run
the three steps yourself.

## 3. Implement and verify

Make the change the issue asks for, following `AGENTS.md`. Then:

- `bun run check`, and `bun test <path>` for tests near what you touched.
- When the change is visible in the app, verify it there with the `sandbox`
  skill (`.agents/skills/sandbox/SKILL.md`): `bun dev` detached, sign in,
  seed, drive it with agent-browser, screenshot the result. A docs-only or
  script-only change needs no app run; say so in the PR.

Commit with clear messages as you go.

## 4. Open the pull request

```sh
git push -u origin HEAD
gh pr create -R corporationdev/compound --base <base branch from the first message> \
  --title "<issue title>" --body "Closes #<number>

<what changed and how it was verified>"
gh issue edit <number> -R corporationdev/compound --remove-label in-progress --add-label in-review
```

Clean up the sandbox stage when you ran one (`bun run sandbox:clean`), but
leave the worktree; T3 Code owns it.

## Rules

- This worktree and branch are for this one issue. Do not check out, commit to,
  push, or delete any other branch, and do not touch other worktrees or the main
  checkout in `~/code/compound`.
- Do not rebase onto or merge `main`, and do not force-push.
- Do not claim, label, or comment on other issues, and do not change labels on
  this one except `in-progress` to `in-review` at the end.
- Do not run plain `bun dev` in `~/code/compound`; it repoints the shared cloud
  Convex. In this worktree it is a sandbox and fine.

## If blocked

When the issue is ambiguous, contradicts the code, needs a secret or a decision
you do not have, or verification cannot pass, stop instead of guessing:

```sh
gh issue comment <number> -R corporationdev/compound --body "Blocked: <what, what you tried, what is needed>"
```

Leave the label at `in-progress`, push any useful work on the branch, and end
the turn with the same explanation.
