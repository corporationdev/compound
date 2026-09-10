import { expect, test } from 'bun:test';
import { classifyAuthFailure, threadAuthFailure } from '../src/auth';
import type { OrchestrationThreadDetailSnapshot } from '../src/upstream/contracts';

type Thread = OrchestrationThreadDetailSnapshot['thread'];
const expired = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const signedOut = "Claude SDK not authenticated. For subscription login, run 'claude auth login' on this environment’s machine, then start a new thread. For API-key authentication, check this instance’s configured credentials.";
const fixture = (state: string, text: string, lastError: string | null = null) => ({
  latestTurn: { state, requestedAt: '2026-09-09T12:00:00.000Z' },
  session: { status: state === 'error' ? 'error' : 'ready', lastError },
  messages: [{ role: 'user', text: 'Hello', createdAt: '2026-09-09T12:00:00.000Z' }, { role: 'assistant', text, createdAt: '2026-09-09T12:00:01.000Z' }],
}) as Thread;

test('recognizes both Claude diagnostics from an expired OAuth turn', () => {
  expect(classifyAuthFailure(expired)).toBe('expired');
  expect(classifyAuthFailure(signedOut)).toBe('required');
  expect(threadAuthFailure(fixture('error', expired, signedOut))).toBe('expired');
});
test('recognizes Codex signed-out and expired refresh-token failures', () => {
  expect(classifyAuthFailure('Codex is not authenticated. Please log in.')).toBe('required');
  expect(classifyAuthFailure('Your authentication token has expired. Please sign in again.')).toBe('expired');
});
test('ordinary text, rate limits, permissions and local-server failures remain separate', () => {
  for (const text of ['What does OAuth session expired mean?', 'Failed to authenticate means the login did not work.', 'Rate limit reached', 'Permission denied', 'Chat authentication failed (401)', 'Tool failed: HTTP 401']) expect(classifyAuthFailure(text)).toBeUndefined();
  expect(threadAuthFailure(fixture('completed', 'Here is how to handle OAuth expiration.'))).toBeUndefined();
});
test('a historical auth failure does not block a successful or newer turn', () => {
  expect(threadAuthFailure(fixture('completed', expired))).toBeUndefined();
  const thread = fixture('error', expired);
  expect(threadAuthFailure({ ...thread, latestTurn: { ...thread.latestTurn!, requestedAt: '2026-09-09T13:00:00.000Z' } })).toBeUndefined();
});
