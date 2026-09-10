import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type JSX } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { useInfiniteQuery } from '@tanstack/solid-query';
import { serverQueries } from '@/lib/query-cache';
import { catalogListKey, catalogListOptions } from '@/lib/catalog-list';
import { useWorld } from '@compound/koota-solid';
import { Computed, getActiveEntity, Playback, Root, stopPlayback, store } from '@compound/runtime';
import { toast } from 'somoto';
import { useAuth } from '@/context/auth';
import { useLibrary } from '@/engine/library';
import { importCatalogAsset, CATALOG_DRAG_TYPE } from '@/engine/catalog-assets';
import { insertAsset } from '@/engine/insert-asset';
import { catalogFile, listCatalog, mergeCatalogItems, resolveCatalogLink, searchExternalCatalog, uploadCatalogFile, type CatalogItem, type CatalogKind, type SourceRange } from '@/lib/catalog';
import { CatalogThumbnail } from './catalog-thumbnail';
import { CatalogTrimmer } from './catalog-trimmer';
import { CatalogPreviewPlayer, type PreviewState } from '@/lib/catalog-preview';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from '../ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuTrigger } from '../ui/dropdown-menu';

const duration = (us?: number) => us === undefined ? '—' : us > 0 && us < 1_000_000 ? `${(us / 1e6).toFixed(2)}s` : `${Math.floor(us / 60_000_000)}:${Math.floor(us / 1_000_000 % 60).toString().padStart(2, '0')}`;
const isMusicLink = (kind: CatalogKind, value: string) => kind === 'music' && /^https?:\/\//i.test(value.trim());

