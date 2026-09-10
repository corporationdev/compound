import { For, Show, createSignal } from 'solid-js';
import type { PendingApproval, PendingUserInput, ChatRequest } from '@compound/chat';

export function ChatApproval(props: { request: PendingApproval; threadId: string; send: (request: ChatRequest) => Promise<unknown> }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  return <div class="chat-request">
    <strong>Approval needed</strong>
    <p>{props.request.detail || props.request.requestKind}</p>
    <div class="chat-actions"><For each={props.request.options ?? [{ decision: 'accept' as const, label: 'Allow once' }, { decision: 'decline' as const, label: 'Decline' }]}>{option => <button disabled={busy()} title={option.warning} onClick={async () => {
      setBusy(true); setError('');
      try { await props.send({ operation: 'approve', threadId: props.threadId, requestId: props.request.requestId, decision: option.decision }); }
      catch (error) { setError((error as Error).message); }
      finally { setBusy(false); }
    }}>{option.label}</button>}</For></div>
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </div>;
}

export function ChatQuestion(props: { request: PendingUserInput; threadId: string; send: (request: ChatRequest) => Promise<unknown> }) {
  const [answers, setAnswers] = createSignal<Record<string, string[]>>({});
  const [custom, setCustom] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const values = (id: string) => [...(answers()[id] ?? []), ...(custom()[id]?.trim() ? [custom()[id]!.trim()] : [])];
  const valid = () => props.request.questions.every(question => values(question.id).length > 0);
  return <form class="chat-request" onSubmit={async event => {
    event.preventDefault(); if (!valid()) return;
    setBusy(true); setError('');
    try {
      await props.send({ operation: 'answer', threadId: props.threadId, requestId: props.request.requestId, answers: Object.fromEntries(props.request.questions.map(question => [question.id, question.multiSelect ? values(question.id) : values(question.id)[0]])) });
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }}>
    <For each={props.request.questions}>{question => <fieldset disabled={busy()}>
      <legend>{question.question}</legend>
      <For each={question.options}>{option => <label class="chat-question-option">
        <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${props.request.requestId}-${question.id}`} checked={(answers()[question.id] ?? []).includes(option.label)} onChange={event => {
          const previous = answers()[question.id] ?? [];
          setAnswers({ ...answers(), [question.id]: question.multiSelect ? event.currentTarget.checked ? [...previous, option.label] : previous.filter(v => v !== option.label) : [option.label] });
          if (!question.multiSelect) setCustom({ ...custom(), [question.id]: '' });
        }} />
        <span>{option.label}<Show when={option.description}><small>{option.description}</small></Show></span>
      </label>}</For>
      <Show when={question.allowCustomAnswer !== false}>
        <input class="chat-input" aria-label={`Answer: ${question.question}`} placeholder="Your answer…" value={custom()[question.id] ?? ''} onInput={event => {
          setCustom({ ...custom(), [question.id]: event.currentTarget.value });
          if (!question.multiSelect) setAnswers({ ...answers(), [question.id]: [] });
        }} />
      </Show>
    </fieldset>}</For>
    <button class="chat-primary" disabled={busy() || !valid()} type="submit">Submit answer</button>
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </form>;
}
