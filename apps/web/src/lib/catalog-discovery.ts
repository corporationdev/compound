import { InfiniteQueryObserver, type QueryClient, type InfiniteData } from '@tanstack/solid-query';
import { mergeCatalogItems, type CatalogItem, type CatalogKind, type CatalogList } from '@compound/backend/catalog';
import { catalogListOptions, type CatalogCursors } from './catalog-list';

export function catalogSearchInput(input: { kind: CatalogKind; query?: string; expand?: boolean }) {
  if (input.kind !== 'music' && input.kind !== 'sfx') throw new Error('--kind must be music or sfx');
  if (input.query !== undefined && typeof input.query !== 'string') throw new Error('Search query must be text');
  const query = (input.query ?? '').trim();
  if (query.length > 120) throw new Error('Search query must be at most 120 characters');
  if (input.expand !== undefined && typeof input.expand !== 'boolean') throw new Error('expand must be a boolean');
  if (input.expand && query.length < 2) throw new Error('--expand needs a search query of at least two characters. Omit --expand to browse the library.');
  return { kind: input.kind, query, expand: input.expand ?? false };
}

/** Complete a browse using the exact infinite-query entry used by the panel. */
export async function browseCatalog(client: QueryClient, scope: string, kind: CatalogKind, query: string,
  request: (kind: CatalogKind, query: string, cursors?: CatalogCursors) => Promise<CatalogList>) {
  const options = catalogListOptions(scope, kind, query, true, request);
  let data: InfiniteData<CatalogList> = await client.fetchInfiniteQuery(options);
  const observer = new InfiniteQueryObserver(client, options);
  const visited = new Set<string>();
  try {
    for (;;) {
      const last = data.pages.at(-1)!;
      if (!last.personalCursor && !last.curatedCursor) break;
      const cursor = JSON.stringify([last.personalCursor, last.curatedCursor]);
      if (visited.has(cursor)) throw new Error('Library pagination stopped advancing. Retry the search.');
      visited.add(cursor);
      const result = await observer.fetchNextPage({ cancelRefetch: false, throwOnError: true });
      if (!result.data) throw new Error('Library search returned no data');
      data = result.data;
    }
    return mergeCatalogItems(...data.pages.map(page => page.items));
  } finally { observer.destroy(); }
}

/** CLI times are seconds; source IDs remain distinct from local asset IDs. */
export function catalogSelection(item: CatalogItem) {
  const sourceRange = item.sourceRange && { start: item.sourceRange.sourceStartUs / 1_000_000, end: item.sourceRange.sourceEndUs / 1_000_000 };
  return {
    sourceId: item.sourceId, kind: item.kind, title: item.title,
    ...(item.description ? { description: item.description } : {}),
    ...(item.durationUs !== undefined ? { duration: item.durationUs / 1_000_000 } : {}),
    ...(sourceRange ? { sourceRange, selectedDuration: (item.sourceRange!.sourceEndUs - item.sourceRange!.sourceStartUs) / 1_000_000 } : {}),
    status: item.status, ...(item.error ? { error: item.error } : {}),
  };
}

export function catalogSourceId(value: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Pass an exact source ID returned by library search or resolve');
  return value;
}
