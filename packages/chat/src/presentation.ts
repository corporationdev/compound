import type { OrchestrationMessage, OrchestrationThreadActivity, OrchestrationThreadDetailSnapshot } from './upstream/contracts';
import { classifyAuthFailure } from './auth';

export type ToolRow = {
  id: string; kind: 'tool'; createdAt: string; turnId: string | null;
  title: string; subtitle: string; icon: string;
  status: 'running' | 'completed' | 'error' | 'stopped';
  sections: { label: string; text: string; diff?: boolean }[];
};
export type TranscriptEntry = { id: string; kind: 'message'; createdAt: string; message: OrchestrationMessage } | ToolRow;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string' && !!value.trim()) ?? '';
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
function presentTool(activity: OrchestrationThreadActivity, id: string, createdAt: string, running: boolean): ToolRow {
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
  const status = failed ? 'error' : complete ? 'completed' : running ? 'running' : 'stopped';
  const titles = { command: 'Run command', read: 'Read file', edit: 'Edit file', search: 'Search', other: name.replace(/_/g, ' ') || 'Tool' };
  const icons = { command: 'terminal', read: 'compound-project-file', edit: 'pencil', search: 'search', other: 'action-bar-spotlight' };
  const sections: ToolRow['sections'] = [];
  const add = (label: string, value: string, diff = false) => { if (value.trim() && !sections.some(s => s.text === value)) sections.push({ label, text: value, diff }); };
  if (command) add('Command', command);
  if (path) add('File', path);
  const oldText = text(input.old_string), newText = text(input.new_string);
  const diff = text(p.diff, data.diff, item.diff, ...files.map(f => record(f).diff));
  if (diff) add('Changes', diff, true);
  else if (oldText || newText) add('Changes', [...oldText.split('\n').filter(() => !!oldText).map(line => `- ${line}`), ...newText.split('\n').filter(() => !!newText).map(line => `+ ${line}`)].join('\n'), true);
  else if (action === 'edit') add('Content', text(input.content));
  const query = text(input.pattern, input.query, p.query);
  if (query) add('Search', query);
  if (action === 'other') add('Input', outputText(data.input ?? item.arguments ?? p.input));
  add('Output', outputText(item.aggregatedOutput ?? item.output ?? data.output ?? p.output ?? data.result ?? item.result ?? p.result));
  const detail = text(p.detail, data.detail);
  if (detail && detail !== command && detail !== path) add(failed ? 'Error' : 'Details', detail);
  return { id, kind: 'tool', createdAt, turnId: activity.turnId, title: titles[action], subtitle: path || command || query || (action === 'other' ? detail : ''), icon: icons[action], status, sections };
}

/** Keep only visible work, merge lifecycle events, and place it alongside messages. */
export function buildTranscript(thread: OrchestrationThreadDetailSnapshot['thread']): TranscriptEntry[] {
  const tools = new Map<string, { activity: OrchestrationThreadActivity; createdAt: string }>();
  const activities = [...thread.activities].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0));
  for (const activity of activities) {
    if (activity.tone !== 'tool' && activity.tone !== 'error') continue;
    if (classifyAuthFailure(activity.summary)) continue;
    // Approval/user-input requests have their own interactive UI.
    if (/^(approval|user-input|request)[.-]/.test(activity.kind)) continue;
    const id = toolKey(activity), previous = tools.get(id);
    if (previous?.activity.kind === 'tool.completed' && activity.kind !== 'tool.completed') continue;
    const oldPayload = record(previous?.activity.payload), payload = record(activity.payload);
    const merged = { ...activity, payload: { ...oldPayload, ...payload, data: { ...record(oldPayload.data), ...record(payload.data), item: { ...record(record(oldPayload.data).item), ...record(record(payload.data).item) } } } };
    tools.set(id, { activity: merged, createdAt: previous?.createdAt ?? activity.createdAt });
  }
  const entries: TranscriptEntry[] = thread.messages.map(message => ({ id: `message:${message.id}`, kind: 'message', createdAt: message.createdAt, message }));
  for (const [id, { activity, createdAt }] of tools) {
    const live = (thread.session?.status === 'running' || thread.session?.status === 'starting' || thread.latestTurn?.state === 'running') && activity.turnId === thread.latestTurn?.turnId;
    entries.push(presentTool(activity, id, createdAt, live));
  }
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
