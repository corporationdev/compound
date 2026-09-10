import type { CatalogItem, SourceRange } from '@compound/backend/catalog';

export type PreviewState = {
  sourceId: string; preparing: boolean; playing: boolean; progress?: number;
  position: number; duration: number; range?: SourceRange; stage: string; error: string; blob?: Blob;
};
const empty = (): PreviewState => ({ sourceId: '', preparing: false, playing: false, position: 0, duration: 0, stage: '', error: '' });
export const preparationProgress = (seconds: number, kind: CatalogItem['kind']) => 0.98 * seconds / (seconds + (kind === 'music' ? 40 : 4) * 0.225);

/** Port of PostBob's AudioPreviewPlayerModel: one source, cancellable loading,
 * selection-relative seeking, and loading completion only after playback starts. */
export class CatalogPreviewPlayer {
  state = empty();
  private generation = 0;
  private controller?: AbortController;
  private audio?: HTMLAudioElement;
  private url?: string;
  private timer?: ReturnType<typeof setInterval>;
  private timeout?: ReturnType<typeof setTimeout>;
  private started = 0;
  private completed?: number;
  private wantsPlayback = false;
  private scrubbing = false;
  loopsSelection = false;
  constructor(private changed: (state: PreviewState) => void, private dependencies: {
    load: (id: string, progress: (item: CatalogItem) => void, signal: AbortSignal, onMiss: () => void) => Promise<{ blob: Blob; media: { item: CatalogItem } }>;
    audio?: () => HTMLAudioElement;
    beforePlay: () => void;
    ready: (item: CatalogItem) => void;
  }) {}
  private update(change: Partial<PreviewState>) { this.state = { ...this.state, ...change }; this.changed(this.state); }
  get selectionStart() { return (this.state.range?.sourceStartUs ?? 0) / 1e6; }
  get selectionEnd() { return Math.min((this.state.range?.sourceEndUs ?? this.state.duration * 1e6) / 1e6, this.state.duration); }
  async prepare(item: CatalogItem, range = item.sourceRange) {
    this.stop();
    const current = this.generation;
    this.controller = new AbortController(); this.started = Date.now(); this.wantsPlayback = true;
    // Reading local bytes and starting the audio element should never flash
    // download UI. Only the loader's confirmed cache miss turns it on.
    this.update({ sourceId: item.sourceId, duration: (item.durationUs ?? 0) / 1e6, range, position: (range?.sourceStartUs ?? 0) / 1e6 });
    this.timer = setInterval(() => {
      if (this.state.preparing) this.update({ progress: preparationProgress((Date.now() - this.started) / 1000, item.kind) });
      else if (this.completed && Date.now() - this.completed >= 650 && this.state.progress !== undefined) this.update({ progress: undefined });
      if (this.audio && !this.scrubbing && !this.audio.paused) this.tick();
    }, 50);
    try {
      const { blob, media: { item: ready } } = await this.dependencies.load(item.sourceId, progress => {
        if (current === this.generation) this.update({ stage: progress.status === 'ready' ? 'Loading audio…' : progress.status === 'queued' ? 'Waiting for audio…' : 'Preparing audio…' });
      }, this.controller.signal, () => {
        if (current !== this.generation) return;
        this.started = Date.now();
        this.update({ preparing: true, progress: 0, stage: 'Preparing audio…' });
      });
      if (current !== this.generation) return;
      const duration = (ready.durationUs ?? 0) / 1e6;
      if (range && range.sourceStartUs >= duration * 1e6) throw new Error('The selection starts after the audio ends. Choose an earlier start.');
      const resolvedRange = range ? { sourceStartUs: range.sourceStartUs, sourceEndUs: Math.min(range.sourceEndUs || duration * 1e6, duration * 1e6) } : undefined;
      this.update({ duration, range: resolvedRange, stage: this.state.preparing ? 'Loading audio…' : '' });
      this.dependencies.ready(ready);
      this.update({ blob });
      const audio = this.dependencies.audio?.() ?? new Audio(); this.audio = audio;
      const live = () => current === this.generation && this.audio === audio;
      audio.onloadedmetadata = () => {
        if (!live()) return;
        // The backend measures the audio stream; a container can include a silent tail.
        if (!this.state.duration && Number.isFinite(audio.duration)) this.update({ duration: audio.duration });
        audio.currentTime = this.selectionStart;
        if (this.wantsPlayback) this.play();
      };
      audio.onplaying = () => { if (live()) { this.completed = Date.now(); clearTimeout(this.timeout); this.update({ preparing: false, playing: true, progress: this.state.preparing ? 1 : this.state.progress, stage: '' }); } };
      audio.onpause = () => { if (live()) this.update({ playing: false }); };
      audio.ontimeupdate = () => { if (live()) this.tick(); };
      audio.onended = () => { if (live()) this.ended(); };
      audio.onerror = () => { if (live()) this.fail('Audio could not be played. Try again.'); };
      this.url = URL.createObjectURL(blob); audio.src = this.url;
      this.timeout = setTimeout(() => { if (live() && this.wantsPlayback && this.completed === undefined) this.fail('Audio did not start. Try again.'); }, 20_000);
      audio.load();
    } catch (error) { if (current === this.generation && (error as Error).name !== 'AbortError') this.fail((error as Error).message); }
  }
  private play() {
    const audio = this.audio; if (!audio) return;
    this.dependencies.beforePlay(); this.wantsPlayback = true;
    void audio.play().catch(error => { if (audio === this.audio) this.fail(error.name === 'NotAllowedError' ? 'Press play to start the audio.' : 'Audio could not be played. Try again.'); });
  }
  toggle() {
    if (!this.audio || this.state.preparing) return;
    if (this.wantsPlayback) this.pause();
    else {
      if (this.audio.currentTime >= this.selectionEnd - 0.005) this.audio.currentTime = this.selectionStart;
      this.play();
    }
  }
  pause() { this.wantsPlayback = false; this.audio?.pause(); this.update({ playing: false }); }
  seek(seconds: number) {
    if (!Number.isFinite(seconds) || !this.audio) return;
    const position = Math.min(this.selectionEnd, Math.max(this.selectionStart, seconds));
    this.audio.currentTime = position; this.update({ position });
  }
  scrub(editing: boolean) {
    if (!this.audio || editing === this.scrubbing) return;
    this.scrubbing = editing;
    if (editing) this.audio.pause();
    else if (this.wantsPlayback) this.play();
  }
  setSelection(range?: SourceRange) {
    if (range && (range.sourceStartUs < 0 || range.sourceEndUs <= range.sourceStartUs || range.sourceEndUs > Math.round(this.state.duration * 1e6))) return;
    this.update({ range }); this.seek(this.selectionStart);
  }
  private tick() {
    if (!this.audio || this.scrubbing) return;
    if (this.audio.currentTime >= this.selectionEnd) this.ended();
    else this.update({ position: Math.max(this.selectionStart, this.audio.currentTime) });
  }
  private ended() {
    if (this.loopsSelection && this.wantsPlayback) { this.seek(this.selectionStart); this.play(); }
    else { this.pause(); this.update({ position: this.selectionEnd }); }
  }
  private fail(error: string) {
    const { sourceId, duration, range } = this.state;
    this.stop(); this.update({ sourceId, duration, range, error });
  }
  stop() {
    this.generation++; this.controller?.abort(); clearInterval(this.timer); clearTimeout(this.timeout);
    this.audio?.pause(); if (this.audio) { this.audio.removeAttribute('src'); this.audio.load(); }
    this.audio = undefined;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined; this.wantsPlayback = false; this.scrubbing = false; this.loopsSelection = false; this.completed = undefined;
    this.state = empty(); this.changed(this.state);
  }
}
