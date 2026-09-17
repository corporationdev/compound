# The issue-to-PR loop

How a GitHub issue on `corporationdev/compound` becomes a pull request, without
anyone opening a terminal. Setup and internals: `docs/cloud-setup.md`, section
"Issues to T3 Code threads".

1. Someone labels an issue `ready`. Its body is the plan.
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
