/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DapiError } from "@compound/dapi";
import { catalogFile } from "@/lib/catalog";
import { catalogSourceId } from "@/lib/catalog-discovery";
import { serverQueries } from "@/lib/query-cache";

import type { Asset } from "@compound/assets";

/**
 * Inspect a library source's cached bytes as a transient asset: no project,
 * no membership, no stored asset. Backs `library:<source-id>` paths in the
 * media tools.
 */
export async function resolveLibraryMedia(sourceId: string): Promise<Asset> {
  const scope = serverQueries.scope;
  if (!scope) throw new DapiError("sign-in-required", "Sign in to Compound to read library sources.");
  const current = () => {
    if (scope !== serverQueries.scope) throw new DapiError("unsupported", "The signed-in account changed. Retry the call.");
  };

  let id: string;
  try {
    id = catalogSourceId(sourceId);
  } catch (error) {
    throw new DapiError("invalid-input", (error as Error).message);
  }

  const { blob, media } = await catalogFile(id);
  current();
  const { probeMedia } = await import("@compound/assets");
  const probe = await probeMedia(blob, media.mimeType);
  current();
  if (probe.type !== "AUDIO") throw new DapiError("wrong-kind", "This library source is not audio.");
  const file = new File([blob], `${media.item.title}.${media.extension}`, { type: media.mimeType });
  return {
    ...probe,
    id: media.checksum,
    path: `library:${id}`,
    source: `library:${id}`,
    createdAt: "",
    mimeType: media.mimeType,
    transient: true,
    handle: {
      getFile: async () => {
        current();
        return file;
      },
    },
  };
}
