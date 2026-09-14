import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, delimiter, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Writable } from 'node:stream';
import { T3Rpc, rpcError } from '@compound/chat/rpc';
import { CONTEXT_END, CONTEXT_START, isWorking, reduceThread, t3ProjectId } from '@compound/chat';
import type { ChatProject, ChatReply, ChatRequest, ChatState } from '@compound/chat';
import type { OrchestrationShellSnapshot, OrchestrationShellStreamItem, OrchestrationThreadDetailSnapshot, OrchestrationThreadStreamItem, ServerConfig, ServerSettings, ServerProviderUpdatedPayload } from '@compound/chat/types';

const supported = new Set(['codex', 'claudeAgent']);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const empty = (): ChatState => ({ status: 'starting', providers: [], shell: null, detail: null });

export type ChatServerOptions = {
  runtimeDir: string;
  executablePath?: string;
  dataDir: string;
  /** The app's MCP server, e.g. `http://127.0.0.1:3284/mcp`. Attached per project. */
  mcpUrl: string;
  /** Makes sure the provider about to run can reach the MCP server; failures are shown, never fatal. */
  registerProvider?: (provider: string) => Promise<void>;
  validateProject: (project: ChatProject) => Promise<ChatProject>;
  changed: (state: ChatState) => void;
};

/** Owns one isolated T3 process for the application's lifetime. No editor runtime lives here. */
export class ChatServer {
  state = empty();
  private child?: ChildProcess;
  private rpc?: T3Rpc;
  private baseUrl = '';
  private token = '';
  private credential = '';
  private stopped = false;
  private starting?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private emitTimer?: ReturnType<typeof setTimeout>;
  private unwatch?: () => void;
  private watchId?: string;
  private watchGeneration = 0;
  private generation = 0;
  private retryCount = 0;
  private refreshedProjects = new Set<string>();
  private sending = new Set<string>();
  private projectWrites = new Map<string, Promise<string>>();
  private mcpProjects = new Set<string>();
  private mcpProviders = new Set<string>();
  private stderr = '';
  private options: ChatServerOptions;

  constructor(options: ChatServerOptions) { this.options = options; }

