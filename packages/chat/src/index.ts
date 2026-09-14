import type { OrchestrationShellSnapshot, OrchestrationThreadDetailSnapshot, OrchestrationThreadStreamItem, ServerProvider, UploadChatAttachment, ProviderApprovalDecision, RuntimeMode, ProviderOptionSelections } from './upstream/contracts/index';
import { applyThreadDetailEvent } from './upstream/threadReducer';
import { derivePendingRequests } from './upstream/pendingRequests';
export { derivePendingRequests } from './upstream/pendingRequests';
export type { PendingApproval, PendingUserInput } from './upstream/pendingRequests';
export { classifyAuthFailure, threadAuthFailure } from './auth';
export type { ChatAuthFailure } from './auth';
export { thinkingDescriptor, thinkingValue, setThinkingValue, compatibleModelOptions } from './thinking';
export { buildItems } from './presentation';
export type { Item, ItemKind, ItemAsset, ItemQuestion, ToolStatus, ToolImage } from './presentation';
export { CONTEXT_START, CONTEXT_END, splitContext } from './context';

export type ChatProject = { id: string; name: string; dir: string };
export type ChatState = {
  status: 'starting' | 'ready' | 'reconnecting' | 'error' | 'stopped';
  error?: string;
  providers: readonly ServerProvider[];
  shell: OrchestrationShellSnapshot | null;
  detail: OrchestrationThreadDetailSnapshot | null;
};
export type ChatRequest =
  | { operation: 'state' | 'restart' | 'unwatch' }
  | { operation: 'project'; project: ChatProject }
  | { operation: 'create'; project: ChatProject; provider: 'codex' | 'claudeAgent'; model: string; modelOptions?: ProviderOptionSelections; runtimeMode?: RuntimeMode }
  | { operation: 'permissions'; threadId: string; runtimeMode: RuntimeMode }
  | { operation: 'watch' | 'older'; threadId: string }
  | { operation: 'send'; threadId: string; project: ChatProject; messageId: string; text: string; context: string; model: string; modelOptions?: ProviderOptionSelections; attachments: UploadChatAttachment[] }
  | { operation: 'stop' | 'archive'; threadId: string }
  | { operation: 'rename'; threadId: string; title: string }
  | { operation: 'approve'; threadId: string; requestId: string; decision: ProviderApprovalDecision }
  | { operation: 'answer'; threadId: string; requestId: string; answers: Record<string, unknown> }
  | { operation: 'refresh'; provider?: string; cwd?: string }
  | { operation: 'configure'; provider: 'codex' | 'claudeAgent'; binaryPath: string }
  | { operation: 'asset'; threadId: string; path: string; attachmentId?: string; mimeType?: string };
export type ChatReply = { state: ChatState; threadId?: string; url?: string; filePath?: string };

export const t3ProjectId = (id: string) => `compound-${id}`;

/** A snapshot is the watermark; replayed deltas at or below it never apply twice. */
export function reduceThread(snapshot: OrchestrationThreadDetailSnapshot | null, item: OrchestrationThreadStreamItem): OrchestrationThreadDetailSnapshot | null {
  if (item.kind === 'snapshot') return item.snapshot;
  if (item.kind !== 'event' || !snapshot || item.event.sequence <= snapshot.snapshotSequence) return snapshot;
  const result = applyThreadDetailEvent(snapshot.thread, item.event);
  if (result.kind === 'deleted') return null;
  return { ...snapshot, snapshotSequence: item.event.sequence, thread: result.kind === 'updated' ? result.thread : snapshot.thread };
}

export function isWorking(thread: { session?: { status: string } | null; latestTurn?: { state: string } | null } | undefined | null) {
  return thread?.session?.status === 'starting' || thread?.session?.status === 'running' || thread?.latestTurn?.state === 'running';
}

export function pendingThreadRequests(thread: OrchestrationThreadDetailSnapshot['thread'] | undefined) {
  const latest = thread?.latestTurn;
  const requests = derivePendingRequests((thread?.activities ?? []).filter(a => !latest || a.createdAt >= latest.requestedAt));
  return {
    approvals: isWorking(thread) ? requests.approvals : [],
    userInputs: requests.userInputs.filter(r => isWorking(thread) || (latest?.state === 'completed' && r.dismissible)),
  };
}
