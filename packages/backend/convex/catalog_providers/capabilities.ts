import type { CatalogProvider } from "../catalog_types";

// Safe for the query runtime: do not import Node-only provider implementations.
export const providerCapabilities: Record<
  CatalogProvider,
  { artwork: boolean }
> = {
  youtube: { artwork: true },
  myinstants: { artwork: false },
};
