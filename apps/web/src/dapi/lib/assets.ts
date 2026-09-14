/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLibrary } from "@compound/runtime";
import { AssetLibrary, isAbsoluteSource, isUrlSource } from "@compound/assets";
import { DapiError } from "@compound/dapi";
import { createProjectFS } from "@/projects/fs";
import { resolveLibraryMedia } from "./library-media";

import type { Asset } from "@compound/assets";
import type { ToolContext } from "../handler";

/**
 * Resolves a tool target by path. With a project open, its library answers:
 * library paths look assets up, absolute paths and URLs are described in place
 * without being added (transient assets). With none open, a throwaway library
 * over a project-less FS describes absolute paths and URLs the same way — a
 * fresh one per request, so nothing is remembered between calls.
 *
 * `library:<source-id>` reads the cached bytes of a Compound library source
 * directly, with no project and without importing it.
 */
export function resolveAsset(ctx: ToolContext, path: string): Promise<Asset> {
  if (path.startsWith("library:")) return resolveLibraryMedia(path.slice("library:".length));
  const world = ctx.session()?.world;
  if (world) return getLibrary(world).resolve(path);
  if (!isAbsoluteSource(path) && !isUrlSource(path)) {
    throw new DapiError(
      "no-project",
      `Could not resolve "${path}": with no project open only absolute paths and URLs resolve — open a project to use library paths.`,
    );
  }
  return new AssetLibrary(createProjectFS("")).resolve(path);
}

/** Narrows the asset to one of `types`, or throws a `wrong-kind` error naming what was expected. */
export function requireAssetType<T extends Asset["type"]>(
  asset: Asset,
  types: readonly T[],
  expected: string,
): asserts asset is Extract<Asset, { type: T }> {
  if (!(types as readonly string[]).includes(asset.type)) {
    throw new DapiError("wrong-kind", `Asset ${asset.id} is not ${expected}.`);
  }
}
