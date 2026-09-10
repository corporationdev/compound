import { Show, createEffect, createSignal } from 'solid-js';
import type { ChatAuthFailure } from '@compound/chat';

export function ChatAuthNotice(props: { provider: string; failure: ChatAuthFailure; busy: boolean; error: string; onReconnect: () => void }) {
  const [copied, setCopied] = createSignal(false);
  const [copyError, setCopyError] = createSignal('');
  const label = () => props.provider === 'claudeAgent' ? 'Claude Code' : 'Codex';
  const command = () => props.provider === 'claudeAgent' ? 'claude auth login' : 'codex login';
  createEffect(() => { command(); setCopied(false); setCopyError(''); });
  return <div class="chat-auth-notice" role="status" aria-label="Provider sign-in required">
    <strong>{props.failure === 'expired' ? `${label()} login expired` : `Sign in to ${label()}`}</strong>
    <p>Sign in again in your terminal, then continue in a new chat. This conversation and your draft are saved.</p>
    <div class="chat-auth-command"><code>{command()}</code><button type="button" aria-label="Copy sign-in command" onClick={async () => {
      setCopyError('');
      try { await navigator.clipboard.writeText(command()); setCopied(true); }
      catch { setCopyError('Select and copy the command above.'); }
    }}>{copied() ? 'Copied' : 'Copy'}</button></div>
    <button class="chat-auth-reconnect" type="button" disabled={props.busy} onClick={props.onReconnect}>{props.busy ? 'Checking login…' : 'I’ve signed in'}</button>
    <Show when={props.error || copyError()}><p class="chat-auth-help" role="alert">{props.error || copyError()}</p></Show>
  </div>;
}
