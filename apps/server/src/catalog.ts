import type { ConvexHttpClient } from 'convex/browser';
import { z } from 'zod';
import { api } from '@compound/backend/convex/_generated/api';
import type { Id } from '@compound/backend/convex/_generated/dataModel';
import { mergeCatalogItems } from '@compound/backend/catalog';

const kind = z.enum(['music', 'sfx']);
const sourceId = z.string().min(1).max(100).transform(id => id as Id<'catalogSources'>);
const source = z.object({ sourceId }).strict();
export const CATALOG_OPERATIONS = ['catalog-list', 'catalog-get', 'catalog-artwork', 'catalog-search', 'catalog-search-status', 'catalog-resolve', 'catalog-prepare', 'catalog-playback', 'catalog-save', 'catalog-remove'] as const;
export async function catalogRequest(client: ConvexHttpClient, path: string, body: unknown): Promise<unknown> {
  switch (path) {
    case 'catalog-list': {
      const args = z.object({ kind, query: z.string().max(120).optional(), personalCursor: z.string().nullable().optional(), curatedCursor: z.string().nullable().optional() }).strict().parse(body);
      const [personal, curated] = await Promise.all([
        args.personalCursor === null ? { items: [], cursor: null } : client.query(api.catalog.page, { kind: args.kind, query: args.query, scope: 'personal', paginationOpts: { numItems: 20, cursor: args.personalCursor ?? null } }),
        args.curatedCursor === null ? { items: [], cursor: null } : client.query(api.catalog.page, { kind: args.kind, query: args.query, scope: 'curated', paginationOpts: { numItems: 20, cursor: args.curatedCursor ?? null } }),
      ]);
      return { items: mergeCatalogItems(personal.items, curated.items), personalCursor: personal.cursor, curatedCursor: curated.cursor };
    }
    case 'catalog-get': return client.query(api.catalog.get, source.parse(body));
    case 'catalog-artwork': return client.action(api.catalog_actions.artwork, source.parse(body));
    case 'catalog-prepare': return client.mutation(api.catalog.prepare, source.parse(body));
    case 'catalog-playback': return client.action(api.catalog_actions.playback, source.parse(body));
    case 'catalog-remove': return client.mutation(api.catalog.remove, source.parse(body));
    case 'catalog-search': return client.mutation(api.catalog.startSearch, z.object({ kind, query: z.string().min(2).max(120) }).strict().parse(body));
    case 'catalog-search-status': return client.query(api.catalog.searchResult, z.object({ searchId: z.string().min(1).max(100).transform(id => id as Id<'catalogSearches'>) }).strict().parse(body));
    case 'catalog-resolve': return client.action(api.catalog_actions.resolveLink, z.object({ kind, url: z.string().url().max(2048) }).strict().parse(body));
    case 'catalog-save': return client.mutation(api.catalog.save, z.object({ sourceId, title: z.string().min(1).max(160).optional(), description: z.string().max(1000).optional(), sourceRange: z.object({ sourceStartUs: z.number().int().nonnegative(), sourceEndUs: z.number().int().positive() }).strict().nullable().optional() }).strict().parse(body));
    default: throw new Error('Unknown library operation');
  }
}
