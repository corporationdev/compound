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

## 3. Implement, and push as you go

Make the change the issue asks for, following `AGENTS.md`. Open a **draft**
pull request early and push every meaningful commit to it: CI runs on each
push and tells you about failures while they are cheap, and the branch is
safe if the thread dies. CodeRabbit does not review drafts, so pushing often
costs nothing.

```sh
git push -u origin HEAD
gh pr create -R corporationdev/compound --draft --base <base branch from the first message> \
  --title "<issue title>" --body "Closes #<number>

<what is changing>"
```

Verify in your sandbox as you work, not at the end: `bun run check`, tests
near what you touched, and when the change is visible in the app, the
`sandbox` skill (`bun dev` detached, sign in, seed, drive it with
agent-browser). A docs-only or script-only change needs no app run.

## 4. Close out the review

When you are confident, leave draft. That is the one moment CodeRabbit
reviews, and the moment CI must be green.

```sh
bun run pr ready <number>
bun run pr wait-checks <number>
bun run pr status <number>
```

`status` prints the checks, the reviews, and every unresolved review thread
with its id, file, line, and text. Work through them until there are none.
For each thread either fix it and push, or, when you think it is wrong or not
worth doing, say why in one or two sentences and resolve it; both are fine,
silence is not:

```sh
bun run pr resolve <thread id> --reply "Fixed in <sha>."
bun run pr resolve <thread id> --reply "Leaving as is: <reason>."
```

After pushing fixes, ask for another pass and wait for it, then check again:

```sh
bun run pr request-review <number>
bun run pr wait-checks <number>
```

There is no round limit. Keep going until `status` shows zero unresolved
threads, no pending or failed checks, and CodeRabbit's latest review is on the
current head. Then also fix the PR description so it describes the final
change.

## 5. Prove it on the preview

With review and CI green, ask CI to deploy the pull request's preview stage
and build the Linux installer against it. Nothing is deployed until you ask.

```sh
bun run pr prepare <number> --platforms linux --wait
```

That takes ten to twenty minutes. When it finishes, fetch and launch the
installer here on the ThinkPad; it opens with a remote debugging port and its
own profile, pointed at the preview's Convex, Worker, and bucket:

```sh
bun run pr app <number> --platform linux      # prints cdpPort
agent-browser connect <cdpPort>
agent-browser record start /tmp/pr-<number>.webm
```

Sign in with any email and `000000`, walk through what the issue asked for
so that each acceptance criterion is visibly exercised, and take a screenshot
of the end state. Keep the recording under three minutes. Then:

```sh
agent-browser record stop
agent-browser screenshot /tmp/pr-<number>-final.png
bun run pr app-stop <number>
bun run pr evidence <number> /tmp/pr-<number>.webm /tmp/pr-<number>-final.png \
  --body "<one paragraph: what the recording shows, and a checklist of the issue's criteria with pass/fail>"
```

`evidence` uploads the files to the public evidence bucket under `pr-<number>/`,
next to the installers, and comments links that play in the browser. If the preview shows a bug, fix it, push, and go back to
step 4; the review loop reruns and `prepare` refreshes the same preview.

## 6. Hand it over

Ask CI for the macOS installer so a person can try it on a Mac, then mark the
issue for review. Do not merge; a person merges after watching the recording.

```sh
bun run pr prepare <number> --platforms mac
gh issue edit <number> -R corporationdev/compound --remove-label in-progress --add-label in-review
```

End the turn with a short summary: the PR link, what the recording shows,
and anything you left for the reviewer to decide. Clean up your sandbox stage
(`bun run sandbox:clean`) but leave the worktree; T3 Code owns it.

## Feedback while you work

When someone in the organization comments on the issue or on your pull
request, the worker forwards it into this thread as a message that starts
with "Feedback from @…" and marks the comment with an eyes reaction. Treat
it as a change to the plan: act on it, reply on GitHub where they wrote it
when a reply is needed, and continue from wherever you were. It arrives
between your turns, so finish what you are doing at a sensible point; nothing
is lost while a turn is running.

## Rules

- This worktree and branch are for this one issue. Do not check out, commit to,
  push, or delete any other branch, and do not touch other worktrees or the main
  checkout in `~/code/compound`.
- Do not rebase onto or merge `main`, and do not force-push.
- Do not claim, label, or comment on other issues, and do not change labels on
  this one except `in-progress` to `in-review` at the end.
- Do not merge the pull request, and do not publish the evidence release.
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
