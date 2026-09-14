/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLibrary } from "@compound/runtime";
import { DapiError } from "@compound/dapi";
import { mergeCatalogItems } from "@compound/backend/catalog";
import { getCatalogItem, listCatalog, resolveCatalogLink, searchExternalCatalog } from "@/lib/catalog";
import { serverQueries } from "@/lib/query-cache";
import { browseCatalog, catalogSearchInput, catalogSelection, catalogSourceId } from "@/lib/catalog-discovery";
import { importCatalogAsset } from "@/engine/catalog-assets";

import type { LibraryItem } from "@compound/dapi";
import type { ToolHandler } from "../handler";

/**
 * The library is Convex-backed, so every call is scoped to the signed-in
 * account. The returned guard re-checks the scope between awaits: if the
 * account changes mid-call the result would belong to someone else.
 */
function account(): () => string {
  const scope = serverQueries.scope;
  if (!scope) throw new DapiError("sign-in-required", "Sign in to Compound to use the library.");
  return () => {
    if (scope !== serverQueries.scope) throw new DapiError("unsupported", "The signed-in account changed. Retry the library call.");
    return scope;
  };
}

/** Input validation shared with the sidebar; surfaced as an input error. */
function checked<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new DapiError("invalid-input", (error as Error).message);
  }
}

export const librarySearch: ToolHandler<"library_search"> = async (input) => {
  const { kind, query, expand } = checked(() => catalogSearchInput(input));
  const current = account();
  const local = await browseCatalog(serverQueries.client, current(), kind, query, (kind, query, cursors) => {
    current();
    return listCatalog(kind, query, cursors);
  });
  current();
  const items = expand ? mergeCatalogItems(local, await searchExternalCatalog(kind, query)) : local;
  current();
  return { items: items.map(catalogSelection) as LibraryItem[], count: items.length, complete: true, expanded: expand };
};

export const libraryGet: ToolHandler<"library_get"> = async ({ sourceId }) => {
  const current = account();
  const item = await getCatalogItem(checked(() => catalogSourceId(sourceId)));
  current();
  return catalogSelection(item) as LibraryItem;
};

export const libraryResolve: ToolHandler<"library_resolve"> = async ({ url }) => {
  const trimmed = url.trim();
  if (!trimmed) throw new DapiError("invalid-input", "Pass a supported music link.");
  const current = account();
  const item = await resolveCatalogLink("music", trimmed);
  current();
  return catalogSelection(item) as LibraryItem;
};

export const libraryImport: ToolHandler<"library_import"> = async ({ sourceId }, ctx) => {
  checked(() => catalogSourceId(sourceId));
  const current = account();
  const library = getLibrary(ctx.requireSession().world);
  const before = new Set(library.list().map((asset) => asset.id));
  const asset = await importCatalogAsset(library, sourceId).catch((error: unknown) => {
    throw new DapiError(
      "unsupported",
      `Library import ${sourceId}: ${(error as Error).message}. Retry the same source ID to reuse completed work.`,
    );
  });
  current();
  const provenance = asset.catalogSources?.find((source) => source.sourceId === sourceId);
  if (!provenance || asset.type !== "AUDIO") throw new DapiError("unsupported", "Imported audio has no catalog provenance.");
  const selected = catalogSelection({
    ...provenance,
    durationUs: Math.round(asset.duration * 1_000_000),
    provider: "upload",
    inUserLibrary: false,
    inGlobalLibrary: false,
    status: "ready",
  }) as LibraryItem;
  return {
    ...selected,
    assetId: asset.id,
    path: asset.path,
    localPath: library.fs.absolute?.(asset.source),
    reused: before.has(asset.id),
  };
};
