/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_URL } from "@compound/dapi";
import { version } from "../../../package.json";

import type { ToolInput, ToolName, ToolOutput } from "@compound/dapi";

export const APP_NAME = "Compound";

// Renders and AI generation outlive the 60s default.
const TIMEOUTS: Record<string, number> = {
  export: 3_600_000,
  capture: 600_000,
  media_transcribe: 600_000,
  media_listen: 600_000,
};

/**
 * Calls one tool in the running app over an MCP session on its HTTP
 * endpoint — the same URL agents register. Typed by the catalog: the input is
 * what the tool's schema accepts, the output its structured content. One
 * session per call; a command makes one or two, and the process exits when
 * it settles.
 */
export async function call<N extends ToolName>(name: N, input: ToolInput<N>): Promise<ToolOutput<N>> {
  const client = await connect();
  try {
    const result = await client.callTool({ name, arguments: input as Record<string, unknown> }, undefined, {
      timeout: TIMEOUTS[name] ?? 60_000,
    });
    if (result.isError) {
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      throw new Error(text || `${name} failed`);
    }
    return result.structuredContent as ToolOutput<N>;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Liveness: a round-trip through the app's MCP server. */
export async function ping(): Promise<void> {
  const client = await connect();
  try {
    await client.ping();
  } finally {
    await client.close().catch(() => {});
  }
}

// Connecting is where "the app is not running" shows up: the `initialize`
// request's fetch is refused, see `isAppDown`.
async function connect(): Promise<Client> {
  const client = new Client({ name: "compound", version });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  return client;
}

/**
 * Nothing is listening on the app's port. Node's fetch reports that as a
 * `fetch failed` TypeError whose cause carries the errno, so the chain of
 * causes is searched.
 */
export function isAppDown(e: unknown): boolean {
  for (let error = e, depth = 0; error && depth < 5; error = (error as { cause?: unknown }).cause, depth++) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET") return true;
  }
  return false;
}

/**
 * Launches the app, or surfaces the running instance: `open -a` on a running
 * app only activates it, so this is safe to always run. macOS only; elsewhere
 * it resolves false and the caller falls through to the connection.
 *
 * The bundled `compound` runs as Electron with ELECTRON_RUN_AS_NODE=1, and `open`
 * hands its environment to the app it launches — left in, the app boots as
 * plain Node and never answers.
 */
export function launchApp(background: boolean): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(false);
  const args = background ? ["-g", "-a", APP_NAME, "--args", "--hidden"] : ["-a", APP_NAME];
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  return new Promise((res) => execFile("open", args, { env }, (err) => res(!err)));
}

/**
 * Bridges the cold-start gap after launching the app: retries while the app
 * looks down, until it answers a ping.
 */
export async function waitForApp(timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  let lastError: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      return await ping();
    } catch (e) {
      if (!isAppDown(e)) throw e;
      lastError = e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(`${APP_NAME} did not answer within ${Math.round(timeoutMs / 1000)}s of launching${detail}`);
}
