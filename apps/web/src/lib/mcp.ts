/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The renderer's view of what main keeps: where the app's MCP server is,
// and whether `compound` is on PATH. Desktop only — in the browser there is
// nothing to reach, and every call here says so by resolving to null.

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import { isDesktop } from "@/projects";

import type { CliInstallResult, CliStatus, CliUninstallResult, McpStatus } from "@desktop/main-channels";

export type { McpStatus, CliStatus } from "@desktop/main-channels";

export async function fetchMcpStatus(): Promise<McpStatus | null> {
  if (!isDesktop()) return null;
  return mainBridge.call(MAIN_CHANNELS.MCP_STATUS, undefined);
}

export async function fetchCliStatus(): Promise<CliStatus | null> {
  if (!isDesktop()) return null;
  return mainBridge.call(MAIN_CHANNELS.CLI_STATUS, undefined);
}

export function installCli(): Promise<CliInstallResult> {
  return mainBridge.call(MAIN_CHANNELS.CLI_INSTALL, undefined);
}

export function uninstallCli(): Promise<CliUninstallResult> {
  return mainBridge.call(MAIN_CHANNELS.CLI_UNINSTALL, undefined);
}
