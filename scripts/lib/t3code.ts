/**
 * A small client for the T3 Code server running on this machine.
 *
 * T3 Code has no public API. This targets the server bundled with the desktop
 * app (checked against 0.0.40): reads go to `GET /api/orchestration/*` and
 * commands go over the `/ws` RPC socket (Effect RPC, JSON serialization), the
 * same way its own web client talks to it. Only the socket handler expands a
 * `thread.turn.start` bootstrap into create thread, create worktree, run the
 * setup script, then start the turn.
 *
 * Auth is a bearer session minted by T3 Code's own CLI
 * (`t3 auth session issue`), run through the desktop binary in Node mode, so no
 * pairing step in the UI is needed. The token is cached with its expiry.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ModelSelection {
  instanceId: string;
  model: string;
}

export interface ProjectScript {
  id: string;
  name: string;
  command: string;
  icon: 'play' | 'test' | 'lint' | 'configure' | 'build' | 'debug';
  runOnWorktreeCreate: boolean;
}

export interface ShellProject {
  id: string;
  title: string;
  workspaceRoot: string;
  scripts: ProjectScript[];
}

export interface ThreadDetail {
  id: string;
  projectId: string;
  title: string;
  branch: string | null;
  worktreePath: string | null;
  modelSelection: ModelSelection;
  messages: { id: string; role: string; text: string; createdAt: string }[];
  activities: { kind: string; summary: string; payload: unknown; createdAt: string }[];
  latestTurn: { turnId: string; state: string } | null;
  deletedAt: string | null;
}

export const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), '.t3');
export const T3_BIN = process.env.T3CODE_BIN ?? '/opt/t3code-bin/t3code';
const TOKEN_CACHE = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'compound-issue-worker', 't3-session.json');

/** UUID-shaped id derived from a key, so the same issue always maps to the same thread. */
export function deterministicId(namespace: string, key: string): string {
  const hex = createHash('sha256').update(`compound-issue-worker:${namespace}:${key}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `${variant}${hex.slice(17, 20)}`, hex.slice(20, 32)].join('-');
}

/** The origin of the running server, from the runtime file it writes on start. */
export async function discoverOrigin(): Promise<string> {
  if (process.env.T3_SERVER_URL) return new URL(process.env.T3_SERVER_URL).origin;
  const file = join(T3_HOME, 'userdata', 'server-runtime.json');
  const runtime = JSON.parse(await readFile(file, 'utf8')) as { pid: number; origin: string };
  try {
    process.kill(runtime.pid, 0);
  } catch {
    throw new Error(`T3 Code is not running (pid ${runtime.pid} from ${file} is gone)`);
  }
  return runtime.origin;
}

interface CachedSession {
  origin: string;
  token: string;
  expiresAt: string;
}

/** Mint a bearer session with T3 Code's CLI against the live state directory. */
async function issueSession(): Promise<{ sessionId: string; token: string; expiresAt: string }> {
  const entry = join(dirname(T3_BIN), 'resources', 'app.asar', 'apps', 'server', 'dist', 'bin.mjs');
  const proc = Bun.spawn(
    [T3_BIN, entry, 'auth', 'session', 'issue', '--label', 'compound-issue-worker', '--ttl', '30d', '--json', '--base-dir', T3_HOME],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`t3 auth session issue failed (${code}): ${stderr.trim() || stdout.trim()}`);
  return JSON.parse(stdout) as { sessionId: string; token: string; expiresAt: string };
}

async function accessToken(origin: string, refresh = false): Promise<string> {
  if (process.env.T3_ACCESS_TOKEN) return process.env.T3_ACCESS_TOKEN;
  if (!refresh && existsSync(TOKEN_CACHE)) {
    const cached = JSON.parse(await readFile(TOKEN_CACHE, 'utf8')) as CachedSession;
    const dayMs = 24 * 60 * 60 * 1000;
    if (cached.origin === origin && new Date(cached.expiresAt).getTime() - Date.now() > dayMs) return cached.token;
  }
  const issued = await issueSession();
  await mkdir(dirname(TOKEN_CACHE), { recursive: true });
  await writeFile(TOKEN_CACHE, JSON.stringify({ origin, token: issued.token, expiresAt: issued.expiresAt }, null, 2), { mode: 0o600 });
  return issued.token;
}

export class T3CodeError extends Error {
  readonly tag: string | undefined;
  constructor(message: string, tag?: string) {
    super(message);
    this.tag = tag;
  }
}

/** Human-readable text out of an Effect failure value. */
function describe(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : JSON.stringify(record).slice(0, 400);
    return typeof record._tag === 'string' ? `${record._tag}: ${message}` : message;
  }
  return String(value);
}

type RpcExit = { _tag: 'Success'; value: unknown } | { _tag: 'Failure'; cause: { _tag: string; error?: unknown; defect?: unknown }[] };

export class T3Code {
  readonly origin: string;
  private token: string;

  private constructor(origin: string, token: string) {
    this.origin = origin;
    this.token = token;
  }

  static async connect(): Promise<T3Code> {
    const origin = await discoverOrigin();
    const client = new T3Code(origin, await accessToken(origin));
    // A cached token can be revoked in T3 Code's settings; mint a new one once.
    const probe = await fetch(new URL('/api/orchestration/shell', origin), { headers: client.headers() });
    if (probe.status === 401 || probe.status === 403) client.token = await accessToken(origin, true);
    return client;
  }

  private headers() {
    return { authorization: `Bearer ${this.token}`, accept: 'application/json' };
  }

  private async get<T>(path: string): Promise<T | null> {
    const response = await fetch(new URL(path, this.origin), { headers: this.headers(), signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) throw new T3CodeError(`GET ${path} failed (${response.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async projects(): Promise<ShellProject[]> {
    const shell = await this.get<{ projects: ShellProject[] }>('/api/orchestration/shell');
    return shell?.projects ?? [];
  }

  /** A thread that exists and is not deleted, or null. */
  async thread(threadId: string): Promise<ThreadDetail | null> {
    const detail = await this.get<{ thread: ThreadDetail }>(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
    return detail?.thread && !detail.thread.deletedAt ? detail.thread : null;
  }

  /** One unary RPC over a fresh socket. The worker makes a handful per minute, so no pooling. */
  rpc<T>(tag: string, payload: unknown, timeoutMs = 180_000): Promise<T> {
    const url = new URL('/ws', this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientSurface', 'web');
    url.searchParams.set('connectionMethod', 'direct');
    return new Promise<T>((resolve, reject) => {
      // Bun's WebSocket accepts headers; the browser one does not.
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } } as unknown as string[]);
      const requestId = '1';
      let settled = false;
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolve(value as T);
      };
      const timer = setTimeout(() => finish(new T3CodeError(`RPC ${tag} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ _tag: 'Request', id: requestId, tag, payload, headers: [] }));
      });
      socket.addEventListener('message', (event) => {
        const parsed = JSON.parse(String(event.data)) as unknown;
        for (const message of (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[]) {
          if (message._tag === 'Chunk') socket.send(JSON.stringify({ _tag: 'Ack', requestId: message.requestId }));
          if (message._tag === 'Defect' || message._tag === 'ClientProtocolError') {
            finish(new T3CodeError(`RPC ${tag}: ${describe(message.defect ?? message.error)}`, String(message._tag)));
          }
          if (message._tag !== 'Exit' || String(message.requestId) !== requestId) continue;
          const exit = message.exit as RpcExit;
          if (exit._tag === 'Success') {
            finish(null, exit.value);
            continue;
          }
          const first = exit.cause[0];
          const failure = first?.error ?? first?.defect;
          const failureTag = failure && typeof failure === 'object' ? String((failure as { _tag?: unknown })._tag ?? first?._tag) : first?._tag;
          finish(new T3CodeError(`RPC ${tag} failed: ${describe(failure)}`, failureTag));
        }
      });
      socket.addEventListener('error', () => finish(new T3CodeError(`RPC ${tag}: WebSocket error connecting to ${url.origin}`)));
      socket.addEventListener('close', (event) => finish(new T3CodeError(`RPC ${tag}: socket closed (${event.code}) before a reply`)));
    });
  }

  dispatch(command: Record<string, unknown>): Promise<{ sequence: number }> {
    return this.rpc('orchestration.dispatchCommand', command);
  }

  /** Replace a project's scripts, e.g. with the ones from its checked-in `t3.json`. */
  setProjectScripts(projectId: string, scripts: ProjectScript[]) {
    return this.dispatch({ type: 'project.meta.update', commandId: randomUUID(), projectId, scripts });
  }

  /** Send a follow-up message to an existing thread, starting a new turn with the thread's own model. */
  sendMessage(threadId: string, text: string, modelSelection: ModelSelection) {
    return this.dispatch({
      type: 'thread.turn.start',
      commandId: randomUUID(),
      threadId,
      message: { messageId: randomUUID(), role: 'user', text, attachments: [] },
      modelSelection,
      runtimeMode: 'full-access',
      interactionMode: 'default',
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Create a thread in a new worktree on a new branch and send its first
   * message, in one command. T3 Code creates the worktree from `baseBranch`
   * (from origin when it exists there), runs the project's worktree setup
   * script in a terminal of that thread, then starts the turn.
   */
  startThreadInNewWorktree(spec: {
    threadId: string;
    project: ShellProject;
    title: string;
    branch: string;
    baseBranch: string;
    text: string;
    modelSelection: ModelSelection;
  }) {
    const createdAt = new Date().toISOString();
    const modes = { runtimeMode: 'full-access', interactionMode: 'default' } as const;
    return this.dispatch({
      type: 'thread.turn.start',
      commandId: randomUUID(),
      threadId: spec.threadId,
      message: { messageId: randomUUID(), role: 'user', text: spec.text, attachments: [] },
      modelSelection: spec.modelSelection,
      titleSeed: spec.title,
      ...modes,
      bootstrap: {
        createThread: {
          projectId: spec.project.id,
          title: spec.title,
          modelSelection: spec.modelSelection,
          ...modes,
          branch: spec.branch,
          worktreePath: null,
          createdAt,
        },
        prepareWorktree: {
          projectCwd: spec.project.workspaceRoot,
          baseBranch: spec.baseBranch,
          branch: spec.branch,
          startFromOrigin: true,
        },
        runSetupScript: true,
      },
      createdAt,
    });
  }
}

/** A `t3.json` script in the shape T3 Code stores on a project. */
export function projectScriptsFromT3Json(contents: string): ProjectScript[] {
  const file = JSON.parse(contents) as { scripts?: { name: string; command: string; icon?: string; runOnWorktreeCreate?: boolean }[] };
  const icons = new Set(['play', 'test', 'lint', 'configure', 'build', 'debug']);
  return (file.scripts ?? []).map((script) => ({
    id: script.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name: script.name,
    command: script.command,
    icon: (icons.has(script.icon ?? '') ? script.icon : 'play') as ProjectScript['icon'],
    runOnWorktreeCreate: script.runOnWorktreeCreate === true,
  }));
}
