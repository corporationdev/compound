/**
 * Turns GitHub issues labeled `ready` into T3 Code threads on this machine.
 *
 * Every minute: list open `ready` issues, claim up to the free slots (at most
 * three `in-progress` at once) by moving the label to `in-progress`, start a
 * T3 Code thread in a new worktree on `issue/<number>-<slug>` whose first
 * message is the issue, and comment the branch and thread id on the issue. A
 * failed start puts the label back to `ready` with a comment saying why.
 *
 *   bun run issue-worker [--once] [--base main] [--model claudeAgent:claude-fable-5-1]
 *
 * An issue maps to one fixed thread id, so a thread that already exists in
 * T3 Code is never started twice, even across restarts.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { deterministicId, projectScriptsFromT3Json, T3Code, type ModelSelection, type ShellProject } from './lib/t3code.ts';

export const REPO = 'corporationdev/compound';
export const MAX_IN_PROGRESS = 3;
export const LABELS = {
  ready: { color: '0e8a16', description: 'Planned and ready for the issue worker to pick up' },
  'in-progress': { color: 'fbca04', description: 'Claimed by the issue worker; a T3 Code thread is implementing it' },
  'in-review': { color: '1d76db', description: 'Implemented; a pull request is open' },
} as const;

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** GitHub's relation of the issue's author to the repository: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ... */
  authorAssociation: string;
  author: string;
}

/** Only people inside the organization, or invited to the repository, can hand the worker work. */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const isTrustedAuthor = (issue: Pick<Issue, 'authorAssociation'>) => TRUSTED_ASSOCIATIONS.has(issue.authorAssociation);

/** `issue/<number>-<slug>`: lowercase ASCII words from the title, at most 48 characters of slug. */
export function branchName(number: number, title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let slug = words;
  if (slug.length > 48) {
    slug = slug.slice(0, 48);
    // Cut at a word boundary when there is one.
    slug = slug.includes('-') && words[48] !== '-' ? slug.slice(0, slug.lastIndexOf('-')) : slug.replace(/-+$/, '');
  }
  return slug ? `issue/${number}-${slug}` : `issue/${number}`;
}

/** The T3 Code thread id an issue always maps to. */
export function threadIdFor(number: number): string {
  return deterministicId('thread', `${REPO}#${number}`);
}

export type Skip = { issue: Issue; reason: string };

/**
 * Which `ready` issues to claim now. Only issues written by someone in the
 * organization (or a repository collaborator); anyone can label, but the work
 * itself must come from inside. Oldest first, never more than the free slots,
 * never one that already carries a later label, already has a thread, or was
 * claimed earlier by this process.
 */
export function planClaims(input: {
  ready: Issue[];
  inProgressCount: number;
  started: ReadonlySet<number>;
  max?: number;
}): { claim: Issue[]; skip: Skip[] } {
  let slots = Math.max(0, (input.max ?? MAX_IN_PROGRESS) - input.inProgressCount);
  const claim: Issue[] = [];
  const skip: Skip[] = [];
  const seen = new Set<number>();
  for (const issue of [...input.ready].sort((a, b) => a.number - b.number)) {
    if (seen.has(issue.number)) continue;
    seen.add(issue.number);
    const later = issue.labels.find((label) => label === 'in-progress' || label === 'in-review');
    if (!isTrustedAuthor(issue)) skip.push({ issue, reason: `author ${issue.author} is ${issue.authorAssociation}, not in the organization` });
    else if (later) skip.push({ issue, reason: `also labeled ${later}` });
    else if (input.started.has(issue.number)) skip.push({ issue, reason: 'already has a thread' });
    else if (slots === 0) skip.push({ issue, reason: `${MAX_IN_PROGRESS} issues already in progress` });
    else {
      claim.push(issue);
      slots--;
    }
  }
  return { claim, skip };
}

/** A comment a person left on the issue or its pull request, as the worker sees it. */
export interface Feedback {
  id: string;
  url: string;
  author: string;
  authorAssociation: string;
  body: string;
  createdAt: string;
  /** Where it was left: the issue, the PR conversation, a review body, or a review comment on a file. */
  where: 'issue' | 'pr' | 'review' | 'review-comment';
  path?: string;
  line?: number | null;
}

/**
 * Which comments to forward to the thread now: from people in the
 * organization, not from the worker's own account (the thread's agent uses
 * it too), not bots, newer than the thread, and not forwarded before.
 */
