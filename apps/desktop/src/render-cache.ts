/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A render is a pure function of the project folder, the media it links to,
// the export settings and the app version. Hashing those inputs tells us
// whether an existing export is still that render, without rendering first.
// The hash also travels with the upload so identical bytes are never sent
// twice.

import { createHash } from "node:crypto";
import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";

/** Folders that never affect the render: app caches, our own outputs, dependencies, VCS. */
const SKIPPED_DIRS = new Set(["node_modules", ".compound", ".git", "exports", "cache", ".cache", ".DS_Store"]);
/** Sources small enough to hash by content; anything else is identified by size and mtime. */
const CONTENT_HASH_MAX_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".css", ".html", ".md", ".txt", ".svg", ".srt", ".vtt", ".csv", ".toml",
]);

const isText = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot !== -1 && TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase());
};

async function* walk(root: string, dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(root, path);
    else if (entry.isFile()) yield path;
  }
}

/** Absolute paths of assets the manifest links from outside the project. */
async function linkedAssets(dir: string): Promise<string[]> {
  let manifest: unknown;
  try {
    manifest = parseYaml(await readFile(join(dir, "assets.yml"), "utf8"));
  } catch {
    return [];
  }
  const assets = (manifest as { assets?: unknown[] } | null)?.assets;
  if (!Array.isArray(assets)) return [];
  const paths: string[] = [];
  for (const asset of assets) {
    const source = (asset as { source?: unknown })?.source;
    if (typeof source !== "string" || /^https?:\/\//i.test(source)) continue;
    const absolute = resolve(dir, source);
    // Files inside the folder are already walked.
    if (!relative(dir, absolute).startsWith("..")) continue;
    paths.push(absolute);
  }
  return paths.sort();
}

/**
 * SHA-256 over every render input. `extra` is whatever else the caller
 * decides the output depends on (export settings, app version), already
 * serialised.
 */
export async function projectRenderHash(dir: string, extra: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`v1\0${extra}\0`);
  const record = async (label: string, path: string) => {
    const info = await stat(path).catch(() => null);
    if (!info) {
      hash.update(`${label}\0missing\0`);
      return;
    }
    if (info.size <= CONTENT_HASH_MAX_BYTES && isText(path)) {
      hash.update(`${label}\0content\0`);
      hash.update(await readFile(path));
      hash.update("\0");
    } else {
      hash.update(`${label}\0stat\0${info.size}\0${Math.floor(info.mtimeMs)}\0`);
    }
  };
  for await (const path of walk(dir, dir)) await record(relative(dir, path).split(sep).join("/"), path);
  for (const path of await linkedAssets(dir)) await record(`link:${path}`, path);
  return hash.digest("hex");
}

export type RenderCacheEntry = {
  hash: string;
  path: string;
  size: number;
  durationMs: number;
  width: number;
  height: number;
  renderedAt: number;
};
export type RenderCacheLookup = { dir: string; name: string; extra: string };
export type RenderCacheResult = { hash: string; cached: RenderCacheEntry | null };

const sidecar = (dir: string, name: string) => join(dir, "exports", `${name}.json`);

/** The current hash, and the existing export if it was made from exactly these inputs and is still on disk. */
export async function lookupRenderCache({ dir, name, extra }: RenderCacheLookup): Promise<RenderCacheResult> {
  const hash = await projectRenderHash(dir, extra);
  try {
    const entry = JSON.parse(await readFile(sidecar(dir, name), "utf8")) as RenderCacheEntry;
    if (entry.hash !== hash) return { hash, cached: null };
    const info = await stat(entry.path);
    if (!info.isFile() || info.size !== entry.size) return { hash, cached: null };
    return { hash, cached: entry };
  } catch {
    return { hash, cached: null };
  }
}

export async function storeRenderCache(dir: string, name: string, entry: RenderCacheEntry): Promise<void> {
  const info = await stat(entry.path);
  await writeFile(sidecar(dir, name), JSON.stringify({ ...entry, size: info.size }, null, 2), "utf8");
}

export async function clearRenderCache(dir: string, name: string): Promise<void> {
  await unlink(sidecar(dir, name)).catch(() => {});
}
