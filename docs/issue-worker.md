# The issue-to-PR loop

How a GitHub issue on `corporationdev/compound` becomes a pull request, without
anyone opening a terminal. Setup and internals: `docs/cloud-setup.md`, section
"Issues to T3 Code threads".

1. Someone labels an issue `ready`. Its body is the plan. The repository is public, so the worker only takes issues whose author is in the organization or a repository collaborator; others are skipped and logged.
2. The issue worker on the ThinkPad (`bun run issue-worker`, running as a user
   service) checks every minute and picks the issue up.
3. The worker moves the label to `in-progress`, creates a worktree on the branch
   `issue/<number>-<slug>`, and starts a T3 Code thread whose first message is
   the issue. It comments the branch and thread id on the issue.
4. The thread's agent follows the `issue-worker` skill
   (`.agents/skills/issue-worker/SKILL.md`): it implements the issue, verifies
   it (checks, tests, and the app in a sandbox when the change is visible
   there), opens a PR that says `Closes #<number>`, and moves the label to
   `in-review`. If it is blocked it comments on the issue and stops.
5. Review the PR. Merging it closes the issue.

## Labels

| Label         | Meaning                                              |
| ------------- | ---------------------------------------------------- |
| `ready`       | Planned and waiting; the worker will pick it up.     |
| `in-progress` | A thread is working on it (at most three at a time). |
| `in-review`   | A PR is open; the thread is done.                    |

## After the code: review, preview, evidence

The thread's agent pushes to a draft PR as it works, then leaves draft when
confident. CodeRabbit reviews at that point (`.coderabbit.yaml` skips drafts).
The agent closes out every review thread, fixing or explicitly declining with
a reason, and re-requests review until nothing is unresolved and CI is green.
Then it asks for the **Prepare PR** workflow with a label (`bun run pr prepare <n>
--platforms linux`), which deploys the PR's preview stage on request and
builds a Linux installer against it. It launches that installer with a
debugging port (`bun run pr app`), records a walkthrough with agent-browser,
and attaches the recording to the PR's draft release (`bun run pr evidence`), next to the installers. Finally it asks
for the macOS installer so a person can try the build, and moves the issue to
`in-review`. A person merges. Nothing is deployed on push; previews exist only
when asked for, and Teardown Preview removes them when the PR closes.

`bun run pr status <n>` is the one command for the PR's checks, reviews,
unresolved threads, and Prepare PR runs, as JSON.
