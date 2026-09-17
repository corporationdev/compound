import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { evidence } from '@compound/config/evidence';
import { adoptDesktopSession } from './desktop-session.mjs';
import { evidenceStore } from './lib/evidence-store';

// One command for everything an agent does with a pull request after the code
// is written: see its state, close out review threads, ask CI to prepare a
// preview and installers, fetch and launch an installer for agent-browser,
// and attach evidence. Every subcommand prints JSON so the output can be read
// by a script or an agent without parsing prose.
//
//   bun run pr status <number>                    checks, reviews, unresolved threads, prepare runs
//   bun run pr ready <number>                     leave draft; CodeRabbit reviews at this point
//   bun run pr resolve <thread id> --reply "..."  answer a review thread and resolve it
//   bun run pr request-review <number>            ask CodeRabbit for another pass
//   bun run pr wait-checks <number>               block until every check has finished
//   bun run pr prepare <number> --platforms linux|mac|both|none [--wait]
//   bun run pr app <number> --platform linux|mac  fetch the installer from the evidence bucket, launch it with a debugging port
//   bun run pr app-stop <number>
//   bun run pr evidence <number> <file>... [--body "..."]   upload files to the evidence bucket and comment their links
export const REPO = process.env.COMPOUND_REPO ?? 'corporationdev/compound';
const WORKFLOW_NAME = 'Prepare PR';
const PREPARE_LABELS = ['linux', 'mac', 'both', 'none'] as const;
const APPS = join(homedir(), '.cache', 'compound', 'pr-apps');

function gh(args: string[], input?: string): string {
  const result = spawnSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}
const graphql = (query: string, variables: Record<string, unknown>) =>
  JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, ...Object.entries(variables).flatMap(([k, v]) => [typeof v === 'number' ? '-F' : '-f', `${k}=${v}`])]));
