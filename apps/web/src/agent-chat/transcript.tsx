/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The messages, top-anchored like a document and pinned to the bottom once
// they overflow: the end of the streaming text stays right above the
// composer, a wheel-up lets go, scrolling back near the bottom pins again.

import { For, Show, createEffect, createSignal, on } from "solid-js";

import type { Item } from "@compound/chat";

import { ChatItem } from "./items";
import { RunningIndicator } from "./running-indicator";
import { createStickToBottom } from "./stick-to-bottom";

type TranscriptProps = {
  items: Item[];
  /** The chat the items belong to; assets resolve against it. */
  threadId: string;
  /** Bumped by the panel after every send, to pin the view to the end. */
  sendCount: number;
  /** Changes with the chat, so a newly opened one starts at its end. */
  chatKey: string;
  /** A turn is running: the last item is where the agent is right now. */
  running: boolean;
  /** The turn is paused on a question: the card below is the affordance, not a loader. */
  waiting: boolean;
  /** T3 holds messages older than the loaded window. */
  hasOlder: boolean;
  onLoadOlder(): void;
};

const toolInFlight = (item: Item | undefined) => item?.kind === "tool" && item.status === "running";

export function Transcript(props: TranscriptProps) {
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>();
  const stick = createStickToBottom(scrollEl, { initial: "instant" });
  const last = () => props.items[props.items.length - 1];

  createEffect(on(() => props.sendCount, (count) => count > 0 && void stick.scrollToBottom(), { defer: true }));
  createEffect(on(() => props.chatKey, () => void stick.scrollToBottom({ animation: "instant" }), { defer: true }));

  return (
    <div ref={setScrollEl} class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div class="flex flex-col gap-2 px-4 pb-2 pt-4">
        <Show when={props.hasOlder}>
          <button
            type="button"
            class="self-start rounded-md px-1 text-[11px] text-muted-foreground hover:text-foreground focus-ring"
            onClick={props.onLoadOlder}
          >
            Load earlier messages
          </button>
        </Show>
        <For each={props.items}>
          {(item) => <ChatItem item={item} threadId={props.threadId} />}
        </For>
        {/* A tool in flight spins on its own row; the indicator covers everything else the turn does. */}
        <Show when={props.running && !props.waiting && !toolInFlight(last())}>
          <RunningIndicator last={last()} />
        </Show>
      </div>
    </div>
  );
}
