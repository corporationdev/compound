import type { OrchestrationThreadDetailSnapshot, RuntimeMode } from './upstream/contracts';

/**
 * Every chat runs with full access, as the reference editor's host does: the
 * agent edits the project without approval cards. The one step down is for
 * machines whose managed policy forbids bypassing permissions.
 */
export const FULL_ACCESS: RuntimeMode = 'full-access';
export const RESTRICTED: RuntimeMode = 'auto';

/** The errors that mean "bypass is not allowed here", and nothing else. */
export function isBypassRefused(text: string | null | undefined): boolean {
  if (!text) return false;
  return /(bypass|dangerously-skip-permissions|skip.?permissions)/i.test(text) && /(disabled|not allowed|cannot|forbidden|policy|root|sudo|managed)/i.test(text);
}

/** Whether the thread's latest turn died because its policy refused full access. */
export function turnRefusedBypass(thread: OrchestrationThreadDetailSnapshot['thread'] | undefined | null): boolean {
  if (!thread || thread.runtimeMode !== FULL_ACCESS) return false;
  const latest = thread.latestTurn;
  if (!latest || latest.state !== 'error') return false;
  if (isBypassRefused(thread.session?.lastError)) return true;
  const since = latest.requestedAt;
  for (const activity of thread.activities) {
    if (activity.createdAt < since || activity.kind !== 'runtime.error') continue;
    const payload = (activity.payload ?? {}) as { message?: unknown; detail?: unknown };
    if ([payload.message, payload.detail, activity.summary].some(value => typeof value === 'string' && isBypassRefused(value))) return true;
  }
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i]!;
    if (message.role === 'user' || message.createdAt < since) break;
    if (message.role === 'assistant' && isBypassRefused(message.text)) return true;
  }
  return false;
}
