/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Compound drives the user's own `claude` and `codex` logins, so an expired
// one is fixed in a terminal, not in the app. One notice, one copyable
// command, and a re-check that starts a fresh chat once it succeeds — the
// old conversation and the unsent draft both survive.

import { Show, createEffect, createSignal } from "solid-js";

import { Button } from "@/components/ui/button";

import type { ChatAuthFailure } from "@compound/chat";

import { HARNESS_LABELS, SIGN_IN_COMMAND, type HarnessId } from "./store";

type AuthNoticeProps = {
  harness: HarnessId;
  failure: ChatAuthFailure;
  busy: boolean;
  error: string;
  onReconnect(): void;
};

export function AuthNotice(props: AuthNoticeProps) {
  const [copied, setCopied] = createSignal(false);
  const [copyError, setCopyError] = createSignal("");
  const command = () => SIGN_IN_COMMAND[props.harness];
  createEffect(() => {
    command();
    setCopied(false);
    setCopyError("");
  });

  return (
    <div class="mx-4 mb-2 flex shrink-0 flex-col gap-2 rounded-xl border border-border bg-accent p-3" role="status">
      <span class="text-[12px] font-450 leading-5 text-foreground">
        {props.failure === "expired" ? `${HARNESS_LABELS[props.harness]} login expired` : `Sign in to ${HARNESS_LABELS[props.harness]}`}
      </span>
      <p class="text-[11px] leading-4 text-muted-foreground">
        Sign in again in your terminal, then continue in a new chat. This conversation and your draft are saved.
      </p>
      <div class="flex items-center gap-1">
        <code class="min-w-0 flex-1 truncate rounded-md bg-input px-2 py-1 font-mono text-[11px] text-foreground">{command()}</code>
        <Button
          variant="secondary"
          size="small"
          aria-label="Copy sign-in command"
          onClick={async () => {
            setCopyError("");
            try {
              await navigator.clipboard.writeText(command());
              setCopied(true);
            } catch {
              setCopyError("Select and copy the command above.");
            }
          }}
        >
          {copied() ? "Copied" : "Copy"}
        </Button>
      </div>
      <Button size="small" class="self-start" disabled={props.busy} onClick={props.onReconnect}>
        {props.busy ? "Checking login…" : "I’ve signed in"}
      </Button>
      <Show when={props.error || copyError()}>
        <p class="text-[11px] leading-4 text-destructive" role="alert">{props.error || copyError()}</p>
      </Show>
    </div>
  );
}
