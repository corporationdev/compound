/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { onCleanup, onMount } from "solid-js";
import { toast } from "somoto";

import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS, type UpdateState } from "@desktop/main-channels";

const TOAST_ID = "app-update";

/**
 * Says when a new version of the app is ready: one persistent toast with a
 * Restart action, kept in step with the main process's updater (updates.ts),
 * which does the checking and downloading and announces its state. The
 * current state is asked for on mount, since a download may have finished
 * before this window listened.
 */
export function useAppUpdates() {
  if (!window.desktop) return;
  const show = (state: UpdateState) => {
    if (state.status !== "ready") return;
    toast(`Compound ${state.version} is ready to install`, {
      id: TOAST_ID,
      duration: Infinity,
      description: "Restart to finish updating.",
      action: { label: "Restart", onClick: () => void mainBridge.call(MAIN_CHANNELS.UPDATES_INSTALL, undefined) },
    });
  };
  onMount(() => {
    void mainBridge.call(MAIN_CHANNELS.UPDATES_GET, undefined).then(show).catch(() => {});
    onCleanup(mainBridge.handle(MAIN_CHANNELS.UPDATES_STATE, show));
  });
}
