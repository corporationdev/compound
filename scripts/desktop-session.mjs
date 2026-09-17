import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * On Linux, a shell that did not come from the desktop (SSH, a T3 Code
 * terminal, a service) has no display variables, and Electron exits with
 * "Missing X server or $DISPLAY". The logged-in desktop session is still
 * there; point Electron at it: the Wayland socket and D-Bus in the user's
 * runtime dir, and for GNOME's Xwayland the auth cookie mutter writes. Every
 * variable already set is left alone, so a desktop terminal is unaffected.
 * Returns a description of what was adopted, or null when nothing was.
 */
export function adoptDesktopSession(env = process.env) {
  if (process.platform !== "linux" || env.DISPLAY || env.WAYLAND_DISPLAY) return null;
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const set = (name, value) => { if (!env[name] && value) env[name] = value; };
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
  return wayland ? `wayland ${wayland}` : "x11 :0";
}
