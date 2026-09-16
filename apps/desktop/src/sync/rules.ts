/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which files in a workspace folder are the cloud's business. Text the user
// or an agent authors syncs; installs, caches, exports, media bytes and the
// app's own folder do not — media goes through the asset pipeline by content
// hash, and the rest is derived or machine-specific. A project sits anywhere
// in the workspace, so its derived folders are recognised by name at any
// depth rather than at the root.

import { TEMP_PREFIX } from "../atomic";

/** Largest file the cloud stores as text. Convex documents cap at 1 MiB; this leaves room. */
export const MAX_SYNC_BYTES = 512 * 1024;

/** How much of a file is inspected for a NUL byte before it is called binary. */
const SNIFF_BYTES = 8 * 1024;

/**
 * Folders and files that never sync, wherever they sit: installs, version
 * control, the app's own state, agent config, a project's derived data and
 * its media bytes.
 */
export const IGNORED_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".compound",
  ".claude",
  ".DS_Store",
  ".mcp.json",
  "cache",
  "exports",
  "assets",
]);

/**
 * Whether a workspace-relative, `/`-separated path may sync at all, by its
 * name. Content is a separate question (see `isSyncableContent`).
 */
export function isSyncablePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  for (const segment of segments) {
    if (IGNORED_NAMES.has(segment)) return false;
    if (segment.startsWith(TEMP_PREFIX)) return false;
  }
  return Buffer.byteLength(path) <= 512;
}

/**
 * Whether bytes read from a file are text the cloud will take: small enough,
 * and with no NUL in its head, which is what separates source from media
 * that landed at an unexpected path.
 */
export function isSyncableContent(bytes: Uint8Array): boolean {
  if (bytes.byteLength > MAX_SYNC_BYTES) return false;
  const head = bytes.subarray(0, SNIFF_BYTES);
  return !head.includes(0);
}

/**
 * Whether a folder listing should descend into `name`. Mirrors
 * `isSyncablePath` so a scan skips the same trees the watcher ignores,
 * without stat-ing them.
 */
export function shouldDescend(name: string): boolean {
  return !IGNORED_NAMES.has(name) && !name.startsWith(TEMP_PREFIX);
}
