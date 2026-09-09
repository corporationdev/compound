/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CliInstallResult } from "./main-channels";

export const CLI_LINK_PATH = "/usr/local/bin/compound";

// The dev workflow links the workspace build into Homebrew's bin instead
// (`symlink:create` in apps/cli), so both locations count as installed.
const DEV_LINK_PATH = "/opt/homebrew/bin/compound";

export function isCliInstalled(): boolean {
  return existsSync(CLI_LINK_PATH) || existsSync(DEV_LINK_PATH);
}

// Linking into /usr/local/bin needs elevation; osascript shows the standard
// macOS admin prompt so the app itself never asks for credentials.
function linkCli(): Promise<void> {
  const wrapper = join(process.resourcesPath, "cli", "bin", "compound");
  const shell = `mkdir -p /usr/local/bin && ln -sf '${wrapper}' '${CLI_LINK_PATH}'`;
  const script = `do shell script "${shell.replaceAll('"', '\\"')}" with administrator privileges`;
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err) => (err ? reject(err) : resolve()));
  });
}

export async function installCli(): Promise<CliInstallResult> {
  if (!app.isPackaged) {
    return {
      status: "error",
      error: "Installing the CLI is only available in the packaged app. Use `bun run --cwd apps/cli symlink:create` from the repository root in development.",
    };
  }
  try {
    await linkCli();
    return { status: "installed" };
  } catch (e) {
    const message = (e as Error).message ?? "";
    if (message.includes("-128")) return { status: "cancelled" }; // user cancelled the admin prompt
    return { status: "error", error: message };
  }
}
