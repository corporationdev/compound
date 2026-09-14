/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One command to develop the desktop app from source. It:
//   1. builds the CLI, so a linked `compound` (see symlink:create) runs the
//      latest code and the app's headless server matches it;
//   2. starts the web dev server (Vite on :5173), first reclaiming the port
//      from a Vite left behind by an earlier run that did not come down;
//   3. waits for that server, then launches Electron, which loads it.
// Ctrl-C tears the whole tree down.

import { spawn, execFileSync } from "node:child_process";
import { get } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "node_modules", ".bin");
const DEV_PORT = 5173;
const DEV_URL = `http://localhost:${DEV_PORT}`;
const children = [];
let shuttingDown = false;

function run(name, bin, args, cwd) {
  // Spawn the tool binary directly rather than via `npm run`, so the teardown
  // SIGTERM isn't dressed up as a "Lifecycle script failed" error by an npm
  // wrapper. Own process group (detached) so we can signal the tool *and* its
  // children (esbuild, electron) in one shot on teardown.
  const child = spawn(join(BIN, bin), args, { cwd, stdio: "inherit", detached: true });
  child.on("exit", (code) => {
    if (shuttingDown) return;
    // A child dying on its own (e.g. Vite crashed) should bring the rest down.
    console.error(`\n[dev:desktop] ${name} exited (${code}); shutting down.`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  process.exit(code);
}

// Resolves once the dev server answers. Probes over HTTP against the same URL
// Electron loads, so we follow its host resolution (Vite binds localhost as
// IPv6 ::1) rather than guessing an address family.
function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = get(url, (res) => {
        res.destroy();
        resolve(); // Any response means the server is up.
      });
      req.once("error", () => {
        req.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Vite did not come up at ${url} in time`));
        } else {
          setTimeout(tryOnce, 200);
        }
      });
    };
    tryOnce();
  });
}

// SIGHUP too: closing the terminal must tear the tree down, not orphan
// Electron/Vite (which would then block the next run).
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdown(0));
}

/** PIDs listening on a TCP port (macOS/Linux via lsof); [] when none or unknown. */
function listeners(port) {
  try {
    const out = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: ["ignore", "pipe", "ignore"] });
    return out.toString().split("\n").map((line) => Number(line.trim())).filter(Boolean);
  } catch {
    return []; // lsof exits 1 when nothing listens.
  }
}

/** The command line of a process, or "" when it is gone. */
function commandOf(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

/**
 * Frees the dev port. A Vite left over from an earlier run of this repo
 * (Ctrl-C'd terminal, crashed Electron, a detached child) is killed and the
 * port awaited; anything else on the port is not ours to touch, so we say
 * what it is and stop.
 */
async function reclaimPort(port) {
  const pids = listeners(port);
  if (!pids.length) return;
  for (const pid of pids) {
    const command = commandOf(pid);
    if (!command.includes("vite") || !command.includes(ROOT.replace(/\/$/, ""))) {
      console.error(`[dev:desktop] port ${port} is in use by another process (pid ${pid}): ${command || "unknown"}`);
      process.exit(1);
    }
    console.log(`[dev:desktop] port ${port} held by a stale vite (pid ${pid}); stopping it…`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + 5000;
  while (listeners(port).length) {
    if (Date.now() > deadline) {
      for (const pid of listeners(port)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
      await new Promise((r) => setTimeout(r, 200));
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Main Electron binaries this repo's dev run launches (helpers live under
// Contents/Frameworks and are not matched; they die with the main process).
const ELECTRON_BINARIES = [
  join(ROOT, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  join(ROOT, "node_modules", "electron", "dist", "electron"),
];

/** PIDs of main Electron processes started from this repo's node_modules. */
function staleElectrons() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return out.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) return [];
      const [, pid, command] = match;
      const binary = ELECTRON_BINARIES.find((path) => command === path || command.startsWith(`${path} `));
      return binary && Number(pid) !== process.pid ? [Number(pid)] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Quits an Electron left over from an earlier run (a terminal that closed
 * without signalling its children, or a window closed on macOS where the app
 * lives on). It holds the app's single-instance lock, so a new one would only
 * print "Another instance is already running" and exit, taking the whole dev
 * tree down with it.
 */
async function reclaimElectron() {
  const pids = staleElectrons();
  if (!pids.length) return;
  for (const pid of pids) {
    console.log(`[dev:desktop] a stale Electron from an earlier run is holding the app lock (pid ${pid}); stopping it…`);
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  }
  const deadline = Date.now() + 5000;
  while (staleElectrons().length) {
    if (Date.now() > deadline) {
      for (const pid of staleElectrons()) {
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
      await new Promise((r) => setTimeout(r, 200));
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// 1. Build the CLI (blocking) so `compound` and the app agree on the latest code.
console.log("[dev:desktop] building CLI…");
execFileSync("bun", ["run", "--cwd", "apps/cli", "build"], { stdio: "inherit" });

execFileSync("bun", ["run", "--cwd", "apps/desktop", "stage:chat"], { stdio: "inherit" });

// 2. Start the web dev server, on a port that is free.
await reclaimPort(DEV_PORT);
console.log("[dev:desktop] starting web dev server…");
run("web", "vite", [], join(ROOT, "apps", "web"));

// 3. Once it is up, build the desktop app (blocking, mirrors its `dev`
// script) and launch Electron, which loads :5173.
try {
  await waitForServer(DEV_URL);
} catch (err) {
  console.error(`[dev:desktop] ${err.message}`);
  shutdown(1);
}
console.log("[dev:desktop] building desktop app…");
execFileSync("bun", ["run", "--cwd", "apps/desktop", "build"], { stdio: "inherit" });
await reclaimElectron();
console.log("[dev:desktop] starting desktop app…");
run("desktop", "electron-forge", ["start"], join(ROOT, "apps", "desktop"));
