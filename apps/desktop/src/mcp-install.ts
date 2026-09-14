/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Registers the app's MCP server with the agents on this machine, one agent
// at a time as the settings page asks: the fixed loopback URL for agents
// that speak HTTP, the bundled `compound mcp` proxy for the rest. No PATH
// symlink and no admin prompt — that is `cli-install.ts`, for people who
// type `compound`.

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MCP_URL } from "@compound/dapi";
import { agentTarget, needsBinary, readServer, upsertServer } from "./mcp-config";

import type { AgentId, AgentTarget, McpServerSpec } from "./mcp-config";
import type { McpStatus } from "./main-channels";

// The dev workflow links the workspace build into Homebrew's bin
// (`symlink:create` in apps/cli); that is the binary a dev build registers.
const DEV_BINARY = "/opt/homebrew/bin/compound";

/** The bundled `compound` binary, or null when none is available (an unstaged dev build). */
export function dapiBinary(): string | null {
  const command = app.isPackaged ? join(process.resourcesPath, "cli", "bin", "compound") : DEV_BINARY;
  return existsSync(command) ? command : null;
}

function spec(): McpServerSpec {
  return { url: MCP_URL, command: dapiBinary() ?? "", args: ["mcp"] };
}

function configPath(target: AgentTarget): string {
  return join(homedir(), target.config);
}

function readConfig(target: AgentTarget): string | null {
  const path = configPath(target);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function writeConfig(target: AgentTarget, text: string): void {
  const path = configPath(target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * Why this agent cannot be connected from this build, or null when it can.
 * Only the stdio agents have reasons: a build without the `compound` binary has
 * nothing for them to run, and a quarantined first launch runs from a
 * translocated read-only mount whose path won't survive the next launch —
 * registering it would dangle.
 */
function unavailableReason(target: AgentTarget, current: McpServerSpec): string | null {
  if (!needsBinary(target)) return null;
  if (current.command === "") return "Needs the compound command line tool, which this build does not include.";
  if (app.isPackaged && current.command.includes("/AppTranslocation/")) {
    return "Move Compound to the Applications folder and relaunch it first.";
  }
  return null;
}

/** Where the app's MCP server is, for the settings page. */
export function mcpStatus(): McpStatus {
  return { url: spec().url };
}

/**
 * Writes the app's MCP entry into one agent's config, when the in-app chat
 * is about to run that agent. Claude Code reads the project's `.mcp.json`
 * instead (see chat-server.ts); Codex has no project scope, so its user
 * config is the only place the server can be registered. Other servers in
 * the file are left alone. Throws with the file and reason on failure.
 */
export function registerMcp(id: AgentId): void {
  const target = agentTarget(id);
  const current = spec();
  const reason = unavailableReason(target, current);
  if (reason) throw new Error(reason);
  const text = readConfig(target);
  const entry = target.entry(current);
  const registered = readServer(text, target.format);
  if (registered && (registered.url === entry.url || registered.command === entry.command)) return;
  writeConfig(target, upsertServer(text, target.format, entry));
}
