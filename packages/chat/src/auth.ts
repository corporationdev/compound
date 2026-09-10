import type { OrchestrationThreadDetailSnapshot } from './upstream/contracts';

export type ChatAuthFailure = 'expired' | 'required';

/** Recognize provider diagnostics, not ordinary chat about authentication. */
export function classifyAuthFailure(text: string | null | undefined): ChatAuthFailure | undefined {
  const message = text?.trim().replace(/^Error:\s*/i, '');
  if (!message) return;
  if (/^(?:Failed to authenticate:\s*)?OAuth (?:session|token) (?:has )?expired\b/i.test(message)
    || /^(?:Your )?(?:authentication|refresh) token (?:has )?expired\b/i.test(message)) return 'expired';
  if (/^(?:Claude (?:Code|SDK)|Codex)(?: is)? (?:not authenticated|not logged in|signed out)\b/i.test(message)
    || /^Failed to authenticate(?:$|:)/i.test(message)
    || /^(?:Not logged in|Authentication required|Invalid authentication token)\b/i.test(message)) return 'required';
}

export function threadAuthFailure(thread: OrchestrationThreadDetailSnapshot['thread'] | undefined): ChatAuthFailure | undefined {
  const sessionFailure = classifyAuthFailure(thread?.session?.lastError);
  if (sessionFailure === 'expired') return sessionFailure;
  if (!thread || (thread.latestTurn?.state !== 'error' && thread.session?.status !== 'error')) return sessionFailure;
  // An older failed response must not block a later successful turn.
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i]!;
    if (message.role === 'user') break;
    if (thread.latestTurn && message.createdAt < thread.latestTurn.requestedAt) break;
    if (message.role === 'assistant') {
      const failure = classifyAuthFailure(message.text);
      if (failure) return failure;
    }
  }
  return sessionFailure;
}