export function Catalog(props: { active: boolean; navigation: JSX.Element }) {
  const auth = useAuth(), library = useLibrary(), world = useWorld();
  const userId = createMemo(() => auth.user()?.id);
  const [kind, setKind] = createSignal<CatalogKind>('music');
  const [query, setQuery] = createSignal('');
  const [catalog, setCatalog] = createStore({ items: [] as CatalogItem[] });
  const items = () => catalog.items;
  // Preserve rows (and their local thumbnail URLs) across background refreshes.
  const setItems = (next: CatalogItem[] | ((previous: CatalogItem[]) => CatalogItem[])) => {
    const value = typeof next === 'function' ? next(untrack(() => unwrap(catalog.items))) : next;
    setCatalog('items', reconcile(value, { key: 'sourceId' }));
  };
  const [external, setExternal] = createSignal<CatalogItem[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [externalError, setExternalError] = createSignal('');
  const [listText, setListText] = createSignal('');
  createEffect(() => {
    const text = query().trim();
    if (!text || isMusicLink(kind(), text)) { setListText(''); return; }
    const timer = setTimeout(() => setListText(text), 200);
    onCleanup(() => clearTimeout(timer));
  });
  const listing = useInfiniteQuery(() => catalogListOptions(serverQueries.scope, kind(), listText(), props.active && !!userId(), listCatalog), () => serverQueries.client);
  const loading = () => props.active && listing.isPending;
  const fetching = () => listing.isFetching;
  const error = () => listing.error?.message ?? '';
  const refresh = () => { void listing.refetch(); };
  const loadMore = () => { if (!listing.isFetching) void listing.fetchNextPage(); };
  createEffect(() => {
    const data = listing.data;
    setItems(data ? mergeCatalogItems(...data.pages.map(page => page.items)) : []);
  });
  const [savedOnly, setSavedOnly] = createSignal(false);
  const [selected, setSelected] = createSignal<CatalogItem | null>(null);
  const [status, setStatus] = createSignal(''), [busy, setBusy] = createSignal(false);
  const [added, setAdded] = createSignal(false);
  let addedTimer: ReturnType<typeof setTimeout> | undefined;
  let addRevision = 0;
  const [uploading, setUploading] = createSignal('');
  const [playback, setPlayback] = createSignal<PreviewState>({ sourceId: '', preparing: false, playing: false, position: 0, duration: 0, stage: '', error: '' });
  const [trim, setTrim] = createSignal(false), [start, setStart] = createSignal(0), [end, setEnd] = createSignal(0);
  let input: HTMLInputElement | undefined, upload: HTMLInputElement | undefined;
  let searchController: AbortController | undefined;
  let searchRevision = 0, previousUser: string | undefined;
  let searchContext = '';
  const results = createMemo(() => mergeCatalogItems(items(), external()).filter(item => item.kind === kind() && (!savedOnly() || item.inUserLibrary)));
  const inProject = (id: string) => library()?.list().some(asset => asset.catalogSources?.some(source => source.sourceId === id)) ?? false;
  const range = (): SourceRange | undefined => {
    if (!end() && !start()) return undefined;
    return { sourceStartUs: Math.round(start() * 1_000_000), sourceEndUs: Math.round(end() * 1_000_000) };
  };
  const invalidRange = () => trim() && (!Number.isFinite(start()) || !Number.isFinite(end()) || start() < 0 || end() <= start() || end() > (selected()?.durationUs ?? 0) / 1_000_000);
  const player = new CatalogPreviewPlayer(setPlayback, {
    load: catalogFile,
    beforePlay: () => { for (const entity of world.query(Playback)) stopPlayback(world, entity); },
    ready: ready => {
      setStart(player.selectionStart); setEnd(player.selectionEnd);
      updateItem(ready);
    },
  });
  const resetAdded = () => { addRevision++; clearTimeout(addedTimer); setAdded(false); };
  const stopPreview = () => { player.stop(); setStatus(''); resetAdded(); };
  const choose = (item: CatalogItem) => {
    if (selected()?.sourceId === item.sourceId) return;
    if (selected()?.sourceId !== item.sourceId) stopPreview();
    setSelected(item); setTrim(false);
    setStart((item.sourceRange?.sourceStartUs ?? 0) / 1_000_000);
    setEnd((item.sourceRange?.sourceEndUs ?? item.durationUs ?? 0) / 1_000_000);
  };
  const updateItem = (item: CatalogItem) => {
    setItems(list => list.map(old => old.sourceId === item.sourceId ? item : old));
    setExternal(list => list.map(old => old.sourceId === item.sourceId ? item : old));
    if (selected()?.sourceId === item.sourceId) setSelected(item);
  };
  createEffect(() => {
    const user = userId();
    if (user !== previousUser) {
      previousUser = user; searchController?.abort(); stopPreview();
      setExternal([]); setSelected(null);
    }
    if (!props.active) stopPreview();
  });
  createEffect(() => {
    const active = props.active, user = userId(), type = kind(), text = query().trim();
    const context = JSON.stringify([active, user, type, text]);
    if (context !== searchContext) {
      searchContext = context; searchRevision++;
      searchController?.abort(); setSearching(false); setExternal([]); setExternalError('');
    }
  });
  const searchOutside = async () => {
    const current = ++searchRevision, text = query().trim();
    searchController?.abort(); searchController = new AbortController();
    setSearching(true); setExternalError('');
    try {
      if (isMusicLink(kind(), text)) {
        const item = await resolveCatalogLink(kind(), text);
        if (current !== searchRevision) return;
        setExternal([item]); choose(item);
        const url = new URL(text), seconds = Number(url.searchParams.get('t')?.replace(/s$/, '') ?? url.searchParams.get('start') ?? 0);
        if (Number.isFinite(seconds) && seconds > 0) { setStart(seconds); setTrim(true); }
      } else {
        const found = await searchExternalCatalog(kind(), text, searchController.signal);
        if (current === searchRevision) setExternal(found);
      }
    } catch (err) { if (current === searchRevision && (err as Error).name !== 'AbortError') setExternalError((err as Error).message); }
    finally { if (current === searchRevision) setSearching(false); }
  };
  const preview = (item: CatalogItem) => {
    choose(item); setStatus('');
    if (playback().sourceId === item.sourceId && playback().blob && !playback().error) player.toggle();
    else void player.prepare(item, range());
  };
  const selectRange = (from: number, to: number) => {
    setStart(from); setEnd(to); player.setSelection(range());
  };
  const pending = () => busy() || playback().preparing;
  const add = async () => {
    const item = selected(), lib = library(); if (!item || !lib || busy() || invalidRange()) return;
    const parent = getActiveEntity(world) ?? world.get(Root)!;
    const at = store(world, Computed).localTimeInSeconds[parent.id()] ?? 0;
    const selectedRange = range();
    resetAdded(); const currentAdd = addRevision;
    setBusy(true); setStatus('');
    try {
      const asset = await importCatalogAsset(lib, item.sourceId);
      const provenance = asset.catalogSources?.find(source => source.sourceId === item.sourceId);
      if (provenance && selectedRange && !lib.closed) {
        lib.rememberCatalogSource(asset, { ...provenance, sourceRange: selectedRange });
        await lib.flush();
      }
      if (library() === lib && !lib.closed) {
        if (!parent.isAlive() || !insertAsset(world, asset, { parent, start: at, sourceRange: selectedRange })) throw new Error('The scene was closed. Audio is available in Project.');
        if (currentAdd === addRevision) {
          setAdded(true);
          addedTimer = setTimeout(() => setAdded(false), 1000);
        }
      }
    } catch (err) { if (currentAdd === addRevision) setStatus((err as Error).message); }
    finally { setBusy(false); }
  };
  const uploadFiles = async (files: File[]) => {
    const type = kind();
    for (const file of files) {
      setUploading(`Uploading ${file.name}…`);
      try { const item = await uploadCatalogFile(file, type); choose(item); await serverQueries.client.invalidateQueries({ queryKey: catalogListKey(serverQueries.scope) }); }
      catch (err) { toast.error('Could not upload audio', { description: (err as Error).message }); }
    }
    setUploading('');
  };
  const playbackTimer = setInterval(() => {
    if (playback().playing && [...world.query(Playback)].some(entity => entity.get(Playback)?.playing)) player.pause();
  }, 200);
  onCleanup(() => { searchRevision++; searchController?.abort(); stopPreview(); clearInterval(playbackTimer); });

  return <div class="flex min-h-0 flex-1 flex-col text-xs" onDragOver={event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); }} onDrop={event => {
    const files = [...event.dataTransfer?.files ?? []];
    if (files.length) { event.preventDefault(); event.stopPropagation(); void uploadFiles(files); }
  }}>
    <div class="h-12 shrink-0 flex items-center gap-1 px-2 border-y border-border">
      <div class="flex-1 min-w-0">{props.navigation}</div>
      <DropdownMenu><DropdownMenuTrigger as={Button} size="icon" variant="ghost" aria-label="Filter library"><Icon name="preferences-adjust" /></DropdownMenuTrigger><DropdownMenuPortal><DropdownMenuContent>
        <DropdownMenuItem onSelect={() => setSavedOnly(value => !value)}>{savedOnly() ? 'Show all sources' : 'Show saved only'}</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenuPortal></DropdownMenu>
      <DropdownMenu><DropdownMenuTrigger as={Button} size="icon" variant="ghost" aria-label="Add to library"><Icon name="plus-add" /></DropdownMenuTrigger><DropdownMenuPortal><DropdownMenuContent>
        <DropdownMenuItem onSelect={() => upload?.click()}>Upload audio…</DropdownMenuItem>
        <Show when={kind() === 'music'}><DropdownMenuItem onSelect={() => { setQuery(''); input?.focus(); }}>Add from link…</DropdownMenuItem></Show>
      </DropdownMenuContent></DropdownMenuPortal></DropdownMenu>
      <input ref={upload} hidden type="file" accept=".mp3,.m4a,.wav" multiple onChange={event => { void uploadFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = ''; }} />
    </div>
    <Show when={auth.isAuthenticated()} fallback={<p class="p-4 text-muted-foreground">Sign in to browse the library and save your audio.</p>}>
      <div class="shrink-0 p-3 space-y-3">
        <div role="tablist" aria-label="Audio type" class="flex gap-1">
          <For each={['music', 'sfx'] as const}>{type => <button type="button" role="tab" aria-selected={kind() === type} onClick={() => { if (kind() !== type) { stopPreview(); setSelected(null); setKind(type); setQuery(''); } }} class="rounded px-2 py-1.5 data-[selected=true]:bg-accent text-muted-foreground data-[selected=true]:text-foreground" data-selected={kind() === type}>{type === 'music' ? 'Music' : 'Sound effects'}</button>}</For>
        </div>
        <input ref={input} type="search" maxLength={kind() === 'music' ? 2048 : 120} aria-label={`Search ${kind() === 'music' ? 'music' : 'sound effects'}`} placeholder={kind() === 'music' ? 'Search music or paste a link' : 'Search sound effects'} value={query()} onInput={event => setQuery(event.currentTarget.value)} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && isMusicLink(kind(), query())) void searchOutside(); }} class="w-full rounded bg-input px-3 py-2 text-xs placeholder:text-muted-foreground" />
        <Show when={savedOnly()}><button class="text-muted-foreground" onClick={() => setSavedOnly(false)}>Saved only ×</button></Show>
        <Show when={isMusicLink(kind(), query())}><Button variant="secondary" size="small" class="w-full" disabled={searching()} onClick={searchOutside}>{searching() ? 'Opening link…' : 'Open this link'}</Button></Show>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        <Show when={error()}><p role="alert" class="p-2 text-destructive">{error()} <button onClick={refresh} class="underline">Retry</button></p></Show>
        <For each={results()}>{item => <div class="flex items-center gap-1 rounded p-1 data-[selected=true]:bg-accent" data-selected={selected()?.sourceId === item.sourceId} draggable onDragStart={event => { event.dataTransfer?.setData(CATALOG_DRAG_TYPE, JSON.stringify({ sourceId: item.sourceId, sourceRange: selected()?.sourceId === item.sourceId ? range() : item.sourceRange })); }}>
          <CatalogThumbnail item={item} active={props.active} onPreview={() => preview(item)} preparing={playback().sourceId === item.sourceId && playback().preparing} progress={playback().sourceId === item.sourceId ? playback().progress : undefined} playing={playback().sourceId === item.sourceId && playback().playing} />
          <button type="button" class="min-w-0 flex-1 py-2 text-left" onClick={() => choose(item)}>
            <span class="block truncate text-foreground">{item.title}</span>
            <span class="block truncate text-xxs text-muted-foreground">{[duration(item.sourceRange ? item.sourceRange.sourceEndUs - item.sourceRange.sourceStartUs : item.durationUs), item.inUserLibrary ? 'Saved' : '', inProject(item.sourceId) ? 'In project' : ''].filter(Boolean).join(' · ')}</span>
          </button>
        </div>}</For>
        <Show when={loading()}><p role="status" class="p-3 text-muted-foreground">Loading library…</p></Show>
        <Show when={!loading() && !error() && !results().length}><p class="p-3 text-muted-foreground">{query() ? 'No library matches.' : 'Your library is ready for audio. Upload a song or add a link.'}</p></Show>
        <Show when={!loading() && listing.hasNextPage}><Button variant="ghost" size="small" class="w-full" disabled={fetching()} onClick={loadMore}>Load more</Button></Show>
        <Show when={query().trim().length >= 2 && !isMusicLink(kind(), query())}>
          <div class="mt-3 border-t border-border pt-3">
            <Button variant="secondary" size="small" class="h-auto min-h-8 w-full whitespace-normal text-left" disabled={searching()} onClick={searchOutside}>{searching() ? 'Searching catalog…' : `Search catalog for “${query().trim()}”`}</Button>
            <Show when={externalError()}><p role="alert" class="mt-2 text-destructive">{externalError()}</p></Show>
          </div>
        </Show>
      </div>
      <Show when={uploading()}><p role="status" class="border-t border-border p-3 text-muted-foreground">{uploading()}</p></Show>
      <Show when={selected()}>{item => <div class="shrink-0 border-t border-border p-3 space-y-2 max-h-[55%] overflow-y-auto">
        <div class="flex items-center gap-2">
          <CatalogThumbnail item={item()} active={props.active} onPreview={() => preview(item())} preparing={playback().preparing} progress={playback().progress} playing={playback().playing} />
          <div class="min-w-0 flex-1">
            <div class="flex h-5 items-center gap-1">
              <p class="min-w-0 flex-1 truncate font-medium" title={item().title}>{item().title}</p>
              <Button size="small" variant="ghost" aria-label="Close audio preview" class="size-5 p-0 text-muted-foreground" onClick={() => { stopPreview(); setSelected(null); }}><Icon name="close-remove-small" /></Button>
            </div>
            <input type="range" aria-label="Audio preview position" class="block h-4 w-full accent-primary" min="0" max={Math.max(0, end() - start())} step="0.01" value={Math.max(0, playback().position - start())} disabled={!playback().blob || playback().preparing}
              onPointerDown={() => player.scrub(true)} onPointerUp={() => player.scrub(false)} onPointerCancel={() => player.scrub(false)} onBlur={() => player.scrub(false)} onKeyDown={event => event.stopPropagation()} onInput={event => player.seek(event.currentTarget.valueAsNumber + start())} />
            <div class="flex h-5 items-center gap-1">
              <p class="min-w-0 flex-1 truncate text-xxs text-muted-foreground tabular-nums" title={playback().preparing ? playback().stage : undefined}>{playback().preparing ? playback().stage : `${duration(Math.max(0, playback().position - start()) * 1e6)} / ${duration((end() - start()) * 1e6)}`}</p>
              <Tooltip>
                <TooltipTrigger<typeof Button> as={triggerProps => <Button {...triggerProps} size="small" class="size-5 p-0" variant={trim() ? 'secondary' : 'ghost'} aria-label="Trim audio" aria-pressed={trim()} disabled={!playback().blob || playback().preparing} onClick={() => { setTrim(value => !value); player.loopsSelection = trim(); }}><Icon name="scissors" /></Button>} />
                <TooltipPortal><TooltipContent>Trim audio</TooltipContent></TooltipPortal>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger<typeof Button> as={triggerProps => <Button {...triggerProps} size="small" class="size-5 p-0" aria-label="Add to project" aria-busy={busy()} disabled={pending() || invalidRange() || !library()} onClick={add}>
                  <span aria-hidden="true" class="relative size-5">
                    <span class="absolute inset-0 flex items-center justify-center transition-[opacity,transform,scale,rotate] duration-200 ease-out motion-reduce:transition-none" classList={{ 'opacity-0 scale-50 rotate-90': added(), 'opacity-100 scale-100 rotate-0': !added() }}><Icon name="plus-add-small" /></span>
                    <span class="absolute inset-0 flex items-center justify-center transition-[opacity,transform,scale,rotate] duration-200 ease-out motion-reduce:transition-none" classList={{ 'opacity-100 scale-100 rotate-0': added(), 'opacity-0 scale-50 -rotate-45': !added() }}><Icon name="confirm-check" /></span>
                  </span>
                </Button>} />
                <TooltipPortal><TooltipContent>Add to project</TooltipContent></TooltipPortal>
              </Tooltip>
              <span role="status" class="sr-only">{added() ? 'Added to project' : ''}</span>
            </div>
          </div>
        </div>
        <Show when={trim() && playback().blob}><CatalogTrimmer blob={playback().blob} duration={(item().durationUs ?? 0) / 1e6} start={start()} end={end()} onChange={selectRange} onScrub={editing => player.scrub(editing)} /></Show>
        <Show when={playback().error}><p role="alert" class="text-destructive break-words">{playback().error} <button class="underline" onClick={() => preview(item())}>Retry</button></p></Show>
        <Show when={status()}><p role="status" class="text-muted-foreground break-words">{status()}</p></Show>
      </div>}</Show>
    </Show>
  </div>;
}
