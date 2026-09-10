"use node";

import type { CatalogKind, CatalogProvider } from "../catalog_types";
import { myinstantsProvider } from "./myinstants";
import type { MediaProvider } from "./types";
import { youtubeProvider } from "./youtube";

const providers: Record<CatalogProvider, MediaProvider> = {
  youtube: youtubeProvider,
  myinstants: myinstantsProvider,
};
const providersByKind: Record<CatalogKind, CatalogProvider> = {
  music: "youtube",
  sfx: "myinstants",
};

export function providerForKind(kind: CatalogKind): CatalogProvider {
  return providersByKind[kind];
}
export function getProvider(provider: CatalogProvider): MediaProvider {
  return providers[provider];
}
