/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { autoUpdater, dialog } from "electron";
import type { BrowserWindow } from "electron";
import type { UpdateState } from "./main-channels";
import { newerRelease } from "./updates-feed";

// The app keeps itself current from the public releases repository. The feed
// is read here first and compared with the running version; Squirrel.Mac,
// which downloads whatever a feed names, is only pointed at it when the feed
// names something newer. It then verifies the download's signature against
// the running app's, stages it, and swaps it in on the next restart.
//
// Quiet by default: a check on launch and every few hours, and a word only
// when a version is ready (a toast in the window; UPDATES_STATE events). The
// menu's "Check for Updates…" is the interactive path, where "up to date"
// and errors are also said, as dialogs.

const FIRST_CHECK_DELAY = 15_000;
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;

export type UpdaterOptions = {
  feedUrl: string;
  /** The running version, x.y.z. */
  version: string;
  window: () => BrowserWindow | null;
  onChange: (state: UpdateState) => void;
};

export class Updater {
  private readonly options: UpdaterOptions;
  private state: UpdateState = { status: "idle" };
  private inFlight: Promise<UpdateState> | null = null;
  private interactive = false;

  constructor(options: UpdaterOptions) {
    this.options = options;
    autoUpdater.on("update-downloaded", (_event, _notes, name) => {
      const version = this.state.status === "downloading" ? this.state.version : name.replace(/^v/, "");
      this.settle({ status: "ready", version });
    });
    autoUpdater.on("update-not-available", () => this.settle({ status: "up-to-date" }));
    autoUpdater.on("error", (error) => this.settle({ status: "error", message: error.message }));
  }

  get current(): UpdateState {
    return this.state;
  }

  /** The periodic checks; timers never keep the app alive. */
  start(): void {
    setTimeout(() => void this.check(false), FIRST_CHECK_DELAY).unref();
    setInterval(() => void this.check(false), CHECK_INTERVAL).unref();
  }

  /**
   * Runs a check unless one is running. Answers when the check has settled
   * or a download has started; the download's end arrives as an event.
   */
  check(interactive: boolean): Promise<UpdateState> {
    if (this.state.status === "ready") {
      if (interactive) this.offerRestart(this.state.version);
      return Promise.resolve(this.state);
    }
    if (this.inFlight) {
      this.interactive ||= interactive;
      return this.inFlight;
    }
    this.interactive = interactive;
    this.inFlight = this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** Restarts into the downloaded version. Nothing to install is nothing to do. */
  install(): void {
    if (this.state.status !== "ready") return;
    autoUpdater.quitAndInstall();
  }

  private async run(): Promise<UpdateState> {
    if (this.state.status === "downloading") return this.state;
    this.set({ status: "checking" });
    try {
      const response = await fetch(this.options.feedUrl, { cache: "no-store", headers: { Accept: "application/json" } });
      // Nothing published yet (the first release is not out) is not an error.
      if (response.status === 404) return this.settle({ status: "up-to-date" });
      if (!response.ok) throw new Error(`The update feed answered ${response.status}`);
      const next = newerRelease(await response.json(), this.options.version);
      if (!next) return this.settle({ status: "up-to-date" });
      this.set({ status: "downloading", version: next.version });
      autoUpdater.setFeedURL({ url: this.options.feedUrl, serverType: "json" });
      autoUpdater.checkForUpdates();
      return this.state;
    } catch (error) {
      return this.settle({ status: "error", message: (error as Error).message });
    }
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.options.onChange(state);
  }

  /** A terminal state; the interactive check, if that is what this was, gets its answer. */
  private settle(state: UpdateState): UpdateState {
    this.set(state);
    const interactive = this.interactive;
    this.interactive = false;
    if (!interactive) return state;
    if (state.status === "ready") this.offerRestart(state.version);
    else if (state.status === "up-to-date") this.say("info", "Compound is up to date", `Compound ${this.options.version} is the newest version.`);
    else if (state.status === "error") this.say("warning", "Compound could not check for updates", state.message);
    return state;
  }

  private offerRestart(version: string): void {
    const window = this.options.window();
    const options = {
      type: "info" as const,
      message: `Compound ${version} is ready to install`,
      detail: "Restart now to finish updating.",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
    };
    void (window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
      .then(({ response }) => { if (response === 0) this.install(); });
  }

  private say(type: "info" | "warning", message: string, detail: string): void {
    const window = this.options.window();
    const options = { type, message, detail, buttons: ["OK"] };
    void (window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
  }
}
