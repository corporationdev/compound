import type { OrchestrationThreadActivity, OrchestrationThreadDetailSnapshot, ChatAttachment, UserInputQuestion } from './upstream/contracts';
import { classifyAuthFailure } from './auth';
import { splitContext } from './context';

/**
 * The transcript model the panel renders. It is the agent-chat item model:
 * one flat, ordered list of small items with stable ids, so disclosure state
 * survives a streaming snapshot being replaced wholesale.
 *
 * `reasoning` has no source in T3's orchestration read model — the server only
 * projects tool lifecycle, approvals, user input, plan and error events into
 * thread activities, and messages carry assistant text only. The kind is kept
 * so a future T3 that surfaces reasoning needs no UI change.
 */
export type ToolStatus = 'running' | 'done' | 'failed' | 'stopped';
export type ToolImage = { mediaType: string; data: string };

/** A T3 attachment on a user message, rendered through the signed-asset view. */
export type ItemAsset = { id: string; name: string; mimeType: string; type: string };

export type ItemQuestion = {
  id: string;
  header: string;
  question: string;
  options: readonly { label: string; description?: string }[];
  multiSelect: boolean;
  allowOther: boolean;
  secret: boolean;
};

export type Item =
  | { id: string; createdAt: string; kind: 'user'; text: string; attachments?: string[]; assets?: readonly ItemAsset[] }
  | { id: string; createdAt: string; kind: 'assistant'; text: string }
  | { id: string; createdAt: string; kind: 'reasoning'; text: string }
  | { id: string; createdAt: string; kind: 'tool'; name: string; title: string; detail?: string; output?: string; images?: ToolImage[]; status: ToolStatus }
  | { id: string; createdAt: string; kind: 'question'; questions: readonly ItemQuestion[]; answers: Record<string, string[]> | null }
  | { id: string; createdAt: string; kind: 'notice'; level: 'info' | 'error'; text: string };

export type ItemKind = Item['kind'];

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string' && !!value.trim()) ?? '';
const firstLine = (value: string) => { const line = value.split('\n').find(entry => entry.trim()) ?? ''; return line.length > 200 ? `${line.slice(0, 199)}…` : line; };

function inputRecord(value: unknown) {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(outputText).filter(Boolean).join('\n');
  const row = record(value);
  if (typeof row.text === 'string') return row.text;
  if (row.content !== undefined) return outputText(row.content);
  // Non-text tool content is displayed by the attachment renderer, never as base64.
  if (row.type === 'image' || row.type === 'image_url' || row.type === 'resource') return '';
  return value == null ? '' : JSON.stringify(value, null, 2);
}

function toolKey(activity: OrchestrationThreadActivity) {
  const p = record(activity.payload), data = record(p.data), item = record(data.item);
  const id = text(p.toolCallId, data.toolCallId, item.id);
  return id ? `tool:${activity.turnId ?? ''}:${text(p.agentId)}:${id}` : `activity:${activity.id}`;
}

function toolImages(value: unknown, into: ToolImage[]) {
  if (Array.isArray(value)) { for (const entry of value) toolImages(entry, into); return; }
  const row = record(value);
  if (row.content !== undefined) { toolImages(row.content, into); return; }
  const source = row.type === 'image' ? row : row.type === 'image_url' ? record(row.image_url) : undefined;
  if (!source) return;
  const data = text(source.data, source.base64, source.url);
  if (!data) return;
  const inline = /^data:([^;,]+);base64,(.*)$/.exec(data);
  if (inline) into.push({ mediaType: inline[1]!, data: inline[2]! });
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(data)) into.push({ mediaType: text(source.mediaType, source.mimeType, 'image/png'), data });
}