const [owner, name] = REPO.split('/') as [string, string];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Thread { id: string; path: string; line: number | null; author: string; body: string; url: string; isOutdated: boolean }
export async function status(number: number) {
  const data = graphql(`query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){
    number title state isDraft mergeable headRefName headRefOid baseRefName url
    commits(last:1){ nodes{ commit{ statusCheckRollup{ state contexts(first:50){ nodes{ __typename ... on CheckRun{ name status conclusion detailsUrl } ... on StatusContext{ context state targetUrl } } } } } } }
    reviews(last:50){ nodes{ author{ login } state submittedAt commit{ abbreviatedOid } } }
    reviewThreads(first:100){ nodes{ id isResolved isOutdated path line comments(first:1){ nodes{ author{ login } body url } } } }
  } } }`, { owner, name, number }).data.repository.pullRequest;
  const rollup = data.commits.nodes[0]?.commit.statusCheckRollup;
  const checks = (rollup?.contexts.nodes ?? []).map((c: Record<string, string>) => c.__typename === 'CheckRun'
    ? { name: c.name, status: c.status, conclusion: c.conclusion, url: c.detailsUrl }
    : { name: c.context, status: 'COMPLETED', conclusion: c.state, url: c.targetUrl });
  const reviews: Record<string, { state: string; commit: string; submittedAt: string }> = {};
  for (const r of data.reviews.nodes) reviews[r.author.login] = { state: r.state, commit: r.commit?.abbreviatedOid, submittedAt: r.submittedAt };
  const unresolved: Thread[] = data.reviewThreads.nodes.filter((t: { isResolved: boolean }) => !t.isResolved).map((t: Record<string, unknown> & { comments: { nodes: Record<string, unknown>[] } }) => {
    const first = t.comments.nodes[0] as { author: { login: string }; body: string; url: string } | undefined;
    return { id: t.id, path: t.path, line: t.line, isOutdated: t.isOutdated, author: first?.author.login ?? '', body: first?.body ?? '', url: first?.url ?? '' };
  });
  const runs = prepareRuns(data.headRefName).filter((r) => r.headSha === data.headRefOid);
  return {
    number: data.number, title: data.title, state: data.state, isDraft: data.isDraft, mergeable: data.mergeable, url: data.url,
    head: { ref: data.headRefName, sha: data.headRefOid }, base: data.baseRefName,
    checks: { state: rollup?.state ?? 'NONE', pending: checks.filter((c: { status: string }) => c.status !== 'COMPLETED').length, failed: checks.filter((c: { conclusion: string }) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c.conclusion)).length, runs: checks },
    reviews, unresolvedThreads: unresolved, prepareRuns: runs,
  };
}
type PrepareRun = { databaseId: number; status: string; conclusion: string; headSha: string; createdAt: string; url: string; workflowName: string };
/** Runs of Prepare PR on a branch. Listed by branch, not by workflow file: GitHub only resolves a workflow file once it is on the default branch. */
function prepareRuns(branch: string): PrepareRun[] {
  return (JSON.parse(gh(['run', 'list', '-R', REPO, '--branch', branch, '--json', 'databaseId,status,conclusion,headSha,createdAt,url,workflowName', '--limit', '30'])) as PrepareRun[])
    .filter((r) => r.workflowName === WORKFLOW_NAME);
}
export function resolveThread(id: string, reply?: string) {
  if (reply) graphql(`mutation($id:ID!,$body:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}){ comment{ url } } }`, { id, body: reply });
  graphql(`mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`, { id });
  return { id, resolved: true, replied: Boolean(reply) };
}
export async function waitChecks(number: number, intervalMs = 30000) {
  for (;;) {
    const s = await status(number);
    if (s.checks.runs.length > 0 && s.checks.pending === 0) return s.checks;
    await sleep(intervalMs);
  }
}
/** The request is a label; the workflow runs from the PR's branch and removes the label when done. */
export async function prepare(number: number, platforms: string, wait: boolean) {
  if (!(PREPARE_LABELS as readonly string[]).includes(platforms)) throw new Error(`--platforms is one of ${PREPARE_LABELS.join(', ')}`);
  const s = await status(number);
  const before = new Set(prepareRuns(s.head.ref).map((r) => r.databaseId));
  const label = `prepare-${platforms === 'none' ? 'preview' : platforms}`;
  // Re-adding a label that is still present is not an event; clear it first.
  spawnSync('gh', ['pr', 'edit', String(number), '-R', REPO, '--remove-label', label], { stdio: 'ignore' });
  gh(['pr', 'edit', String(number), '-R', REPO, '--add-label', label]);
  let run: { databaseId: number; url: string; status: string; conclusion: string } | undefined;
  for (let i = 0; i < 24 && !run; i++) {
    await sleep(5000);
    run = prepareRuns(s.head.ref).find((r) => !before.has(r.databaseId));
  }
  if (!run) throw new Error('The workflow run did not appear');
  if (!wait) return run;
  for (;;) {
    const view = JSON.parse(gh(['run', 'view', String(run.databaseId), '-R', REPO, '--json', 'status,conclusion,url,databaseId']));
    if (view.status === 'completed') return view;
    await sleep(30000);
  }
}
/** The port the launched installer listens on for CDP: stable per PR, clear of the sandbox blocks. */
export const appPort = (number: number) => 41000 + (number % 1000);
type Manifest = { platform: string; headSha: string | null; stage: string; appName?: string; files: { name: string }[] };
async function manifest(number: number, platform: string): Promise<Manifest | null> {
  const r = await fetch(evidence.url(`${evidence.prefix(number)}manifest-${platform}.json`), { cache: 'no-store' });
  return r.ok ? (await r.json() as Manifest) : null;
}
/** Fetch the PR's installer from the public evidence bucket and launch it with a debugging port. */
export async function app(number: number, platform: string) {
  const s = await status(number);
  const m = await manifest(number, platform);
  if (!m) throw new Error(`No ${platform} installer published for #${number}; run \`bun run pr prepare ${number} --platforms ${platform}\``);
  if (m.headSha && m.headSha !== s.head.sha)
    console.error(`warning: the ${platform} installer was built from ${m.headSha.slice(0, 7)}, the PR head is ${s.head.sha.slice(0, 7)}; run \`bun run pr prepare ${number} --platforms ${platform}\` for a current one`);
  const dir = join(APPS, String(number), platform);
  mkdirSync(dir, { recursive: true });
  const stamp = join(dir, 'installed-sha');
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== String(m.headSha)) {
    rmSync(join(dir, 'app'), { recursive: true, force: true });
    const zip = m.files.map((f) => f.name).find((n) => n.endsWith('.zip'));
    if (!zip) throw new Error(`No zip published for #${number} ${platform}`);
    // curl streams a 200 MB file to disk reliably and resumes; fetch into Bun.write did not.
    const download = spawnSync('curl', ['-fsSL', '--retry', '3', '-C', '-', '-o', join(dir, zip), evidence.url(`${evidence.prefix(number)}${zip}`)], { stdio: 'inherit' });
    if (download.status !== 0) throw new Error(`Download of ${zip} failed (curl exit ${download.status})`);
    spawnSync(platform === 'mac' ? 'ditto' : 'unzip', platform === 'mac' ? ['-x', '-k', join(dir, zip), join(dir, 'app')] : ['-q', '-o', join(dir, zip), '-d', join(dir, 'app')], { stdio: 'inherit' });
    writeFileSync(stamp, String(m.headSha));
  }
  const binary = platform === 'mac'
    ? [...new Bun.Glob('**/*.app/Contents/MacOS/Compound').scanSync(join(dir, 'app'))].map((p) => join(dir, 'app', p))[0]
    : [...new Bun.Glob('**/Compound').scanSync(join(dir, 'app'))].map((p) => join(dir, 'app', p)).find((p) => statSync(p).isFile());
  if (!binary) throw new Error(`No Compound binary found under ${dir}`);
  const pidFile = join(dir, 'app.pid');
  if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* not running */ }
  const port = appPort(number);
  const adopted = adoptDesktopSession();
  // A shell inside an Electron host (T3 Code, VS Code) carries ELECTRON_RUN_AS_NODE, which would make the app run as plain Node and reject its own flags.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [`--user-data-dir=${join(dir, 'profile')}`, `--remote-debugging-port=${port}`], { detached: true, stdio: ['ignore', 'ignore', 'ignore'], env });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { url: string }[]; if (pages.length) return { pid: child.pid, cdpPort: port, cdpUrl: `http://127.0.0.1:${port}`, binary, appName: m.appName ?? 'Compound', stage: m.stage, builtFrom: m.headSha, headSha: s.head.sha, pages: pages.map((p) => p.url), display: adopted }; } catch { /* not up yet */ }
  }
  throw new Error(`The app did not open its debugging port ${port} within a minute`);
}
export function appStop(number: number) {
  let stopped = 0;
  for (const platform of ['linux', 'mac']) {
    const pidFile = join(APPS, String(number), platform, 'app.pid');
    if (!existsSync(pidFile)) continue;
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); stopped++; } catch { /* gone */ }
    rmSync(pidFile, { force: true });
  }
  return { stopped };
}
/** Recordings and screenshots go to the public evidence bucket under the PR's prefix; the comment links play in the browser. */
export async function evidenceUpload(number: number, files: string[], body?: string) {
  const s = await status(number);
  const store = evidenceStore();
  const uploaded = [];
  for (const file of files) uploaded.push(await store.put(number, file));
  const marker = `<!-- compound-evidence ${s.head.sha} -->`;
  const lines = [marker, `## Verification evidence for ${s.head.sha.slice(0, 7)}`, '', ...(body ? [body, ''] : []),
    ...uploaded.map((a) => a.type.startsWith('image/') ? `![${a.key.split('/').pop()}](${a.url})` : `- [${a.key.split('/').pop()}](${a.url}) (${(a.size / 1024 / 1024).toFixed(1)} MB${a.type.startsWith('video/') ? ', plays in the browser' : ''})`)];
  gh(['pr', 'comment', String(number), '-R', REPO, '--body', lines.join('\n')]);
  return { bucket: evidence.bucket, assets: uploaded };
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const has = (name: string) => rest.includes(`--${name}`);
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--') && !['wait'].includes(rest[i - 1]!.slice(2))));
  const number = Number(positional[0]);
  const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  switch (command) {
    case 'status': out(await status(number)); break;
    case 'ready': gh(['pr', 'ready', String(number), '-R', REPO]); out({ number, isDraft: false }); break;
    case 'resolve': out(resolveThread(positional[0]!, flag('reply'))); break;
    case 'request-review': gh(['pr', 'comment', String(number), '-R', REPO, '--body', '@coderabbitai review']); out({ number, requested: true }); break;
    case 'wait-checks': out(await waitChecks(number)); break;
    case 'prepare': out(await prepare(number, flag('platforms') ?? 'linux', has('wait'))); break;
    case 'app': out(await app(number, flag('platform') ?? (process.platform === 'darwin' ? 'mac' : 'linux'))); break;
    case 'app-stop': out(appStop(number)); break;
    case 'evidence': out(await evidenceUpload(number, positional.slice(1), flag('body'))); break;
    default: throw new Error('Commands: status, ready, resolve, request-review, wait-checks, prepare, app, app-stop, evidence');
  }
}
