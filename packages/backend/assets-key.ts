/** The R2 key a library original lives at: `assets/<org>/<sampleId>/<name>`.
 *  Shared by the Convex functions that record it and the Worker that signs it,
 *  so a client can never point an asset at other bytes. */
export const originalKeyFor = (asset: { organizationId: string; sampleId: string; name: string }) =>
  `assets/${asset.organizationId}/${asset.sampleId}/${asset.name}`;
