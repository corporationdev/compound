import { AssetLibrary } from '@compound/assets';
import { getLibrary } from '@compound/runtime';
import { mergeCatalogItems, type CatalogKind } from '@compound/backend/catalog';
import { catalogFile, getCatalogItem, listCatalog, resolveCatalogLink, searchExternalCatalog } from '@/lib/catalog';
import { serverQueries } from '@/lib/query-cache';
import { browseCatalog, catalogSearchInput, catalogSelection, catalogSourceId } from '@/lib/catalog-discovery';
import { importCatalogAsset } from '@/engine/catalog-assets';
import { createProjectFS } from '@/projects/fs';
import { mainBridge } from '@/lib/ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { CliProjectTarget } from '@compound/cli/channels';
import { attachedSession, resolveTarget, withProjectJob } from './project-target';
import { createProjectLibraryRunner } from './project-library';

function account() {
  const scope = serverQueries.scope;
  if (!scope) throw new Error('Sign in to Compound to use the library');
  return () => { if (scope !== serverQueries.scope) throw new Error('The signed-in account changed. Retry the library command.'); return scope; };
}

export async function handleLibrarySearch(input: { kind: CatalogKind; query?: string; expand?: boolean }) {
  const { kind, query, expand } = catalogSearchInput(input), current = account();
  const local = await browseCatalog(serverQueries.client, current(), kind, query, (kind, query, cursors) => {
    current(); return listCatalog(kind, query, cursors);
  });
  current();
  const items = expand ? mergeCatalogItems(local, await searchExternalCatalog(kind, query)) : local;
  current();
  return { items: items.map(catalogSelection), count: items.length, complete: true, expanded: expand };
}
export async function handleLibraryGet({ sourceId }: { sourceId: string }) {
  const current = account(), item = await getCatalogItem(catalogSourceId(sourceId)); current(); return catalogSelection(item);
}
export async function handleLibraryResolve({ url }: { url: string }) {
  if (typeof url !== 'string' || !url.trim() || url.length > 2048) throw new Error('Pass a supported music link');
  const current = account(), item = await resolveCatalogLink('music', url.trim()); current(); return catalogSelection(item);
}

const withLibrary = createProjectLibraryRunner({
  attached: async dir => { const project = await resolveTarget({ dir }); const session = await attachedSession(project); return session ? getLibrary(session.world) : null; },
  create: dir => new AssetLibrary(createProjectFS(dir)),
});

export async function handleLibraryImport({ sourceId }: { sourceId: string }, target?: CliProjectTarget) {
  catalogSourceId(sourceId); const current = account();
  return withProjectJob(async () => {
    const project = await resolveTarget(target);
    const dir = await mainBridge.call(MAIN_CHANNELS.PROJECTS_FS_REAL_PATH, { dir: project.dir, source: '.' });
    if (!dir) throw new Error('The target project directory no longer exists');
    return withLibrary(dir, async library => {
      current();
      const before = new Set(library.list().map(asset => asset.id));
      const asset = await importCatalogAsset(library, sourceId);
      current();
      const provenance = asset.catalogSources?.find(source => source.sourceId === sourceId);
      if (!provenance || asset.type !== 'AUDIO') throw new Error('Imported audio has no catalog provenance');
      const selected = catalogSelection({ ...provenance, durationUs: Math.round(asset.duration * 1_000_000),
        provider: 'upload', inUserLibrary: false, inGlobalLibrary: false, status: 'ready' });
      return { ...selected, projectId: project.id, assetId: asset.id, path: asset.path,
        localPath: library.fs.absolute?.(asset.source), reused: before.has(asset.id) };
    });
  });
}

/** Inspect cached bytes without adding membership or a project asset. */
export async function resolveLibraryMedia(sourceId: string): Promise<import('@compound/assets').Asset> {
  const current = account();
  const { blob, media } = await catalogFile(catalogSourceId(sourceId)); current();
  const { probeMedia } = await import('@compound/assets');
  const probe = await probeMedia(blob, media.mimeType); current();
  if (probe.type !== 'AUDIO') throw new Error('This library source is not audio');
  const file = new File([blob], `${media.item.title}.${media.extension}`, { type: media.mimeType });
  return { ...probe, id: media.checksum, path: `library:${sourceId}`, source: `library:${sourceId}`,
    createdAt: '', mimeType: media.mimeType, transient: true,
    handle: { getFile: async () => { current(); return file; } } };
}
