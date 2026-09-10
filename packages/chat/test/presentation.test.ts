import { expect, test } from 'bun:test';
import { buildTranscript, type ToolRow } from '../src/presentation';
import type { OrchestrationThreadActivity, OrchestrationThreadDetailSnapshot } from '../src/upstream/contracts';
type Thread = OrchestrationThreadDetailSnapshot['thread'];
const activity = (id: string, kind: string, second: number, payload: unknown, tone = 'tool') => ({ id, kind, createdAt: `2026-09-09T12:00:0${second}.000Z`, turnId: 'turn-1', summary: 'Tool', payload, tone }) as OrchestrationThreadActivity;
const thread = (activities: OrchestrationThreadActivity[], messages: unknown[] = [], state = 'completed') => ({ activities, messages, latestTurn: { turnId: 'turn-1', state }, session: { status: state === 'running' ? 'running' : 'ready' } }) as Thread;

test('hides context telemetry, keeping actual work between messages', () => {
  const rows = buildTranscript(thread([
    activity('context', 'context-window.updated', 4, { usedTokens: 37468 }, 'info'),
    activity('read', 'tool.completed', 2, { toolCallId: 'read', data: { toolName: 'Read', input: { file_path: '/project/main.tsx' }, result: 'file content' } }),
  ], [{ id: 'u', role: 'user', text: 'Hi', createdAt: '2026-09-09T12:00:01.000Z' }, { id: 'a', role: 'assistant', text: 'Done', createdAt: '2026-09-09T12:00:03.000Z' }]));
  expect(rows.map(r => r.kind)).toEqual(['message', 'tool', 'message']);
  expect((rows[1] as ToolRow).title).toBe('Read file');
  expect((rows[1] as ToolRow).sections).toContainEqual({ label: 'Output', text: 'file content', diff: false });
});
test('merges Claude lifecycle updates without losing input or moving the row', () => {
  const rows = buildTranscript(thread([
    activity('s', 'tool.started', 1, { toolCallId: 'bash1', data: { toolName: 'Bash', input: { command: 'pwd' } } }),
    activity('u', 'tool.updated', 2, { toolCallId: 'bash1', detail: 'Running command' }),
    activity('c', 'tool.completed', 3, { toolCallId: 'bash1', data: { result: [{ type: 'text', text: '/project' }] } }),
  ]));
  expect(rows).toHaveLength(1);
  const row = rows[0] as ToolRow;
  expect(row.createdAt).toContain('00:01.');
  expect(row.title).toBe('Run command');
  expect(row.status).toBe('completed');
  expect(row.sections.map(s => s.text)).toContain('pwd');
  expect(row.sections.map(s => s.text)).toContain('/project');
});
test('Codex command output and failures use native item fields', () => {
  const row = buildTranscript(thread([activity('c', 'tool.completed', 2, { itemType: 'command_execution', toolCallId: 'c', data: { item: { command: 'bun test', aggregatedOutput: '1 test failed', exitCode: 1 } } })]))[0] as ToolRow;
  expect(row.status).toBe('error');
  expect(row.subtitle).toBe('bun test');
  expect(row.sections.map(s => s.text)).toContain('1 test failed');
});
test('calls with the same name stay separate; interrupted calls stop spinning', () => {
  const rows = buildTranscript(thread(['a', 'b'].map((id, i) => activity(id, 'tool.started', i, { toolCallId: id, data: { toolName: 'Read' } }))));
  expect(rows).toHaveLength(2);
  expect(rows.every(r => r.kind === 'tool' && r.status === 'stopped')).toBe(true);
  const live = buildTranscript(thread([activity('a', 'tool.started', 1, { toolCallId: 'a' })], [], 'running'))[0] as ToolRow;
  expect(live.status).toBe('running');
});
test('edits show a diff; unknown tools expose only their input/output', () => {
  const rows = buildTranscript(thread([
    activity('edit', 'tool.completed', 1, { toolCallId: 'e', data: { toolName: 'Edit', input: { file_path: 'main.tsx', old_string: 'old', new_string: 'new' } } }),
    activity('custom', 'tool.completed', 2, { toolCallId: 'x', title: 'custom_tool', internalTokenCount: 999, data: { input: { query: 'hello' }, result: { answer: 42 } } }),
  ])) as ToolRow[];
  expect(rows[0]?.sections.find(s => s.diff)?.text).toBe('- old\n+ new');
  expect(JSON.stringify(rows)).not.toContain('internalTokenCount');
  expect(rows[1]?.sections.find(s => s.label === 'Output')?.text).toContain('42');
});
