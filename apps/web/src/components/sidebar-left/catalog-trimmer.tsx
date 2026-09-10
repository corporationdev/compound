import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { deriveWaveform, downsamplePeaks } from '@compound/assets';

/** PostBob's source-time trimmer: bounded handles, zoom, and audition from the new start. */
export function CatalogTrimmer(props: {
  blob?: Blob; duration: number; start: number; end: number;
  onChange: (start: number, end: number) => void; onScrub: (editing: boolean) => void;
}) {
  const [peaks, setPeaks] = createSignal<Uint8ClampedArray>();
  const [failed, setFailed] = createSignal(false);
  const [zoom, setZoom] = createSignal(1), [offset, setOffset] = createSignal(0);
  const windowDuration = () => props.duration / zoom();
  const visibleStart = () => Math.min(offset(), Math.max(0, props.duration - windowDuration()));
  const sourceBlob = createMemo(() => props.blob);
  createEffect(() => {
    const blob = sourceBlob(); let canceled = false;
    setPeaks(undefined); setFailed(false);
    if (blob) void deriveWaveform(blob, 100).then(value => { if (!canceled) { setPeaks(value ?? undefined); setFailed(!value); } }).catch(() => { if (!canceled) setFailed(true); });
    onCleanup(() => { canceled = true; });
  });
  onCleanup(() => props.onScrub(false));
  const x = (seconds: number) => (seconds - visibleStart()) / windowDuration() * 100;
  const path = createMemo(() => {
    const data = peaks(); if (!data || !props.duration) return '';
    const from = Math.floor(visibleStart() / props.duration * data.length);
    const to = Math.ceil((visibleStart() + windowDuration()) / props.duration * data.length);
    const values = downsamplePeaks(data.slice(from, to), 100);
    const upper = [...values].map((amplitude, index) => `${index * 2},${30 - Math.max(0.5, amplitude / 255 * 27)}`);
    const lower = [...values].map((amplitude, index) => `${index * 2},${30 + Math.max(0.5, amplitude / 255 * 27)}`).reverse();
    return `M${upper.join(' L')} L${lower.join(' L')} Z`;
  });
  let track!: HTMLDivElement;
  const adjust = (isStart: boolean, seconds: number) => {
    const minimum = Math.min(props.duration, 1 / 30);
    const start = isStart ? Math.min(Math.max(0, seconds), props.end - minimum) : props.start;
    const end = isStart ? props.end : Math.min(props.duration, Math.max(props.start + minimum, seconds));
    props.onChange(Math.round(start * 1e6) / 1e6, Math.round(end * 1e6) / 1e6);
  };
  const handle = (isStart: boolean) => {
    const value = () => isStart ? props.start : props.end;
    const visible = () => x(value()) >= -0.001 && x(value()) <= 100.001;
    return <Show when={visible()}><button type="button" role="slider" aria-label={isStart ? 'Selection start' : 'Selection end'} aria-valuemin={0} aria-valuemax={props.duration} aria-valuenow={value()} aria-valuetext={`${value().toFixed(2)} seconds`}
      class="absolute top-0 h-full w-5 -translate-x-1/2 cursor-ew-resize touch-none text-primary focus-visible:outline-2" style={{ left: `${Math.max(0, Math.min(100, x(value())))}%` }}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); props.onScrub(true); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const bounds = track.getBoundingClientRect(); adjust(isStart, visibleStart() + (event.clientX - bounds.left) / bounds.width * windowDuration()); } }}
      onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); props.onScrub(false); }} onLostPointerCapture={() => props.onScrub(false)}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); adjust(isStart, value() + (event.key === 'ArrowRight' ? 0.01 : -0.01)); } }}>
      <span class="absolute inset-y-0 left-1/2 border-l-2 border-dashed border-current" /><span class="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" />
    </button></Show>;
  };
  return <div class="space-y-2 pt-2" aria-label="Trim audio">
    <div class="px-2"><div ref={track} class="relative h-16 rounded bg-background/50">
      <svg viewBox="0 0 200 60" preserveAspectRatio="none" class="absolute size-full text-muted-foreground"><path d={path()} fill="currentColor" opacity="0.35" /></svg>
      <div class="absolute inset-y-0 overflow-hidden border-y border-primary/40 bg-primary/10" style={{ left: `${Math.max(0, x(props.start))}%`, right: `${100 - Math.min(100, x(props.end))}%` }} />
      <Show when={!peaks()}><span class="absolute inset-0 flex items-center justify-center text-xxs text-muted-foreground">{failed() ? 'Waveform unavailable' : 'Loading waveform…'}</span></Show>
      {handle(true)}{handle(false)}
    </div></div>
    <div class="flex items-center gap-2 text-xxs text-muted-foreground"><span class="flex-1 tabular-nums">{props.start.toFixed(2)}s – {props.end.toFixed(2)}s</span><button aria-label="Zoom out waveform" disabled={zoom() <= 1} onClick={() => setZoom(value => Math.max(1, value / 2))} class="px-1 disabled:opacity-30">−</button><button aria-label="Zoom in waveform" disabled={zoom() >= 64} onClick={() => { setOffset(props.start); setZoom(value => Math.min(64, value * 2)); }} class="px-1 disabled:opacity-30">+</button></div>
  </div>;
}
