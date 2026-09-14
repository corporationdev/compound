import { expect, test } from 'bun:test';
import { buildItems, type Item } from '../src/presentation';
import type { OrchestrationThreadActivity, OrchestrationThreadDetailSnapshot } from '../src/upstream/contracts';
type Thread = OrchestrationThreadDetailSnapshot['thread'];
type Tool = Extract<Item, { kind: 'tool' }>;
const activity = (id: string, kind: string, second: number, payload: unknown, tone = 'tool') => ({ id, kind, createdAt: `2026-09-09T12:00:0${second}.000Z`, turnId: 'turn-1', summary: 'Tool', payload, tone }) as OrchestrationThreadActivity;
const thread = (activities: OrchestrationThreadActivity[], messages: unknown[] = [], state = 'completed') => ({ activities, messages, proposedPlans: [], latestTurn: { turnId: 'turn-1', state }, session: { status: state === 'running' ? 'running' : 'ready' } }) as unknown as Thread;

test('hides context telemetry, keeping actual work between messages', () => {
  const items = buildItems(thread([
    activity('context', 'context-window.updated', 4, { usedTokens: 37468 }, 'info'),
    activity('read', 'tool.completed', 2, { toolCallId: 'read', data: { toolName: 'Read', input: { file_path: '/project/main.tsx' }, result: 'file content' } }),
  ], [{ id: 'u', role: 'user', text: 'Hi', createdAt: '2026-09-09T12:00:01.000Z' }, { id: 'a', role: 'assistant', text: 'Done', createdAt: '2026-09-09T12:00:03.000Z' }]));
  expect(items.map(i => i.kind)).toEqual(['user', 'tool', 'assistant']);
  const tool = items[1] as Tool;
  expect(tool.title).toBe('Read file');
  expect(tool.detail).toBe('/project/main.tsx');
  expect(tool.output).toBe('file content');
});
test('merges Claude lifecycle updates without losing input or moving the row', () => {
  const items = buildItems(thread([
    activity('s', 'tool.started', 1, { toolCallId: 'bash1', data: { toolName: 'Bash', input: { command: 'pwd' } } }),
    activity('u', 'tool.updated', 2, { toolCallId: 'bash1', detail: 'Running command' }),
    activity('c', 'tool.completed', 3, { toolCallId: 'bash1', data: { result: [{ type: 'text', text: '/project' }] } }),
  ]));
  expect(items).toHaveLength(1);
  const row = items[0] as Tool;
  expect(row.createdAt).toContain('00:01.');
  expect(row.id).toBe('tool:turn-1::bash1');
  expect(row.title).toBe('Run command');
  expect(row.status).toBe('done');
  expect(row.detail).toBe('pwd');
  expect(row.output).toContain('/project');
});
test('Codex command output and failures use native item fields', () => {
  const row = buildItems(thread([activity('c', 'tool.completed', 2, { itemType: 'command_execution', toolCallId: 'c', data: { item: { command: 'bun test', aggregatedOutput: '1 test failed', exitCode: 1 } } })]))[0] as Tool;
  expect(row.status).toBe('failed');
  expect(row.detail).toBe('bun test');
  expect(row.output).toContain('1 test failed');
});
test('calls with the same name stay separate; interrupted calls stop spinning', () => {
  const items = buildItems(thread(['a', 'b'].map((id, i) => activity(id, 'tool.started', i, { toolCallId: id, data: { toolName: 'Read' } }))));
  expect(items).toHaveLength(2);
  expect(items.every(i => i.kind === 'tool' && i.status === 'stopped')).toBe(true);
  const live = buildItems(thread([activity('a', 'tool.started', 1, { toolCallId: 'a' })], [], 'running'))[0] as Tool;
  expect(live.status).toBe('running');
});
test('edits show a diff; unknown tools expose only their input/output', () => {
  const items = buildItems(thread([
    activity('edit', 'tool.completed', 1, { toolCallId: 'e', data: { toolName: 'Edit', input: { file_path: 'main.tsx', old_string: 'old', new_string: 'new' } } }),
    activity('custom', 'tool.completed', 2, { toolCallId: 'x', title: 'custom_tool', internalTokenCount: 999, data: { input: { query: 'hello' }, result: { answer: 42 } } }),
  ])) as Tool[];
  expect(items[0]?.output).toContain('- old\n+ new');
  expect(JSON.stringify(items)).not.toContain('internalTokenCount');
  expect(items[1]?.output).toContain('42');
});
test('answered questions become a compact record, and context never reaches the user item', () => {
  const items = buildItems(thread([
    activity('q', 'user-input.requested', 1, { requestId: 'r1', questions: [{ id: 'fmt', header: 'Format', question: 'Which format?', options: [{ label: '9:16', description: 'Vertical' }], multiSelect: false }] }, 'info'),
    activity('a', 'user-input.resolved', 2, { requestId: 'r1', answers: { fmt: ['9:16'] } }, 'info'),
  ], [{ id: 'u', role: 'user', text: 'Cut it\n\n<compound-context>\nProject ID: x\n</compound-context>', createdAt: '2026-09-09T12:00:00.000Z' }]));
  expect(items.map(i => i.kind)).toEqual(['user', 'question', 'assistant'].slice(0, 2));
  expect(items[0]).toMatchObject({ kind: 'user', text: 'Cut it' });
  expect(items[1]).toMatchObject({ kind: 'question', answers: { fmt: ['9:16'] } });
});
test('runtime errors are notices, and expired logins never appear raw', () => {
  const items = buildItems(thread([
    activity('e', 'runtime.error', 1, { message: 'Provider crashed' }, 'error'),
  ], [{ id: 'a', role: 'assistant', text: 'OAuth token expired', createdAt: '2026-09-09T12:00:02.000Z' }]));
  expect(items[0]).toMatchObject({ kind: 'notice', level: 'error', text: 'Provider crashed' });
  expect(items[1]).toMatchObject({ kind: 'notice', text: 'Response interrupted: provider sign-in required.' });
});
