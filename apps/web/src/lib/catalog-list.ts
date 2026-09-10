import { infiniteQueryOptions } from '@tanstack/solid-query';
import type { CatalogKind, CatalogList } from '@compound/backend/catalog';

export type CatalogCursors = Pick<CatalogList, 'personalCursor' | 'curatedCursor'>;
export const catalogListKey = (scope: string | null) => ['catalog-list', scope] as const;

export function catalogListOptions(scope: string | null, kind: CatalogKind, query: string, active: boolean,
  request: (kind: CatalogKind, query: string, cursors?: CatalogCursors) => Promise<CatalogList>) {
  return infiniteQueryOptions({
    queryKey: [...catalogListKey(scope), kind, query.trim()],
    enabled: active && scope !== null,
    meta: { persist: true },
    initialPageParam: undefined as CatalogCursors | undefined,
    queryFn: ({ pageParam }) => request(kind, query.trim(), pageParam),
    getNextPageParam: (last: CatalogList) => last.personalCursor || last.curatedCursor
      ? { personalCursor: last.personalCursor, curatedCursor: last.curatedCursor } : undefined,
  });
}
