import { expect, test } from 'bun:test';
import { isBypassRefused, turnRefusedBypass } from '../src/policy';
import type { OrchestrationThreadDetailSnapshot } from '../src/upstream/contracts/index';

const date = '2026-01-01T00:00:00.000Z';
const later = '2026-01-01T00:00:01.000Z';
const thread = (overrides: Partial<OrchestrationThreadDetailSnapshot['thread']>): OrchestrationThreadDetailSnapshot['thread'] => ({
  id: 'thread-a', projectId: 'project-a', title: 'Test', modelSelection: { instanceId: 'claudeAgent', model: 'test' }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
  latestTurn: { turnId: 'turn-a', state: 'error', requestedAt: date, startedAt: date, completedAt: later, assistantMessageId: null },
  createdAt: date, updatedAt: later, deletedAt: null, messages: [], activities: [], checkpoints: [], session: null, ...overrides,
} as OrchestrationThreadDetailSnapshot['thread']);

const refused = 'Claude Code process exited with code 1\n--dangerously-skip-permissions is disabled by your organization policy';

test('only a refused bypass counts, not ordinary failures that mention permissions', () => {
  expect(isBypassRefused(refused)).toBe(true);
  expect(isBypassRefused('Permission denied: Bash requires approval')).toBe(false);
  expect(isBypassRefused('Claude Code process exited with code 1')).toBe(false);
  expect(isBypassRefused(undefined)).toBe(false);
});

test('a refusal is found in the session, a runtime error, or the reply, but only for this turn', () => {
  expect(turnRefusedBypass(thread({ session: { status: 'error', lastError: refused } as never }))).toBe(true);
  expect(turnRefusedBypass(thread({ activities: [{ id: 'a', kind: 'runtime.error', tone: 'error', summary: 'Runtime error', createdAt: later, turnId: 'turn-a', payload: { message: refused } } as never] }))).toBe(true);
  expect(turnRefusedBypass(thread({ messages: [{ id: 'm', role: 'assistant', text: refused, createdAt: later } as never] }))).toBe(true);
  // An older refusal must not fire again after a later turn.
  expect(turnRefusedBypass(thread({ messages: [{ id: 'm', role: 'assistant', text: refused, createdAt: '2025-12-31T00:00:00.000Z' } as never] }))).toBe(false);
  expect(turnRefusedBypass(thread({ runtimeMode: 'auto', session: { status: 'error', lastError: refused } as never }))).toBe(false);
  expect(turnRefusedBypass(thread({ latestTurn: null, session: { status: 'error', lastError: refused } as never }))).toBe(false);
});