/** One merged tool-lifecycle activity as the row the panel shows. */
function presentTool(activity: OrchestrationThreadActivity, id: string, createdAt: string, running: boolean): Item {
  const p = record(activity.payload), data = record(p.data), item = record(data.item);
  const input = inputRecord(data.input ?? item.arguments ?? p.input);
  const name = text(data.toolName, item.tool, p.toolName, p.title, activity.summary).replace(/\s+(started|completed|updated)$/i, '');
  const type = text(p.itemType);
  const command = text(input.command, input.cmd, item.command, data.command, p.command);
  const files = Array.isArray(item.changes) ? item.changes : Array.isArray(data.files) ? data.files : [];
  const paths = files.map(file => typeof file === 'string' ? file : text(record(file).path)).filter(Boolean);
  const path = text(input.file_path, input.path, data.path, paths.join(', '));
  const normalized = name.toLowerCase().replace(/[\s_-]/g, '');
  const action = /^(bash|shell|terminal|execcommand|executecommand|runcommand)$/.test(normalized) || type === 'command_execution' ? 'command'
    : /^(read|readfile)$/.test(normalized) ? 'read'
    : /^(edit|write|editfile|writefile|applypatch|multiedit)$/.test(normalized) || type === 'file_change' ? 'edit'
    : /^(grep|glob|search|searchfiles|websearch)$/.test(normalized) || type === 'web_search' ? 'search' : 'other';
  const failed = activity.tone === 'error' || /failed|error|denied/.test(text(p.status, item.status)) || data.isError === true || data.is_error === true || (typeof item.exitCode === 'number' && item.exitCode !== 0);
  const complete = activity.kind === 'tool.completed' || /completed|success/.test(text(p.status, item.status));
  const status: ToolStatus = failed ? 'failed' : complete ? 'done' : running ? 'running' : 'stopped';
  const titles = { command: 'Run command', read: 'Read file', edit: 'Edit file', search: 'Search', other: name.replace(/_/g, ' ') || 'Tool' };

  const sections: { label: string; text: string }[] = [];
  const add = (label: string, value: string) => { if (value.trim() && !sections.some(s => s.text === value)) sections.push({ label, text: value }); };
  const oldText = text(input.old_string), newText = text(input.new_string);
  const diff = text(p.diff, data.diff, item.diff, ...files.map(f => record(f).diff));
  if (diff) add('Changes', diff);
  else if (oldText || newText) add('Changes', [...oldText.split('\n').filter(() => !!oldText).map(line => `- ${line}`), ...newText.split('\n').filter(() => !!newText).map(line => `+ ${line}`)].join('\n'));
  else if (action === 'edit') add('Content', text(input.content));
  const raw = data.input ?? item.arguments ?? p.input;
  if (action === 'other') add('Input', outputText(raw));
  const result = item.aggregatedOutput ?? item.output ?? data.output ?? p.output ?? data.result ?? item.result ?? p.result;
  add('Output', outputText(result));
  const trailing = text(p.detail, data.detail);
  if (trailing && trailing !== command && trailing !== path) add(failed ? 'Error' : 'Details', trailing);

  const query = text(input.pattern, input.query, p.query);
  // One line under the title: what this call is actually about.
  const detail = firstLine(text(command, path, query, action === 'other' ? trailing : '', outputText(raw)));
  const images: ToolImage[] = [];
  toolImages(result, images);
  const output = sections.map(section => sections.length > 1 ? `${section.label}\n${section.text}` : section.text).join('\n\n');
  return {
    id, kind: 'tool', createdAt, name: name || action, title: titles[action], status,
    ...(detail ? { detail } : {}),
    ...(output.trim() ? { output } : {}),
    ...(images.length ? { images } : {}),
  };
}