export function selectFeedback(input: { comments: Feedback[]; workerLogin: string; since: string; forwarded: ReadonlySet<string> }): Feedback[] {
  return input.comments
    .filter((c) => TRUSTED_ASSOCIATIONS.has(c.authorAssociation))
    .filter((c) => c.author !== input.workerLogin && !c.author.endsWith('[bot]'))
    .filter((c) => c.createdAt > input.since && !input.forwarded.has(c.id))
    .filter((c) => c.body.trim().length > 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The message the thread gets for a comment: who, where, then the comment itself. */
export function feedbackMessage(issueNumber: number, feedback: Feedback): string {
  const place = feedback.where === 'issue' ? `issue #${issueNumber}`
    : feedback.where === 'review-comment' ? `the pull request, on \`${feedback.path}\`${feedback.line ? ` line ${feedback.line}` : ''}`
    : feedback.where === 'review' ? 'the pull request, as a review' : 'the pull request';
  return [
    `Feedback from @${feedback.author} on ${place} (${feedback.url}). Treat it as a change to the plan: act on it, reply on GitHub where they wrote it when a reply is needed, and continue.`,
    '',
    feedback.body.trim(),
  ].join('\n');
}

/** The thread's first message: which skill to use, then the issue itself. */
export function firstMessage(issue: Issue, branch: string, base: string): string {
  return [
    `Use the issue-worker skill (.agents/skills/issue-worker/SKILL.md).`,
    ``,
    `You are working on issue #${issue.number} of ${REPO} in a worktree on branch \`${branch}\`, created from \`${base}\`. Open the pull request against \`${base}\`.`,
    ``,
    `# ${issue.title}`,
    ``,
    issue.body.trim() || '(no description)',
  ].join('\n');
}

function log(message: string) {
  console.log(`${new Date().toISOString()} ${message}`);
}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(['gh', ...args, '-R', REPO], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr.trim() || stdout.trim()}`);
  return stdout;
}

async function listIssues(label: string): Promise<Issue[]> {
  const raw = JSON.parse(await gh(['issue', 'list', '--state', 'open', '--label', label, '--limit', '100', '--json', 'number,title,body,labels,author,authorAssociation'])) as {
    number: number;
    title: string;
    body: string;
    labels: { name: string }[];
    author: { login: string };
    authorAssociation: string;
  }[];
  return raw.map((issue) => ({ ...issue, labels: issue.labels.map((l) => l.name), author: issue.author.login }));
}

async function ensureLabels() {
  const existing = new Set(
    (JSON.parse(await gh(['label', 'list', '--limit', '200', '--json', 'name'])) as { name: string }[]).map((l) => l.name),
  );
  for (const [name, { color, description }] of Object.entries(LABELS)) {
    if (existing.has(name)) continue;
    await gh(['label', 'create', name, '--color', color, '--description', description]);
    log(`created label ${name}`);
  }
}

async function comment(number: number, body: string) {
  await gh(['issue', 'comment', String(number), '--body', body]);
}

const FORWARDED_FILE = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'compound-issue-worker', 'forwarded.json');
function readForwarded(): Set<string> {
  try { return new Set(JSON.parse(readFileSync(FORWARDED_FILE, 'utf8')) as string[]); } catch { return new Set(); }
}
function writeForwarded(forwarded: Set<string>) {
  mkdirSync(join(FORWARDED_FILE, '..'), { recursive: true });
  writeFileSync(FORWARDED_FILE, JSON.stringify([...forwarded]));
}

type RawComment = { id: number; html_url: string; user: { login: string; type: string }; author_association: string; body: string | null; created_at: string; path?: string; line?: number | null; submitted_at?: string };
const api = async (path: string) => JSON.parse(await gh(['api', `repos/${REPO}/${path}`, '--paginate'])) as RawComment[];
const toFeedback = (where: Feedback['where']) => (c: RawComment): Feedback => ({
  id: `${where}:${c.id}`, url: c.html_url, author: c.user.login, authorAssociation: c.author_association,
  body: c.body ?? '', createdAt: c.created_at ?? c.submitted_at ?? '', where, path: c.path, line: c.line,
});

/** Everything people have written on the issue and on its pull request, if one exists. */
async function collectFeedback(issue: Issue): Promise<Feedback[]> {
  const comments = (await api(`issues/${issue.number}/comments`)).map(toFeedback('issue'));
  const branch = branchName(issue.number, issue.title);
  const prs = JSON.parse(await gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number', '--limit', '1'])) as { number: number }[];
  const pr = prs[0]?.number;
  if (!pr) return comments;
  const [conversation, reviews, reviewComments] = await Promise.all([
    api(`issues/${pr}/comments`),
    api(`pulls/${pr}/reviews`),
    api(`pulls/${pr}/comments`),
  ]);
  return [
    ...comments,
    ...conversation.map(toFeedback('pr')),
    ...reviews.filter((r) => r.body).map((r) => toFeedback('review')({ ...r, created_at: r.submitted_at ?? '' })),
    ...reviewComments.map(toFeedback('review-comment')),
  ];
}

/** The reaction that shows a comment reached the thread; the file is what stops it going twice. */
async function markForwarded(feedback: Feedback) {
  const [where, id] = feedback.id.split(':');
  const path = where === 'review-comment' ? `pulls/comments/${id}` : where === 'review' ? null : `issues/comments/${id}`;
  if (path) await gh(['api', '-X', 'POST', `repos/${REPO}/${path}/reactions`, '-f', 'content=eyes']).catch(() => undefined);
}

/**
 * Route new comments from people to the threads working on them. A thread
 * that is mid-turn is left alone; the comment waits for the next tick.
 */
async function forwardFeedback(t3: T3Code, workerLogin: string, reported: Set<string>) {
  const issues = [...(await listIssues('in-progress')), ...(await listIssues('in-review'))];
  const forwarded = readForwarded();
  for (const issue of issues) {
    const thread = await t3.thread(threadIdFor(issue.number));
    if (!thread) continue;
    const since = thread.messages[0]?.createdAt ?? '';
    const pending = selectFeedback({ comments: await collectFeedback(issue), workerLogin, since, forwarded });
    if (pending.length === 0) continue;
    if (thread.latestTurn && !['completed', 'failed', 'cancelled', 'interrupted', 'idle'].includes(thread.latestTurn.state)) {
      const key = `${issue.number}:busy`;
      if (!reported.has(key)) log(`#${issue.number} has ${pending.length} comment(s) waiting; thread turn is ${thread.latestTurn.state}`);
      reported.add(key);
      continue;
    }
    reported.delete(`${issue.number}:busy`);
    for (const feedback of pending) {
      await t3.sendMessage(thread.id, feedbackMessage(issue.number, feedback), thread.modelSelection);
      forwarded.add(feedback.id);
      writeForwarded(forwarded);
      await markForwarded(feedback);
      log(`#${issue.number} forwarded ${feedback.where} comment by @${feedback.author} to thread ${thread.id}`);
    }
  }
}

