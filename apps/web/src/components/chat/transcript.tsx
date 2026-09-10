import { For, Show, createMemo } from 'solid-js';
import { buildTranscript, classifyAuthFailure, splitContext } from '@compound/chat';
import type { ToolRow } from '@compound/chat';
import type { OrchestrationThreadDetailSnapshot } from '@compound/chat/types';
import { Icon } from '@/components/ui/icon';
import { ChatAsset, ChatMarkdown } from './markdown';

function Tool(props: { row: ToolRow }) {
  const status = () => ({ running: 'Running', completed: 'Done', error: 'Failed', stopped: 'Stopped' })[props.row.status];
  const header = () => <>
    <Icon name={props.row.status === 'running' ? 'spinner-loader' : props.row.status === 'error' ? 'alert-warning' : props.row.icon} class={props.row.status === 'running' ? 'animate-spin' : ''} />
    <span class="chat-tool-label"><span>{props.row.title}</span><Show when={props.row.subtitle}><span class="chat-tool-subtitle" title={props.row.subtitle}>{props.row.subtitle}</span></Show></span>
    <span class="chat-tool-status">{status()}</span>
  </>;
  return <div class="chat-tool" classList={{ 'chat-tool-error': props.row.status === 'error' }}>
    <Show when={props.row.sections.length > 0} fallback={<div class="chat-tool-summary">{header()}</div>}>
      <details>
        <summary class="chat-tool-summary">{header()}<Icon name="chevron-right" class="chat-tool-chevron" /></summary>
        <div class="chat-tool-body"><For each={props.row.sections}>{section => <div class="chat-tool-section">
          <span class="chat-tool-section-label">{section.label}</span>
          <Show when={section.diff} fallback={<pre>{section.text}</pre>}><pre class="chat-tool-diff"><For each={section.text.split('\n')}>{line => <span classList={{ 'chat-diff-add': line.startsWith('+'), 'chat-diff-remove': line.startsWith('-') }}>{line}{'\n'}</span>}</For></pre></Show>
        </div>}</For></div>
      </details>
    </Show>
  </div>;
}

export function ChatTranscript(props: { thread: OrchestrationThreadDetailSnapshot['thread'] }) {
  const entries = createMemo(() => new Map(buildTranscript(props.thread).map(entry => [entry.id, entry])));
  // Stable keys retain disclosure state while output streams into an existing row.
  return <For each={[...entries().keys()]}>{id => {
    const entry = () => entries().get(id)!;
    const message = () => { const value = entry(); return value.kind === 'message' ? value.message : undefined; };
    return <Show when={entry().kind === 'message'} fallback={<Tool row={entry() as ToolRow} />}>
      <Show when={message()}>{current => <article class="chat-message" classList={{ 'chat-user': current().role === 'user' }}>
        <Show when={current().role === 'assistant' && classifyAuthFailure(current().text)} fallback={<ChatMarkdown threadId={props.thread.id} text={current().role === 'user' ? splitContext(current().text).text : current().text} />}>
          <p class="chat-auth-history">Response interrupted: provider sign-in required.</p>
        </Show>
        <For each={current().attachments}>{asset => <ChatAsset threadId={props.thread.id} path={asset.name} attachmentId={asset.id} mimeType={asset.mimeType} image={asset.type === 'image'} />}</For>
      </article>}</Show>
    </Show>;
  }}</For>;
}
