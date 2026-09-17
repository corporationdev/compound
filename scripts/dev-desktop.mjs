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
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { get } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "node_modules", ".bin");
// runtime:write records the stage and its local ports here. A bare checkout
// that never ran setup keeps the historical ports.
const webEnv = existsSync(join(ROOT, "apps", "web", ".env")) ? parse(readFileSync(join(ROOT, "apps", "web", ".env"))) : {};
const STAGE = webEnv.STAGE ?? "";
const DEV_PORT = Number(webEnv.COMPOUND_WEB_PORT) || 5173;
const DEV_URL = `http://localhost:${DEV_PORT}`;
const INSPECTOR_PORT = Number(webEnv.COMPOUND_INSPECTOR_PORT) || 0;
// A sandbox stage (a linked worktree) is one of several apps on this machine.
// It gets its own Electron profile, so the single-instance lock, saved
// projects and chat data stay apart from the machine's main dev app, and a
// remote debugging port so a script can drive it.
const SANDBOX = STAGE.startsWith("sandbox");

/**
 * On Linux, a shell that did not come from the desktop (SSH, a T3 Code
 * terminal, a service) has no display variables, and Electron exits with
 * "Missing X server or $DISPLAY". The logged-in desktop session is still
 * there; point Electron at it: the Wayland socket and D-Bus in the user's
 * runtime dir, and for GNOME's Xwayland the auth cookie mutter writes. Every
 * variable already set is left alone, so a desktop terminal is unaffected.
 */
function adoptDesktopSession() {
  if (process.platform !== "linux" || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return;
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const set = (name, value) => { if (!process.env[name] && value) process.env[name] = value; };
  set("XDG_RUNTIME_DIR", runtime);
  if (existsSync(join(runtime, "bus"))) set("DBUS_SESSION_BUS_ADDRESS", `unix:path=${join(runtime, "bus")}`);
  const wayland = existsSync(runtime) ? readdirSync(runtime).find((name) => /^wayland-\d+$/.test(name)) : undefined;
  if (wayland) {
    set("WAYLAND_DISPLAY", wayland);
    set("XDG_SESSION_TYPE", "wayland");
    set("ELECTRON_OZONE_PLATFORM_HINT", "auto");
    const xauth = readdirSync(runtime).find((name) => name.startsWith(".mutter-Xwaylandauth."));
    if (xauth) set("XAUTHORITY", join(runtime, xauth));
  } else if (existsSync(join(homedir(), ".Xauthority"))) {
    set("XAUTHORITY", join(homedir(), ".Xauthority"));
  }
  set("DISPLAY", ":0");
  console.log(`[dev:desktop] no display in this shell; using the desktop session (${wayland ? `wayland ${wayland}` : "x11 :0"})`);
}
adoptDesktopSession();

/** Electron's appData directory on this platform, where profiles live. */
function appDataDir() {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (process.platform === "win32") return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}
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

for (const signal of ["SIGINT", "SIGTERM"]) {
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
// Forge locates `electron` in the app's own node_modules or under an npm,
// yarn or pnpm lockfile; it does not know bun.lock, so with bun's hoisted
// install it cannot find the root copy. Link it where Forge looks.
const DESKTOP = join(ROOT, "apps", "desktop");
const electronLink = join(DESKTOP, "node_modules", "electron");
if (!existsSync(electronLink)) {
  const electronDir = dirname(createRequire(join(DESKTOP, "package.json")).resolve("electron/package.json"));
  mkdirSync(dirname(electronLink), { recursive: true });
  symlinkSync(electronDir, electronLink, "junction");
}
console.log("[dev:desktop] starting desktop app…");
// Extra Electron flags for a dev session, e.g. a remote debugging port for
// driving the app from a script: COMPOUND_DEV_ELECTRON_ARGS="--remote-debugging-port=9333".
const electronArgs = [
  ...(SANDBOX ? [`--user-data-dir=${join(appDataDir(), `Compound-${STAGE}`)}`] : []),
  ...(SANDBOX && INSPECTOR_PORT ? [`--remote-debugging-port=${INSPECTOR_PORT}`] : []),
  ...(process.env.COMPOUND_DEV_ELECTRON_ARGS ?? "").split(/\s+/).filter(Boolean),
];
// The main process loads this stage's Vite server rather than the default port.
process.env.COMPOUND_DEV_URL = DEV_URL;
if (SANDBOX) console.log(`[dev:desktop] sandbox stage ${STAGE}: web ${DEV_URL}, profile Compound-${STAGE}${INSPECTOR_PORT ? `, inspector :${INSPECTOR_PORT}` : ""}`);
run("desktop", "electron-forge", ["start", ...(electronArgs.length ? ["--", ...electronArgs] : [])], DESKTOP);