/**
 * The Compound project in T3 Code, with a worktree setup script. T3 Code
 * 0.0.40 runs the project's stored scripts, not the checked-in `t3.json`, so a
 * project without any gets the ones from `t3.json`.
 */
async function compoundProject(t3: T3Code): Promise<ShellProject> {
  const projects = await t3.projects();
  const project =
    projects.find((p) => process.env.ISSUE_WORKER_PROJECT_ROOT && p.workspaceRoot === process.env.ISSUE_WORKER_PROJECT_ROOT) ??
    projects.find((p) => p.title === 'compound');
  if (!project) throw new Error('the compound project is not registered in T3 Code; add ~/code/compound in the app');
  if (project.scripts.some((s) => s.runOnWorktreeCreate)) return project;
  if (project.scripts.length > 0) throw new Error(`T3 Code project ${project.title} has scripts but none runs on worktree creation`);
  const scripts = projectScriptsFromT3Json(readFileSync(join(import.meta.dir, '..', 't3.json'), 'utf8'));
  await t3.setProjectScripts(project.id, scripts);
  log(`set T3 Code project ${project.title} scripts from t3.json: ${scripts.map((s) => s.name).join(', ')}`);
  return { ...project, scripts };
}

interface Options {
  base: string;
  model: ModelSelection;
  /** The GitHub account the worker and its threads act as; its own comments are never fed back. */
  login: string;
}