  private publish(patch: Partial<ChatState> = {}) {
    if (patch.status === 'error' || (patch.error && patch.status !== 'reconnecting')) console.error(`[chat-server] ${patch.error ?? patch.status}`);
    this.state = { ...this.state, ...patch };
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = undefined; this.options.changed(this.state); }, 40);
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.stopped = false;
    this.starting = this.launch().catch((error: unknown) => {
      this.publish({ status: 'error', error: rpcError(error).message });
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async launch() {
    const generation = ++this.generation;
    this.publish({ status: 'starting', error: undefined });
    const archive = join(this.options.runtimeDir, 'app.asar');
    const entry = join(archive, 'node_modules/t3/dist/bin.mjs');
    // Checked through the entry, not the archive: Electron's asar-aware fs
    // answers ENOENT for the archive path itself while paths inside resolve.
    await access(entry).catch(() => {
      throw new Error(`Chat runtime is missing at ${archive}. In development run \`bun run --cwd apps/desktop stage:chat\`, then Retry.`);
    });
    const stateDir = join(this.options.dataDir, 'userdata');
    await mkdir(stateDir, { recursive: true });
    // Seed only our private settings; never touch the user's T3 or provider homes.
    const settingsPath = join(stateDir, 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8').catch(() => '{}'));
    // This T3 version buffers assistant text by default. Our detail-stream
    // client needs token deltas, including when upgrading an existing profile.
    settings.enableLegacyTokenStreaming = true;
    settings.providerInstances ??= {};
    for (const driver of ['codex', 'claudeAgent', 'cursor', 'grok', 'gemini', 'opencode', 'antigravity']) {
      settings.providerInstances[driver] = { driver, ...settings.providerInstances[driver], enabled: supported.has(driver) };
    }
    for (const instance of Object.values(settings.providerInstances) as Array<{ driver: string; enabled: boolean }>) {
      if (!supported.has(instance.driver)) instance.enabled = false;
    }
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not reserve a chat port')); return; }
        server.close(() => resolve(address.port));
      });
    });
    if (this.stopped || generation !== this.generation) return;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.credential = randomBytes(32).toString('hex');
    this.stderr = '';
    // Like T3's desktop app, run the backend with Electron's built-in Node.
    const env: NodeJS.ProcessEnv = {
      ...process.env, ELECTRON_RUN_AS_NODE: '1',
      T3CODE_RESOURCE_MONITOR_PATH: join(this.options.runtimeDir, 'resource-monitor', `${process.platform}-${process.arch}`, 't3-resource-monitor'),
      PATH: [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(delimiter),
    };
    // This identifies an enclosing development-agent session, not the user's login.
    delete env.CLAUDECODE;
    const child = spawn(this.options.executablePath ?? process.execPath, [entry, 'serve', '--bootstrap-fd', '3'], {
      cwd: this.options.dataDir, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    const bootstrap = child.stdio[3] as Writable;
    bootstrap.on('error', () => {});
    bootstrap.end(JSON.stringify({ mode: 'desktop', noBrowser: true, port, host: '127.0.0.1', t3Home: this.options.dataDir, desktopBootstrapToken: this.credential, tailscaleServeEnabled: false, tailscaleServePort: 443 }) + '\n');
    const collect = (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-6000); };
    child.stderr?.on('data', collect);
    child.stdout?.on('data', collect);
    child.on('error', (error) => { this.publish({ status: 'error', error: error.message }); });
    child.on('exit', () => {
      if (generation !== this.generation || this.stopped) return;
      this.child = undefined;
      this.rpc?.close();
      this.publish({ status: 'error', error: `Chat server exited. ${this.stderr.replaceAll(this.credential, '[redacted]').slice(-1600)}` });
    });
    const deadline = Date.now() + 60_000;
    while (!this.stopped && generation === this.generation && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Chat server failed to start: ${this.stderr.replaceAll(this.credential, '[redacted]').slice(-1600)}`);
      try {
        const response = await fetch(`${this.baseUrl}/.well-known/t3/environment`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch { /* The child is still binding its listener. */ }
      await pause(250);
    }
    if (this.stopped || generation !== this.generation) return;
    if (Date.now() >= deadline) throw new Error('Chat server did not become ready within 60 seconds. Retry to restart it.');
    await this.connect(generation);
  }

  private reconnect(generation: number) {
    if (this.stopped || generation !== this.generation) return;
    if (!this.child || this.child.exitCode !== null) {
      this.publish({ status: 'error', error: 'The chat server stopped. Retry to restart it.' });
      return;
    }
    this.publish({ status: 'reconnecting', error: 'Connection lost. Your conversations are saved.' });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      void this.connect(generation).catch(() => this.reconnect(generation));
    }, Math.min(1000 * 2 ** this.retryCount++, 10_000));
  }

  private async connect(generation: number) {
    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: this.credential, subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap', requested_token_type: 'urn:ietf:params:oauth:token-type:access_token', client_label: 'Compound', client_device_type: 'desktop' }),
    });
    if (!response.ok) throw new Error(`Chat authentication failed (${response.status})`);
    this.token = (await response.json() as { access_token: string }).access_token;
    const ticket = await this.http<{ ticket: string }>('/api/auth/websocket-ticket', 'POST');
    if (this.stopped || generation !== this.generation) return;
    const rpc = new T3Rpc(`${this.baseUrl.replace('http:', 'ws:')}/ws?wsTicket=${encodeURIComponent(ticket.ticket)}`, () => {
      if (this.stopped || generation !== this.generation || rpc !== this.rpc) return;
      this.reconnect(generation);
    });
    this.rpc = rpc;
    await rpc.opened;
    const config = await rpc.call<ServerConfig>('server.getConfig', {});
    if (this.rpc !== rpc || this.stopped) return;
    this.retryCount = 0;
    this.publish({ status: 'ready', error: undefined, providers: config.providers.filter(p => supported.has(p.driver)) });
    const fail = (error: Error) => { if (!this.stopped && this.rpc === rpc) this.publish({ error: error.message }); };
    rpc.subscribe<OrchestrationShellStreamItem>('orchestration.subscribeShell', {}, item => {
      if (item.kind === 'snapshot') { this.publish({ shell: item.snapshot }); return; }
      if (item.kind === 'synchronized' || !this.state.shell || item.sequence <= this.state.shell.snapshotSequence) return;
      const shell = this.state.shell;
      const patch: { threads?: OrchestrationShellSnapshot["threads"]; projects?: OrchestrationShellSnapshot["projects"] } = {};
      if (item.kind === 'thread-upserted') patch.threads = [...shell.threads.filter(t => t.id !== item.thread.id), item.thread];
      if (item.kind === 'thread-removed') patch.threads = shell.threads.filter(t => t.id !== item.threadId);
      if (item.kind === 'project-upserted') patch.projects = [...shell.projects.filter(p => p.id !== item.project.id), item.project];
      if (item.kind === 'project-removed') patch.projects = shell.projects.filter(p => p.id !== item.projectId);
      // T3 deliberately omits metadata events from the detail stream. Its
      // clients combine shell metadata with detail content. Do not advance the
      // detail watermark here: message events use an independent stream.
      const detail = this.state.detail;
      if (item.kind === 'thread-upserted' && detail?.thread.id === item.thread.id) {
        const { title, modelSelection, runtimeMode, interactionMode, archivedAt, branch, worktreePath } = item.thread;
        this.publish({ detail: { ...detail, thread: { ...detail.thread, title, modelSelection, runtimeMode, interactionMode, archivedAt, branch, worktreePath } } });
      }
      this.publish({ shell: { ...shell, ...patch, snapshotSequence: item.sequence } });
    }, fail);
    // Status changes (including expiring auth) are authoritative on the server.
    rpc.subscribe<{ type: string; config?: ServerConfig; providers?: ServerConfig['providers']; payload?: { providers?: ServerConfig['providers'] } }>('subscribeServerConfig', {}, item => {
      const providers = item.config?.providers ?? item.payload?.providers ?? item.providers;
      if (providers) this.publish({ providers: providers.filter(p => supported.has(p.driver)) });
    }, fail);
    if (this.watchId) await this.watch(this.watchId);
  }

  private async http<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value: unknown = await response.json();
    if (!response.ok) throw rpcError(value);
    return value as T;
  }

  private async dispatch(command: Record<string, unknown>) {
    return this.http('/api/orchestration/dispatch', 'POST', { commandId: randomUUID(), createdAt: new Date().toISOString(), ...command });
  }

  /**
   * The project's folder is gone: drop its T3 project and every chat in it,
   * as the reference editor does with its own host. Best effort — a chat
   * server that is down leaves the threads behind, and they are harmless.
   */
  async forgetProject(id: string): Promise<void> {
    if (!id) return;
    const projectId = t3ProjectId(id);
    const prior = this.projectWrites.get(id) ?? Promise.resolve('');
    const next = prior.catch(() => '').then(async () => {
      const shell = await this.http<OrchestrationShellSnapshot>('/api/orchestration/shell').catch(() => null);
      if (!shell?.projects.some(p => p.id === projectId)) return '';
      await this.dispatch({ type: 'project.delete', projectId, force: true });
      return '';
    });
    this.projectWrites.set(id, next);
    await next.catch(() => {});
  }

  private ensureProject(input: ChatProject): Promise<string> {
    const prior = this.projectWrites.get(input.id) ?? Promise.resolve('');
    const next = prior.catch(() => '').then(async () => {
      const project = await this.options.validateProject(input);
      const id = t3ProjectId(project.id);
      const shell = await this.http<OrchestrationShellSnapshot>('/api/orchestration/shell');
      const existing = shell.projects.find(p => p.id === id);
      if (!existing) await this.dispatch({ type: 'project.create', projectId: id, title: project.name, workspaceRoot: project.dir });
      else if (existing.workspaceRoot !== project.dir || existing.title !== project.name) {
        if (shell.threads.some(t => t.projectId === id && isWorking(t))) throw new Error('Wait for this project’s active chats to finish before changing its directory.');
        if (existing.workspaceRoot !== project.dir && !await sameDirectory(existing.workspaceRoot, project.dir).catch(() => false)) {
          const oldProjectExists = await this.options.validateProject({ ...project, dir: existing.workspaceRoot }).then(() => true, () => false);
          if (oldProjectExists) throw new Error('Two project folders share the same project ID. Give the copied project a new projectId before using chat.');
          // Provider processes retain their cwd. Stop idle sessions before a
          // moved project resumes; T3 retains their durable conversation state.
          for (const thread of shell.threads.filter(t => t.projectId === id && t.session)) {
            await this.dispatch({ type: 'thread.session.stop', threadId: thread.id });
          }
        }
        await this.dispatch({ type: 'project.meta.update', projectId: id, title: project.name, workspaceRoot: project.dir });
      }
      return id;
    });
    this.projectWrites.set(input.id, next);
    void next.finally(() => { if (this.projectWrites.get(input.id) === next) this.projectWrites.delete(input.id); }).catch(() => {});
    return next;
  }

  private async watch(threadId: string, turnLimit = 10) {
    const generation = ++this.watchGeneration;
    this.watchId = threadId;
    this.unwatch?.();
    this.publish({ detail: null });
    const snapshot = await this.http<OrchestrationThreadDetailSnapshot>(`/api/orchestration/threads/${encodeURIComponent(threadId)}?turnLimit=${turnLimit}`);
    if (generation !== this.watchGeneration) return;
    this.publish({ detail: snapshot });
    this.unwatch = this.rpc!.subscribe<OrchestrationThreadStreamItem>('orchestration.subscribeThread', { threadId, afterSequence: snapshot.snapshotSequence }, item => {
      if (generation === this.watchGeneration) this.publish({ detail: reduceThread(this.state.detail, item) });
    }, error => this.publish({ error: error.message }));
  }

  async request(request: ChatRequest): Promise<ChatReply> {
    if (request.operation === 'state') return { state: this.state };
    if (request.operation === 'restart') { await this.stop(); await this.starting; await this.start(); return { state: this.state }; }
    if (request.operation === 'unwatch') { ++this.watchGeneration; this.unwatch?.(); this.watchId = undefined; this.publish({ detail: null }); return { state: this.state }; }
    if (this.state.status !== 'ready' || !this.rpc) throw new Error('Chat server is not ready. Wait or retry the connection.');
    let threadId: string | undefined;
    let url: string | undefined;
    let filePath: string | undefined;
    switch (request.operation) {
      case 'project': {
        await this.ensureProject(request.project);
        if (!this.refreshedProjects.has(request.project.dir)) {
          this.refreshedProjects.add(request.project.dir);
          for (const provider of supported) {
            try {
              const result = await this.rpc.call<ServerProviderUpdatedPayload>('server.refreshProviders', { instanceId: provider, cwd: request.project.dir, refreshModels: true });
              this.publish({ providers: result.providers.filter(p => supported.has(p.driver)) });
            } catch (error) { this.refreshedProjects.delete(request.project.dir); this.publish({ error: rpcError(error).message }); }
          }
        }
        break;
      }
      case 'create': {
        if (!supported.has(request.provider)) throw new Error('Unsupported chat provider');
        const projectId = await this.ensureProject(request.project);
        await this.attachMcp(request.project.dir, request.provider);
        threadId = randomUUID();
        await this.dispatch({ type: 'thread.create', threadId, projectId, title: 'New chat', modelSelection: { instanceId: request.provider, model: request.model, options: request.modelOptions }, runtimeMode: request.runtimeMode ?? 'approval-required', interactionMode: 'default', branch: null, worktreePath: null });
        break;
      }
      case 'permissions': await this.dispatch({ type: 'thread.runtime-mode.set', threadId: request.threadId, runtimeMode: request.runtimeMode }); break;
      case 'watch': await this.watch(request.threadId); break;
      case 'older': {
        const current = this.state.detail;
        if (current?.thread.id !== request.threadId) throw new Error('Select the chat before loading history');
        // Replace with a larger authoritative window, then replay from its watermark.
        // This avoids merging an older page over a concurrently streaming turn.
        await this.watch(request.threadId, current.thread.messages.filter(m => m.role === 'user').length + 20);
        break;
      }
      case 'send': {
        if (this.sending.has(request.threadId)) throw new Error('A message is already being sent');
        this.sending.add(request.threadId);
        try {
          const projectId = await this.ensureProject(request.project);
          const { thread } = await this.http<OrchestrationThreadDetailSnapshot>(`/api/orchestration/threads/${encodeURIComponent(request.threadId)}?turnLimit=1`);
          if (thread.projectId !== projectId) throw new Error('This chat belongs to a different project');
          if (isWorking(thread)) throw new Error('Wait for this turn to finish, or stop it before sending another message');
          if (!supported.has(thread.modelSelection.instanceId)) throw new Error('Unsupported chat provider');
          await this.attachMcp(request.project.dir, thread.modelSelection.instanceId);
          const context = request.context + MCP_INSTRUCTIONS;
          await this.dispatch({ type: 'thread.turn.start', commandId: request.messageId, threadId: request.threadId, message: { messageId: request.messageId, role: 'user', text: request.text + CONTEXT_START + context + CONTEXT_END, attachments: request.attachments }, modelSelection: { ...thread.modelSelection, model: request.model, options: request.modelOptions ?? thread.modelSelection.options }, runtimeMode: thread.runtimeMode, interactionMode: 'default', titleSeed: request.text.slice(0, 160) || 'Image attachment' });
        } finally { this.sending.delete(request.threadId); }
        break;
      }
      case 'stop': await this.dispatch({ type: 'thread.turn.interrupt', threadId: request.threadId }); break;
      case 'archive': await this.dispatch({ type: 'thread.archive', threadId: request.threadId }); break;
      case 'rename': await this.dispatch({ type: 'thread.meta.update', threadId: request.threadId, title: request.title }); break;
      case 'approve': await this.dispatch({ type: 'thread.approval.respond', threadId: request.threadId, requestId: request.requestId, decision: request.decision }); break;
      case 'answer': await this.dispatch({ type: 'thread.user-input.respond', threadId: request.threadId, requestId: request.requestId, answers: request.answers }); break;
      case 'refresh': {
        const result = await this.rpc.call<ServerProviderUpdatedPayload>('server.refreshProviders', { instanceId: request.provider, cwd: request.cwd, refreshModels: true });
        this.publish({ providers: result.providers.filter(p => supported.has(p.driver)), error: undefined });
        break;
      }
      case 'configure': {
        if (!supported.has(request.provider)) throw new Error('Unsupported chat provider');
        const settings = await this.rpc.call<ServerSettings>('server.getSettings', {});
        const previous = Object.entries(settings.providerInstances).find(([id]) => id === request.provider)?.[1];
        await this.rpc.call('server.updateSettings', { patch: { providerInstances: { ...settings.providerInstances, [request.provider]: { ...previous, driver: request.provider, enabled: true, config: { ...(previous?.config as object), binaryPath: request.binaryPath } } } } });
        break;
      }
      case 'asset': {
        // T3 signs previewable media only. Other files remain explicit Reveal
        // actions; merely rendering a Markdown link must never open a program.
        if (!request.attachmentId && !/\.(png|jpe?g|webp|gif|avif|mp4|mov|webm|mp3|wav|m4a|ogg|pdf|html?)(?:[?#]|$)/i.test(request.path)) {
          const { thread } = await this.http<OrchestrationThreadDetailSnapshot>(`/api/orchestration/threads/${encodeURIComponent(request.threadId)}?turnLimit=1`);
          const shell = await this.http<OrchestrationShellSnapshot>('/api/orchestration/shell');
          const root = shell.projects.find(p => p.id === thread.projectId)?.workspaceRoot;
          if (!root) throw new Error('Chat project no longer exists');
          filePath = await realpath(resolve(root, request.path));
          break;
        }
        const resource = request.attachmentId ? { _tag: 'attachment', attachmentId: request.attachmentId, fileName: request.path, mimeType: request.mimeType } : { _tag: /\.(png|jpe?g|webp|gif|avif|mp4|mov|webm|mp3|wav|m4a|ogg|pdf|html?)(?:[?#]|$)/i.test(request.path) ? 'media-file' : 'workspace-file', threadId: request.threadId, path: request.path };
        const result = await this.rpc.call<{ relativeUrl: string }>('assets.createUrl', { resource });
        const signed = new URL(result.relativeUrl, this.baseUrl);
        if (signed.origin !== this.baseUrl) throw new Error('Unexpected asset origin');
        url = signed.href;
        break;
      }
    }
    return { state: this.state, ...(threadId ? { threadId } : {}), ...(url ? { url } : {}), ...(filePath ? { filePath } : {}) };
  }

  /** Writes the project's MCP config once per session and registers the provider once; a failure never blocks a turn. */
  private async attachMcp(dir: string, provider: string) {
    if (!this.options.mcpUrl) return;
    if (!this.mcpProjects.has(dir)) {
      this.mcpProjects.add(dir);
      try {
        await writeProjectMcpConfig(dir, this.options.mcpUrl);
      } catch (error) {
        this.mcpProjects.delete(dir);
        this.publish({ error: `Could not attach the Compound tools to this project: ${rpcError(error).message}` });
      }
    }
    if (this.options.registerProvider && !this.mcpProviders.has(provider)) {
      this.mcpProviders.add(provider);
      try {
        await this.options.registerProvider(provider);
      } catch (error) {
        this.mcpProviders.delete(provider);
        this.publish({ error: `Could not register the Compound tools with ${provider}: ${rpcError(error).message}` });
      }
    }
  }

  async stop() {
    this.stopped = true;
    ++this.generation;
    ++this.watchGeneration;
    clearTimeout(this.retryTimer);
    this.unwatch?.();
    this.rpc?.close();
    this.rpc = undefined;
    const child = this.child;
    this.child = undefined;
    if (child?.pid && child.exitCode === null) {
      const signal = (name: NodeJS.Signals) => { try { if (process.platform === 'win32') child.kill(name); else process.kill(-child.pid!, name); } catch { /* already exited */ } };
      signal('SIGTERM');
      await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), pause(3000)]);
      signal('SIGKILL');
    }
    this.publish({ status: 'stopped', error: undefined });
    this.refreshedProjects.clear();
  }
}

export async function sameDirectory(left: string, right: string) { return await realpath(left) === await realpath(right); }

/** The name our entry lives under in every agent's server map (see `mcp-config.ts`). */
const MCP_SERVER_NAME = 'compound';

const MCP_INSTRUCTIONS = `

The Compound MCP tools are attached to this session under the \`${MCP_SERVER_NAME}\` server (tool names \`mcp__${MCP_SERVER_NAME}__*\`). They act on the project that is open in the editor; there is no background renderer and no CLI to invoke. Use \`capture\` to see the current frame and \`check\` to verify a change actually rendered, before reporting that it is done. \`context\` reports what the editor has open. If the tools are not listed, say so instead of falling back to a shell command.`;

/** Merge one server into a JSON config file's map, keeping everything else. */
async function mergeJson(path: string, merge: (config: Record<string, unknown>) => Record<string, unknown>) {
  const existing = JSON.parse(await readFile(path, 'utf8').catch(() => '{}')) as Record<string, unknown>;
  const next = merge(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {});
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Attaches the app's MCP server to the agents T3 runs in this project.
 *
 * T3 gives a session exactly one MCP server of its own (`t3-code`) and has no
 * user-configurable server list: its settings schema has no MCP section, and
 * both drivers hardcode their own entry. What it does leave open is each
 * agent's native configuration. Claude Code runs under
 * `settingSources: ["user", "project", "local"]` with no `strictMcpConfig`, so
 * a project `.mcp.json` is read — and `enabledMcpjsonServers` in the project's
 * local settings is what pre-approves it, so no prompt appears where there is
 * no terminal to answer it.
 *
 * Codex has no project-scoped equivalent: T3 passes its own server through
 * `-c mcp_servers.t3-code.*` and everything else comes from
 * `~/.codex/config.toml`. Codex therefore needs the user-level registration the
 * settings page performs (`mcp-install.ts`).
 */
export async function writeProjectMcpConfig(dir: string, url: string) {
  await mergeJson(join(dir, '.mcp.json'), (config) => {
    const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers as Record<string, unknown> : {};
    return { ...config, mcpServers: { ...servers, [MCP_SERVER_NAME]: { type: 'http', url } } };
  });
  await mergeJson(join(dir, '.claude', 'settings.local.json'), (config) => {
    const enabled = Array.isArray(config.enabledMcpjsonServers) ? config.enabledMcpjsonServers.map(String) : [];
    return enabled.includes(MCP_SERVER_NAME) ? config : { ...config, enabledMcpjsonServers: [...enabled, MCP_SERVER_NAME] };
  });
}
