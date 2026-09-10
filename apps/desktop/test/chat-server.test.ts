import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { ChatServer, projectCliCommand } from '../src/chat-server';

test('chat CLI invocation preserves exact app, socket and project through a shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compound-cli-command-'));
  const bin = join(dir, "App's CLI bin");
  const socket = join(dir, "socket '$() file");
  const project = join(dir, "project '$HOME $(echo wrong)");
  try {
    await mkdir(bin);
    await writeFile(join(bin, 'compound'), '#!/bin/sh\nprintf "%s\\n" "$COMPOUND_CLI_SOCKET" "$@"\n');
    await chmod(join(bin, 'compound'), 0o755);
    const output = execFileSync('/bin/sh', ['-c', projectCliCommand(bin, socket, project) + ' context'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(output.trimEnd().split('\n')).toEqual([socket, '--project', project, 'context']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Explicit opt-in: starts the staged server and probes installed providers,
// but never submits a model turn or changes a user's provider credentials.
test.skipIf(process.env.COMPOUND_TEST_CHAT_RUNTIME !== '1')('packaged T3 authenticates, persists threads, streams metadata, and signs assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compound-chat-runtime-test-'));
  const server = new ChatServer({ runtimeDir: resolve(import.meta.dir, '../chat-runtime'), dataDir: join(dir, 'state'), cliBinDir: resolve(import.meta.dir, '../../../node_modules/.bin'), cliSocketPath: join(dir, 'app.sock'), validateProject: async p => p, changed: () => {} });
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
    const reply = await server.request({ operation: 'create', project, provider: 'codex', model: 'gpt-5.6-sol', modelOptions: [{ id: 'reasoningEffort', value: 'high' }] });
    const threadId = reply.threadId!;
    await server.request({ operation: 'watch', threadId });
    expect(server.state.detail?.thread.projectId).toBe('compound-test-project');
    expect(server.state.detail?.thread.runtimeMode).toBe('approval-required');
    expect(server.state.detail?.thread.modelSelection.options).toEqual([{ id: 'reasoningEffort', value: 'high' }]);
    for (const runtimeMode of ['auto-accept-edits', 'auto', 'full-access', 'approval-required'] as const) {
      await server.request({ operation: 'permissions', threadId, runtimeMode });
      const deadline = Date.now() + 5000;
      while (server.state.detail?.thread.runtimeMode !== runtimeMode && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
      expect(server.state.detail?.thread.runtimeMode).toBe(runtimeMode);
    }
    const custom = await server.request({ operation: 'create', project, provider: 'claudeAgent', model: 'claude-sonnet-4-6', runtimeMode: 'auto-accept-edits', modelOptions: [{ id: 'effort', value: 'low' }] });
    await server.request({ operation: 'watch', threadId: custom.threadId! });
    expect(server.state.detail?.thread.runtimeMode).toBe('auto-accept-edits');
    expect(server.state.detail?.thread.modelSelection.options).toEqual([{ id: 'effort', value: 'low' }]);
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
    expect(server.state.detail?.thread.modelSelection.options).toEqual([{ id: 'reasoningEffort', value: 'high' }]);
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
}, 120_000);