/** Claims issue by issue: label, thread, comment; or put it back. */
async function claim(t3: T3Code, project: ShellProject, issue: Issue, options: Options, claimed: Set<number>) {
  const branch = branchName(issue.number, issue.title);
  const threadId = threadIdFor(issue.number);
  claimed.add(issue.number);
  await gh(['issue', 'edit', String(issue.number), '--remove-label', 'ready', '--add-label', 'in-progress']);
  log(`#${issue.number} labeled in-progress`);
  try {
    await t3.startThreadInNewWorktree({
      threadId,
      project,
      title: `#${issue.number} ${issue.title}`,
      branch,
      baseBranch: options.base,
      text: firstMessage(issue, branch, options.base),
      modelSelection: options.model,
    });
  } catch (error) {
    // A reply can be lost after the server did the work; the thread is the truth.
    if (!(await t3.thread(threadId).catch(() => null))) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`#${issue.number} thread failed to start: ${reason}`);
      await gh(['issue', 'edit', String(issue.number), '--remove-label', 'in-progress', '--add-label', 'ready']);
      log(`#${issue.number} labeled ready again`);
      await comment(issue.number, `The issue worker could not start a T3 Code thread for this issue, so it is back to \`ready\`.\n\n\`\`\`\n${reason}\n\`\`\``);
      log(`#${issue.number} commented failure`);
      return;
    }
  }
  const thread = await t3.thread(threadId).catch(() => null);
  log(`#${issue.number} started T3 Code thread ${threadId} on ${branch}${thread?.worktreePath ? ` in ${thread.worktreePath}` : ''}`);
  await comment(
    issue.number,
    [
      `The issue worker started a T3 Code thread for this issue.`,
      ``,
      `- Branch: \`${branch}\` (from \`${options.base}\`)`,
      `- Thread: \`${threadId}\``,
      ...(thread?.worktreePath ? [`- Worktree: \`${thread.worktreePath}\``] : []),
    ].join('\n'),
  );
  log(`#${issue.number} commented branch and thread`);
}

async function tick(options: Options, claimed: Set<number>, reported: Set<string>) {
  const t3 = await T3Code.connect();
  await forwardFeedback(t3, options.login, reported);
  const [ready, inProgress] = await Promise.all([listIssues('ready'), listIssues('in-progress')]);
  if (ready.length === 0) return;
  const started = new Set(claimed);
  for (const issue of ready) if (await t3.thread(threadIdFor(issue.number))) started.add(issue.number);
  const plan = planClaims({ ready, inProgressCount: inProgress.length, started });
  for (const { issue, reason } of plan.skip) {
    const key = `${issue.number}:${reason}`;
    if (!reported.has(key)) log(`#${issue.number} skipped: ${reason}`);
    reported.add(key);
  }
  if (plan.claim.length === 0) return;
  const project = await compoundProject(t3);
  for (const issue of plan.claim) await claim(t3, project, issue, options, claimed);
}

/** One worker per machine: a second one could claim the same issue in the same minute. */
function lock(): () => void {
  const path = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), 'compound-issue-worker.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => unlinkSync(path);
    } catch {
      const pid = Number(readFileSync(path, 'utf8'));
      try {
        process.kill(pid, 0);
        throw new Error(`another issue worker is running (pid ${pid}, ${path})`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        unlinkSync(path);
      }
    }
  }
  throw new Error(`could not take ${path}`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      once: { type: 'boolean', default: false },
      base: { type: 'string', default: process.env.ISSUE_WORKER_BASE ?? 'main' },
      model: { type: 'string', default: process.env.ISSUE_WORKER_MODEL ?? 'claudeAgent:claude-fable-5-1' },
    },
  });
  const [instanceId, model] = values.model.split(':');
  if (!instanceId || !model) throw new Error('--model is <provider instance>:<model>, e.g. claudeAgent:claude-fable-5-1');
  const login = (await gh(['api', 'user', '--jq', '.login'])).trim();
  const options: Options = { base: values.base, model: { instanceId, model }, login };
  const unlock = lock();
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  process.on('exit', unlock);

  log(`issue worker for ${REPO} as @${login}: base ${options.base}, model ${values.model}${values.once ? ', once' : ''}`);
  await ensureLabels();
  const claimed = new Set<number>();
  const reported = new Set<string>();
  for (;;) {
    try {
      await tick(options, claimed, reported);
    } catch (error) {
      log(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
      if (values.once) process.exit(1);
    }
    if (values.once) break;
    await Bun.sleep(60_000);
  }
}
