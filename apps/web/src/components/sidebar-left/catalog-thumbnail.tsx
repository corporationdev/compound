import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { getCatalogArtwork, type CatalogItem } from '@/lib/catalog';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { CatalogProgress } from './catalog-progress';

/** Fetch visible artwork independently: browsing never starts an audio download. */
export function CatalogThumbnail(props: { item: CatalogItem; active: boolean; onPreview: () => void; preparing?: boolean; progress?: number; playing?: boolean }) {
  let element!: HTMLDivElement;
  const [visible, setVisible] = createSignal(false);
  const [failedUrl, setFailedUrl] = createSignal('');
  const [artwork] = createResource(
    () => props.active && visible() && props.item.artworkAvailable ? props.item.sourceId : false,
    async sourceId => {
      try { return await getCatalogArtwork(sourceId); }
      catch (error) {
        console.warn('[catalog] Artwork request failed:', error instanceof Error ? error.message : 'Unknown error');
        return null;
      }
    },
  );
  onMount(() => {
    const observer = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { rootMargin: '80px' });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });
  const localUrl = createMemo(() => {
    const blob = artwork();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    onCleanup(() => URL.revokeObjectURL(url));
    return url;
  });
  const imageUrl = () => localUrl() && localUrl() !== failedUrl() ? localUrl() : undefined;
  return <div ref={element} class="size-14 shrink-0">
    <Button variant="ghost" aria-label={`${props.preparing ? 'Preparing' : props.playing ? 'Pause' : 'Preview'} ${props.item.title}`} disabled={props.preparing} onClick={props.onPreview} class="group relative h-full w-full overflow-hidden rounded bg-accent p-0">
      <Show when={imageUrl()}>{url => <>
        <img src={url()} alt="" loading="lazy" class="absolute inset-0 h-full w-full origin-center scale-[1.75] object-cover object-center" onError={() => setFailedUrl(url())} />
        <span class="absolute inset-0 bg-black/25 group-hover:bg-black/40" />
      </>}</Show>
      <span class={`relative z-10 ${imageUrl() ? 'text-white' : ''}`}><Show when={props.progress !== undefined} fallback={<Icon name={props.playing ? "pause" : "play"} />}><CatalogProgress progress={props.progress ?? 0} /></Show></span>
    </Button>
  </div>;
}
