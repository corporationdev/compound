import { expect, test } from 'bun:test';
import * as Schema from 'effect/Schema';
import { CONTEXT_END, CONTEXT_START, derivePendingRequests, pendingThreadRequests, reduceThread, splitContext } from '../src';
import { OrchestrationThreadDetailSnapshot } from '../src/upstream/contracts';
import type { OrchestrationThreadStreamItem, OrchestrationThreadActivity } from '../src/upstream/contracts';

const date = '2026-09-09T00:00:00.000Z';
const snapshot = () => Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot)({ snapshotSequence: 10, thread: {
  id: 'thread-a', projectId: 'project-a', title: 'Test', modelSelection: { instanceId: 'codex', model: 'test' }, runtimeMode: 'approval-required', interactionMode: 'default', branch: null, worktreePath: null, latestTurn: null, createdAt: date, updatedAt: date, deletedAt: null, messages: [], activities: [], checkpoints: [], session: null,
} });
const message = (sequence: number, text: string, streaming = true): OrchestrationThreadStreamItem => ({ kind: 'event', event: {
  sequence, type: 'thread.message-sent', occurredAt: date, payload: { threadId: 'thread-a', messageId: 'message-a', role: 'assistant', text, streaming, turnId: 'turn-a', createdAt: date, updatedAt: date },
} } as OrchestrationThreadStreamItem);

test('stream replay does not duplicate deltas; final text replaces streamed content', () => {
  let state = reduceThread(snapshot(), message(11, 'Hello'));
  state = reduceThread(state, message(11, 'Hello'));
  state = reduceThread(state, message(12, ' world'));
  expect(state?.thread.messages[0]?.text).toBe('Hello world');
  state = reduceThread(state, message(13, 'Hello world!', false));
  expect(state?.thread.messages).toHaveLength(1);
  expect(state?.thread.messages[0]?.text).toBe('Hello world!');
});
test('a reconnect snapshot replaces local state and rejects replay below its watermark', () => {
  const loaded = reduceThread(snapshot(), message(11, 'Hello'))!;
  const reconnected = reduceThread(loaded, { kind: 'snapshot', snapshot: { ...loaded, snapshotSequence: 20 } });
  expect(reduceThread(reconnected, message(11, 'Hello'))?.thread.messages[0]?.text).toBe('Hello');
});
test('closed approvals stay closed even when request events arrive out of order', () => {
  const activity = (kind: string): OrchestrationThreadActivity => ({ id: kind, kind, tone: 'approval', summary: kind, createdAt: date, turnId: null, payload: { requestId: 'approval-a', requestKind: 'command' } } as OrchestrationThreadActivity);
  expect(derivePendingRequests([activity('approval.resolved'), activity('approval.requested')]).approvals).toHaveLength(0);
  expect(derivePendingRequests([activity('approval.requested')]).approvals).toHaveLength(1);
});
test('user text and the appended project context round-trip separately', () => {
  const text = 'Change the heading';
  expect(splitContext(text + CONTEXT_START + 'project-a' + CONTEXT_END)).toEqual({ text, context: 'project-a' });
  expect(splitContext('ordinary <compound-context> text')).toEqual({ text: 'ordinary <compound-context> text', context: '' });
});
test('stopping a turn hides stale approvals and they do not reappear next turn', () => {
  const thread = snapshot().thread;
  const activity = { id: 'request-a', kind: 'approval.requested', tone: 'approval', summary: 'Approval', createdAt: date, turnId: null, payload: { requestId: 'approval-a', requestKind: 'command' } } as OrchestrationThreadActivity;
  const latest = { turnId: 'turn-a', state: 'running', requestedAt: date, startedAt: date, completedAt: null, assistantMessageId: null } as NonNullable<typeof thread.latestTurn>;
  expect(pendingThreadRequests({ ...thread, activities: [activity], latestTurn: latest }).approvals).toHaveLength(1);
  expect(pendingThreadRequests({ ...thread, activities: [activity], latestTurn: { ...latest, state: 'interrupted' } }).approvals).toHaveLength(0);
  expect(pendingThreadRequests({ ...thread, activities: [activity], latestTurn: { ...latest, requestedAt: '2026-09-09T01:00:00.000Z' } }).approvals).toHaveLength(0);
});
