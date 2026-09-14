/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, type JSX } from "solid-js";

import { ChatPanel } from "./chat-panel";
import { sidebarTab } from "./store";

/** The right column: the editor's inspector, or the chat, by tab. */
export function RightSidebar(props: { editor: () => JSX.Element }) {
  return (
    <Show when={sidebarTab() === "chat"} fallback={props.editor()}>
      <ChatPanel />
    </Show>
  );
}
