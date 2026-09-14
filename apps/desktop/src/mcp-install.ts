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
import { AGENT_TARGETS, agentTarget, needsBinary, readServer, removeServer, upsertServer } from "./mcp-config";

import type { AgentTarget, McpServerSpec } from "./mcp-config";
import type { McpAgentStatus, McpApplyRequest, McpApplyResult, McpStatus } from "./main-channels";

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

function agentStatus(target: AgentTarget, current: McpServerSpec): McpAgentStatus {
  const registered = readServer(readConfig(target), target.format);
  return {
    id: target.id,
    label: target.label,
    detected: existsSync(join(homedir(), target.marker)),
    connected: registered !== null,
    config: configPath(target),
    unavailable: unavailableReason(target, current),
  };
}

/** Every agent we know, with whether it is on this machine and whether its config carries our entry. */
export function mcpStatus(): McpStatus {
  const current = spec();
  return { url: current.url, agents: AGENT_TARGETS.map((target) => agentStatus(target, current)) };
}

/**
 * Writes our entry into the configs of `add` and takes it out of the configs
 * of `remove`, one file at a time, so one unreadable config does not stop
 * the rest. Other servers in the same file are left alone either way.
 */
export function applyMcp(request: McpApplyRequest): McpApplyResult {
  const current = spec();
  const result: McpApplyResult = { added: [], removed: [], failures: [] };

  for (const id of request.add) {
    const target = agentTarget(id);
    const reason = unavailableReason(target, current);
    if (reason) {
      result.failures.push({ id, error: reason });
      continue;
    }
    try {
      writeConfig(target, upsertServer(readConfig(target), target.format, target.entry(current)));
      result.added.push(id);
    } catch (e) {
      result.failures.push({ id, error: `${target.config}: ${(e as Error).message}` });
    }
  }

  for (const id of request.remove) {
    const target = agentTarget(id);
    try {
      const next = removeServer(readConfig(target), target.format);
      if (next !== null) writeConfig(target, next);
      result.removed.push(id);
    } catch (e) {
      result.failures.push({ id, error: `${target.config}: ${(e as Error).message}` });
    }
  }

  return result;
}

/**
 * Launch-time self-heal for the stdio agents: an entry that still runs the
 * proxy from a bundle that moved (or was translocated when it was written)
 * is rewritten to the binary this build has. Entries the user wrote by hand
 * for something else are left alone.
 */
export function healMcpRegistrations(): void {
  if (!app.isPackaged) return;
  const current = spec();
  if (current.command === "" || current.command.includes("/AppTranslocation/")) return;

  for (const target of AGENT_TARGETS) {
    const text = readConfig(target);
    const registered = readServer(text, target.format);
    if (!registered?.command) continue;
    const ours = registered.command.includes("Compound") || registered.command.includes("/AppTranslocation/");
    if (!ours) continue;
    const entry = target.entry(current);
    if (registered.command === entry.command) continue;
    try {
      writeConfig(target, upsertServer(text, target.format, entry));
    } catch {
      // best effort — the settings page remains as a manual fix
    }
  }
}
