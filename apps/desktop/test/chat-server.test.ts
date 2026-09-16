import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import electron from 'electron';
import { extractFile, listPackage } from '@electron/asar';
import { ChatServer, writeProjectMcpConfig } from '../src/chat-server';

const runtimeDir = resolve(process.env.COMPOUND_TEST_CHAT_DIR ?? resolve(import.meta.dir, '../chat-runtime'));
const electronPath = (process.env.COMPOUND_TEST_ELECTRON ?? electron) as unknown as string;

test.skipIf(process.env.COMPOUND_TEST_CHAT_RUNTIME !== '1')('chat ships an archive and a small native payload', async () => {
  const runtime = runtimeDir;
  const archive = join(runtime, 'app.asar');
  expect(JSON.parse(extractFile(archive, 'node_modules/t3/package.json').toString()).version).toBe('0.0.40');
  expect(listPackage(archive).some(path => path.includes('claude-agent-sdk-darwin-'))).toBe(false);
  expect(listPackage(archive).some(path => /\.(node|dylib|exe)$/.test(path))).toBe(false);
  expect((await readdir(runtime, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).length).toBeLessThan(500);
  execFileSync(join(runtime, 'resource-monitor', `darwin-${process.arch}`, 't3-resource-monitor'), ['--help'], { timeout: 30_000, stdio: 'pipe' });
}, 35_000);

test.skipIf(process.env.COMPOUND_TEST_CHAT_RUNTIME !== '1')('Electron runs the chat native dependencies without standalone Node', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compound-chat-native-test-'));
  try {
    await writeFile(join(dir, 'example.txt'), 'test');
    execFileSync(electronPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import pty from 'node-pty';
      import extract from 'msgpackr-extract';
      import { FileFinder } from '@ff-labs/fff-node';
      assert.ok(process.versions.electron);
      assert.equal(typeof extract.extractStrings, 'function');
      const db = new DatabaseSync(':memory:');
      assert.equal(db.prepare('select 1 as value').get().value, 1);
      db.close();
      const created = FileFinder.create({ basePath: process.argv[1], disableWatch: true });
      assert.ok(created.ok, created.error);
      try {
        await created.value.waitForScan(5000);
        const result = created.value.fileSearch('example.txt');
        assert.ok(result.ok, result.error);
        assert.ok(result.value.items.some(item => item.relativePath === 'example.txt'));
      } finally { created.value.destroy(); }
      await new Promise((resolve, reject) => {
        const terminal = pty.spawn('/bin/sh', ['-c', 'printf electron-pty-ok'], { cwd: process.argv[1] });
        let output = '';
        terminal.onData(data => { output += data; });
        terminal.onExit(({ exitCode }) => {
          if (exitCode === 0 && output.includes('electron-pty-ok')) resolve();
          else reject(new Error('Electron terminal failed: ' + output));
        });
      });
    `, dir], {
      cwd: runtimeDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe', timeout: 15_000,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20_000);

// T3 attaches only its own MCP server to a session, so the app's tools reach
// Claude Code through the project's own `.mcp.json`, pre-approved in the
// project's local Claude settings. Codex has no project scope and is
// registered at the user level from the settings page instead.
test('attaching the MCP server keeps a project’s existing servers and settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compound-mcp-config-'));
  try {
    await writeFile(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }));
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));

    await writeProjectMcpConfig(dir, 'http://127.0.0.1:3284/mcp');
    // Writing twice must not duplicate the approval or the entry.
    await writeProjectMcpConfig(dir, 'http://127.0.0.1:3284/mcp');

    const config = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(config.mcpServers).toEqual({
      other: { command: 'other-server' },
      compound: { type: 'http', url: 'http://127.0.0.1:3284/mcp' },
    });
    const local = JSON.parse(await readFile(join(dir, '.claude', 'settings.local.json'), 'utf8'));
    expect(local).toEqual({ permissions: { allow: ['Bash'] }, enabledMcpjsonServers: ['compound'] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Explicit opt-in: starts the staged server and probes installed providers,
// but never submits a model turn or changes a user's provider credentials.
test.skipIf(process.env.COMPOUND_TEST_CHAT_RUNTIME !== '1')('packaged T3 authenticates, persists threads, streams metadata, and signs assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compound-chat-runtime-test-'));
  const server = new ChatServer({ executablePath: electronPath, runtimeDir, dataDir: join(dir, 'state'), mcpUrl: 'http://127.0.0.1:3284/mcp', validateProject: async p => p, changed: () => {} });
  const project = { id: 'test-project', name: 'Test', dir };
  try {
    const settingsDir = join(dir, 'state', 'userdata');
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ enableLegacyTokenStreaming: false }));
    await server.start();
    expect(server.state.error).toBeUndefined();
    expect(server.state.status).toBe('ready');
    const settingsRpc = server as unknown as { rpc: { call<T>(tag: string, payload: unknown): Promise<T> } };
    expect((await settingsRpc.rpc.call<{ enableLegacyTokenStreaming: boolean }>('server.getSettings', {})).enableLegacyTokenStreaming).toBe(true);
    expect(server.state.providers.map(p => p.instanceId).sort()).toEqual(['claudeAgent', 'codex']);
    const reply = await server.request({ operation: 'create', project, provider: 'codex', model: 'gpt-5.6-sol' });
    const threadId = reply.threadId!;
    await server.request({ operation: 'watch', threadId });
    expect(server.state.detail?.thread.projectId).toBe('compound-test-project');
    // Every chat runs with full access; there is no picker and no per-chat option.
    expect(server.state.detail?.thread.runtimeMode).toBe('full-access');
    expect(server.state.detail?.thread.modelSelection.options).toBeUndefined();
    const custom = await server.request({ operation: 'create', project, provider: 'claudeAgent', model: 'claude-sonnet-4-6' });
    await server.request({ operation: 'watch', threadId: custom.threadId! });
    expect(server.state.detail?.thread.runtimeMode).toBe('full-access');
    await server.request({ operation: 'watch', threadId });
    await server.request({ operation: 'rename', threadId, title: 'Saved chat' });
    const deadline = Date.now() + 5000;
    while (server.state.detail?.thread.title !== 'Saved chat' && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    expect(server.state.detail?.thread.title).toBe('Saved chat');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    await writeFile(join(dir, 'result.png'), png);
    const asset = await server.request({ operation: 'asset', threadId, path: 'result.png' });
    expect(new Uint8Array(await fetch(asset.url!).then(r => r.arrayBuffer()))).toEqual(new Uint8Array(png));
    await writeFile(join(dir, 'result.txt'), 'saved output');
    expect((await server.request({ operation: 'asset', threadId, path: 'result.txt' })).filePath).toEndWith('/result.txt');
    const connection = server as unknown as { rpc: { close(): void } };
    const disconnected = connection.rpc;
    disconnected.close();
    const reconnectDeadline = Date.now() + 15_000;
    while ((connection.rpc === disconnected || server.state.status !== 'ready' || !server.state.detail) && Date.now() < reconnectDeadline) await new Promise(r => setTimeout(r, 25));
    expect(connection.rpc).not.toBe(disconnected);
    expect(server.state.status).toBe('ready');
    expect(server.state.detail?.thread.title).toBe('Saved chat');
    await server.stop();
    await server.start();
    expect((await settingsRpc.rpc.call<{ enableLegacyTokenStreaming: boolean }>('server.getSettings', {})).enableLegacyTokenStreaming).toBe(true);
    await server.request({ operation: 'watch', threadId });
    expect(server.state.detail?.thread.title).toBe('Saved chat');
    expect(server.state.detail?.thread.messages).toHaveLength(0);
    expect(server.state.detail?.thread.runtimeMode).toBe('full-access');
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
}, 120_000);
