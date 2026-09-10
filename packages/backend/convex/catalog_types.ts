import { v } from 'convex/values';
export type { CatalogKind, CatalogProvider } from '../catalog';
export const catalogKind = v.union(v.literal('music'), v.literal('sfx'));
export const catalogProvider = v.union(v.literal('youtube'), v.literal('myinstants'));
export const catalogSourceRange = v.object({ sourceStartUs: v.number(), sourceEndUs: v.number() });
export type DiscoveredCatalogItem = { externalId: string; title: string; description?: string; durationUs?: number };
export const discoveredCatalogItem = v.object({ externalId: v.string(), title: v.string(), description: v.optional(v.string()), durationUs: v.optional(v.number()) });
export function validateRange(range: { sourceStartUs: number; sourceEndUs: number }, duration?: number) {
  if (!Number.isSafeInteger(range.sourceStartUs) || !Number.isSafeInteger(range.sourceEndUs) || range.sourceStartUs < 0 || range.sourceEndUs <= range.sourceStartUs || (duration !== undefined && range.sourceEndUs > duration)) throw new Error('Select a non-empty range within the audio');
}