const toQuestion = (question: UserInputQuestion): ItemQuestion => ({
  id: question.id,
  header: question.header,
  question: question.question,
  options: question.options.map(option => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
  multiSelect: question.multiSelect === true,
  allowOther: question.allowCustomAnswer !== false,
  secret: false,
});

const asAnswers = (value: unknown): Record<string, string[]> | null => {
  const source = record(value);
  const entries = Object.entries(source).map(([key, answer]) => [key, Array.isArray(answer) ? answer.map(String) : answer == null ? [] : [String(answer)]] as const);
  return entries.length ? Object.fromEntries(entries) : null;
};

/** Activity kinds whose whole purpose is an interactive card, not a transcript row. */
const requestKinds = /^(approval|user-input|request)[.-]/;
/** Routine telemetry: never a row. */
const noiseKinds = new Set(['context-window.updated', 'context-compaction', 'checkpoint.captured', 'task.progress', 'tool.progress', 'provider.auth.signed-out']);

/**
 * The thread as ordered items. Tool lifecycle events are merged by call id so a
 * row keeps its identity (and its open/closed state) while output streams in.
 */
export function buildItems(thread: OrchestrationThreadDetailSnapshot['thread']): Item[] {
  const activities = [...thread.activities].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0));
  const live = thread.session?.status === 'running' || thread.session?.status === 'starting' || thread.latestTurn?.state === 'running';

  const tools = new Map<string, { activity: OrchestrationThreadActivity; createdAt: string }>();
  const asked = new Map<string, { createdAt: string; questions: ItemQuestion[] }>();
  const answered = new Map<string, Record<string, string[]> | null>();
  const notices: Item[] = [];

  for (const activity of activities) {
    if (noiseKinds.has(activity.kind)) continue;
    if (activity.kind === 'user-input.requested') {
      const payload = record(activity.payload);
      const questions = (Array.isArray(payload.questions) ? payload.questions : []).filter((q): q is UserInputQuestion => !!record(q).id).map(toQuestion);
      if (questions.length && typeof payload.requestId === 'string') asked.set(payload.requestId, { createdAt: activity.createdAt, questions });
      continue;
    }
    if (activity.kind === 'user-input.resolved') {
      const payload = record(activity.payload);
      if (typeof payload.requestId === 'string') answered.set(payload.requestId, asAnswers(payload.answers));
      continue;
    }
    if (requestKinds.test(activity.kind)) continue;
    if (activity.tone === 'info' && (activity.kind === 'runtime.warning' || activity.kind.endsWith('.failed'))) {
      const detail = text(record(activity.payload).detail, record(activity.payload).message, activity.summary);
      if (detail) notices.push({ id: `notice:${activity.id}`, createdAt: activity.createdAt, kind: 'notice', level: 'info', text: detail });
      continue;
    }
    if (activity.tone !== 'tool' && activity.tone !== 'error') continue;
    if (classifyAuthFailure(activity.summary)) continue;
    // A runtime error is a notice, not a tool row: it has no call to expand.
    if (activity.tone === 'error' && activity.kind === 'runtime.error') {
      const detail = text(record(activity.payload).message, record(activity.payload).detail, activity.summary);
      if (detail && !classifyAuthFailure(detail)) notices.push({ id: `notice:${activity.id}`, createdAt: activity.createdAt, kind: 'notice', level: 'error', text: detail });
      continue;
    }
    const id = toolKey(activity), previous = tools.get(id);
    if (previous?.activity.kind === 'tool.completed' && activity.kind !== 'tool.completed') continue;
    const oldPayload = record(previous?.activity.payload), payload = record(activity.payload);
    const merged = { ...activity, payload: { ...oldPayload, ...payload, data: { ...record(oldPayload.data), ...record(payload.data), item: { ...record(record(oldPayload.data).item), ...record(record(payload.data).item) } } } };
    tools.set(id, { activity: merged, createdAt: previous?.createdAt ?? activity.createdAt });
  }

  const items: Item[] = [];
  for (const message of thread.messages) {
    const id = `message:${message.id}`;
    if (message.role === 'user') {
      const assets = (message.attachments ?? []) as readonly ChatAttachment[];
      items.push({
        id, createdAt: message.createdAt, kind: 'user', text: splitContext(message.text).text,
        ...(assets.length ? { assets: assets.map(asset => ({ id: asset.id, name: asset.name, mimeType: asset.mimeType, type: asset.type })) } : {}),
      });
      continue;
    }
    if (message.role === 'system') { items.push({ id, createdAt: message.createdAt, kind: 'notice', level: 'info', text: message.text }); continue; }
    // An interrupted sign-in is a notice; the raw provider diagnostic is not chat.
    if (classifyAuthFailure(message.text)) { items.push({ id, createdAt: message.createdAt, kind: 'notice', level: 'error', text: 'Response interrupted: provider sign-in required.' }); continue; }
    items.push({ id, createdAt: message.createdAt, kind: 'assistant', text: message.text });
  }
  for (const [id, { activity, createdAt }] of tools) {
    items.push(presentTool(activity, id, createdAt, live && activity.turnId === thread.latestTurn?.turnId));
  }
  for (const [requestId, { createdAt, questions }] of asked) {
    if (!answered.has(requestId)) continue;
    items.push({ id: `question:${requestId}`, createdAt, kind: 'question', questions, answers: answered.get(requestId) ?? null });
  }
  for (const plan of thread.proposedPlans) {
    items.push({ id: `plan:${plan.id}`, createdAt: plan.createdAt, kind: 'assistant', text: plan.planMarkdown });
  }
  items.push(...notices);
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
