/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app, autoUpdater, dialog } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import { release } from "@compound/config/release";
import { getStageKind } from "@compound/config/stage-kind";

export type UpdateOutcome =
  | { kind: "downloaded"; name: string }
  | { kind: "available" }
  | { kind: "current" }
  | { kind: "error"; message: string };

// Background checks stay quiet until an update has finished downloading. A
// check started from the menu reports every outcome once, and a later menu
// click while a download sits ready re-offers the restart instead of checking.
export class UpdateStatus {
  private manual = false;
  private downloaded: string | null = null;
  private readonly notify: (outcome: UpdateOutcome) => void;

  constructor(notify: (outcome: UpdateOutcome) => void) {
    this.notify = notify;
  }

  /** Menu click. Returns true when a network check should start. */
  requestCheck(): boolean {
    if (this.downloaded) {
      this.notify({ kind: "downloaded", name: this.downloaded });
      return false;
    }
    if (this.manual) return false;
    this.manual = true;
    return true;
  }

  report(outcome: UpdateOutcome) {
    if (outcome.kind === "downloaded") this.downloaded = outcome.name;
    const show = outcome.kind === "downloaded" || this.manual;
    // "available" means the download is still running; the manual check ends
    // with whatever that download produces.
    if (outcome.kind !== "available") this.manual = false;
    if (show) this.notify(outcome);
  }
}

function present(outcome: UpdateOutcome) {
  switch (outcome.kind) {
    case "downloaded":
      void dialog
        .showMessageBox({
          type: "info",
          buttons: ["Restart", "Later"],
          defaultId: 0,
          cancelId: 1,
          message: `Compound ${outcome.name} is ready to install.`,
          detail: "Restart Compound to finish updating.",
        })
        .then(({ response }) => {
          if (response === 0) autoUpdater.quitAndInstall();
        });
      return;
    case "available":
      void dialog.showMessageBox({
        type: "info",
        message: "Downloading an update…",
        detail: "Compound will ask you to restart once it is ready.",
      });
      return;
    case "current":
      void dialog.showMessageBox({
        type: "info",
        message: "Compound is up to date.",
        detail: `You're on version ${app.getVersion()}.`,
      });
      return;
    case "error":
      void dialog.showMessageBox({
        type: "error",
        message: "Could not check for updates.",
        detail: outcome.message,
      });
      return;
  }
}

let status: UpdateStatus | null = null;

/** True once background update checks are running for this launch. */
export function updatesEnabled(): boolean {
  return status !== null;
}

function isProductionBuild(): boolean {
  try {
    const config = JSON.parse(readFileSync(join(app.getAppPath(), "runtime-config.json"), "utf8"));
    return getStageKind(String(config.stage)) === "production";
  } catch {
    return false;
  }
}

/** Polls the release feed and offers a restart when a newer build has
 * downloaded. Only production installs update; dev, preview, and hidden
 * (CLI-driven) launches leave the installed version alone. */
export function startAutoUpdates(hidden: boolean) {
  if (status || !app.isPackaged || hidden || !isProductionBuild()) return;
  if (process.platform !== "darwin") return;

  status = new UpdateStatus(present);
  const current = status;
  autoUpdater.on("update-available", () => current.report({ kind: "available" }));
  autoUpdater.on("update-not-available", () => current.report({ kind: "current" }));
  autoUpdater.on("update-downloaded", (_event, _notes, name) => current.report({ kind: "downloaded", name }));
  autoUpdater.on("error", (error) => current.report({ kind: "error", message: error.message }));

  const log = (...args: unknown[]) => console.log("[updater]", ...args);
  updateElectronApp({
    updateSource: { type: UpdateSourceType.StaticStorage, baseUrl: release.releasesUrl },
    logger: { log, info: log, warn: log, error: log },
    // Downloads surface through `present` so menu and background checks share one prompt.
    notifyUser: false,
  });
}

/** "Check for Updates…" menu item. */
export function checkForUpdates() {
  if (!status) return;
  if (status.requestCheck()) autoUpdater.checkForUpdates();
}
