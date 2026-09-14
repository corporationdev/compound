/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The two things an agent can wait on, pinned between the transcript and the
// composer: a multiple-choice question, and — Compound's addition, because
// T3 runs the agents under a permission mode — an approval for a command or
// a file change. Both wear the same card.

import { For, Show, createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import { Button } from "@/components/ui/button";

import type { PendingApproval, PendingUserInput } from "@compound/chat";
import type { ProviderApprovalDecision, UserInputQuestion } from "@compound/chat/types";

const OTHER = "__other__";

const CARD = "mx-4 mb-2 flex max-h-[50vh] shrink-0 flex-col rounded-xl border border-border bg-accent";

const APPROVAL_LABELS: Record<string, string> = {
  command: "Run a command",
  "file-read": "Read a file",
  "file-change": "Change a file",
  "mcp-elicitation": "Answer a tool request",
};

type ApprovalCardProps = {
  request: PendingApproval;
  onDecide(decision: ProviderApprovalDecision): void;
};

/** What the agent wants to do, and the decisions the provider offers for it. */
export function ApprovalCard(props: ApprovalCardProps) {
  const [busy, setBusy] = createSignal(false);
  const options = () =>
    props.request.options ?? [
      { decision: "accept" as ProviderApprovalDecision, label: "Allow once" },
      { decision: "decline" as ProviderApprovalDecision, label: "Decline" },
    ];
  return (
    <div class={CARD}>
      <div class="flex min-h-0 flex-col gap-1.5 overflow-y-auto p-3">
        <span class="w-fit rounded bg-input px-1 py-px text-[10px] font-450 text-muted-foreground">
          {APPROVAL_LABELS[props.request.requestKind] ?? "Approval"}
        </span>
        <Show when={props.request.detail}>
          <pre class="overflow-x-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground">{props.request.detail}</pre>
        </Show>
      </div>
      <div class="flex shrink-0 flex-wrap items-center justify-end gap-1 border-t border-border p-2">
        <For each={options()}>
          {(option, index) => (
            <Button
              variant={index() === 0 ? "default" : "secondary"}
              disabled={busy()}
              title={option.warning}
              onClick={() => {
                setBusy(true);
                props.onDecide(option.decision);
              }}
            >
              {option.label}
            </Button>
          )}
        </For>
      </div>
    </div>
  );
}

type QuestionCardProps = {
  request: PendingUserInput;
  onSubmit(answers: Record<string, string[]>): void;
};

export function QuestionCard(props: QuestionCardProps) {
  // Chosen option labels per question (OTHER stands for the free-text row).
  const [chosen, setChosen] = createStore<Record<string, string[]>>({});
  const [other, setOther] = createStore<Record<string, string>>({});
  const [busy, setBusy] = createSignal(false);

  const allowOther = (question: UserInputQuestion) => question.allowCustomAnswer !== false;

  const answerFor = (question: UserInputQuestion): string[] => {
    const picked = chosen[question.id] ?? [];
    return picked.map((label) => (label === OTHER ? (other[question.id] ?? "").trim() : label)).filter(Boolean);
  };

  const complete = createMemo(() => props.request.questions.every((question) => answerFor(question).length > 0));

  const submit = () => {
    if (!complete() || busy()) return;
    setBusy(true);
    props.onSubmit(Object.fromEntries(props.request.questions.map((question) => [question.id, answerFor(question)])));
  };

  const pick = (question: UserInputQuestion, label: string) => {
    if (question.multiSelect) {
      const current = chosen[question.id] ?? [];
      setChosen(question.id, current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label]);
      return;
    }
    setChosen(question.id, [label]);
    // One single-choice question submits on click; "Other" needs its text first.
    if (props.request.questions.length === 1 && label !== OTHER) queueMicrotask(submit);
  };

  const isPicked = (question: UserInputQuestion, label: string) => (chosen[question.id] ?? []).includes(label);

  return (
    <div class={CARD}>
      <div class="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
        <For each={props.request.questions}>
          {(question) => (
            <fieldset class="flex flex-col gap-1.5">
              <legend class="mb-1 flex items-center gap-1.5">
                <span class="rounded bg-input px-1 py-px text-[10px] font-450 text-muted-foreground">{question.header || "Question"}</span>
              </legend>
              <p class="text-[12px] leading-5 text-foreground">{question.question}</p>
              <For each={question.options}>
                {(option) => (
                  <label class="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 hover:bg-muted">
                    <input
                      type={question.multiSelect ? "checkbox" : "radio"}
                      name={question.id}
                      class="mt-1 size-3 shrink-0 accent-primary"
                      checked={isPicked(question, option.label)}
                      onChange={() => pick(question, option.label)}
                    />
                    <span class="flex min-w-0 flex-col">
                      <span class="text-[12px] leading-5 text-foreground">{option.label}</span>
                      <Show when={option.description}>
                        <span class="text-[11px] leading-4 text-muted-foreground">{option.description}</span>
                      </Show>
                    </span>
                  </label>
                )}
              </For>
              <Show when={allowOther(question) || question.options.length === 0}>
                <label class="flex items-start gap-2 rounded-md px-1 py-0.5 hover:bg-muted">
                  <Show when={question.options.length > 0}>
                    <input
                      type={question.multiSelect ? "checkbox" : "radio"}
                      name={question.id}
                      class="mt-1 size-3 shrink-0 accent-primary"
                      checked={isPicked(question, OTHER)}
                      onChange={() => pick(question, OTHER)}
                    />
                  </Show>
                  <span class="flex min-w-0 flex-1 flex-col gap-1">
                    <Show when={question.options.length > 0}>
                      <span class="text-[12px] leading-5 text-foreground">Other</span>
                    </Show>
                    <input
                      type="text"
                      class="h-7 w-full rounded-md border border-border bg-input px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-border-input"
                      placeholder="Type an answer…"
                      value={other[question.id] ?? ""}
                      onFocus={() =>
                        question.options.length > 0 &&
                        !isPicked(question, OTHER) &&
                        setChosen(question.id, question.multiSelect ? [...(chosen[question.id] ?? []), OTHER] : [OTHER])
                      }
                      onInput={(event) => {
                        setOther(question.id, event.currentTarget.value);
                        if (question.options.length === 0) setChosen(question.id, [OTHER]);
                      }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter" && !event.isComposing) {
                          event.preventDefault();
                          submit();
                        }
                      }}
                      onKeyUp={(event) => event.stopPropagation()}
                    />
                  </span>
                </label>
              </Show>
            </fieldset>
          )}
        </For>
      </div>
      <div class="flex shrink-0 items-center justify-end gap-1 border-t border-border p-2">
        <Button onClick={submit} disabled={!complete() || busy()}>
          Submit
        </Button>
      </div>
    </div>
  );
}
