import { expect, test } from 'bun:test';
import { CatalogPreviewPlayer, preparationProgress } from '../src/lib/catalog-preview';
import type { CatalogItem } from '@compound/backend/catalog';

const item: CatalogItem = { sourceId: 'one', kind: 'music', provider: 'youtube', title: 'Track', status: 'ready', durationUs: 10e6, inUserLibrary: false, inGlobalLibrary: false };
class FakeAudio {
  currentTime = 0; duration = 10; paused = true; src = ''; plays = 0;
  onloadedmetadata?: () => void; onplaying?: () => void; onpause?: () => void; onended?: () => void; ontimeupdate?: () => void; onerror?: () => void;
  load() {}
  removeAttribute() {}
  async play() { this.paused = false; this.plays++; }
  pause() { this.paused = true; this.onpause?.(); }
}
function fixture(prepare: () => Promise<CatalogItem> = async () => item) {
  const audio = new FakeAudio(); let files = 0;
  const player = new CatalogPreviewPlayer(() => {}, { load: async (_id, _progress, _signal, onMiss) => { onMiss(); const ready = await prepare(); files++; return { blob: new Blob(['audio']), media: { item: ready } }; }, audio: () => audio as unknown as HTMLAudioElement, beforePlay() {}, ready() {} });
  return { audio, player, files: () => files };
}
test('preparation remains visible through metadata and completes only when audio plays; resume reuses bytes', async () => {
  const { player, audio, files } = fixture();
  try {
    await player.prepare(item); expect(player.state.preparing).toBe(true);
    audio.onloadedmetadata?.(); expect(player.state.preparing).toBe(true);
    audio.onplaying?.(); expect(player.state.preparing).toBe(false); expect(player.state.progress).toBe(1);
    player.toggle(); expect(audio.paused).toBe(true);
    player.toggle(); expect(audio.plays).toBe(2); expect(files()).toBe(1);
  } finally { player.stop(); }
});
test('closing ignores a late shared download and prevents stale autoplay', async () => {
  let finish!: (item: CatalogItem) => void;
  const { player, audio, files } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const loading = player.prepare(item); player.stop(); finish(item); await loading;
  expect(files()).toBe(1); expect(audio.plays).toBe(0); expect(player.state.sourceId).toBe('');
});
test('trim auditions from the selected start, loops only while trimming, and scrubbing preserves pause intent', async () => {
  const { player, audio } = fixture();
  try {
    await player.prepare(item); audio.onloadedmetadata?.(); audio.onplaying?.();
    player.setSelection({ sourceStartUs: 2e6, sourceEndUs: 3e6 }); expect(audio.currentTime).toBe(2);
    player.loopsSelection = true; audio.currentTime = 3; audio.ontimeupdate?.(); expect(audio.currentTime).toBe(2);
    player.pause(); player.scrub(true); player.seek(2.5); player.scrub(false); expect(audio.paused).toBe(true);
    player.toggle(); player.loopsSelection = false; audio.currentTime = 3; audio.ontimeupdate?.(); expect(audio.paused).toBe(true);
    player.toggle(); expect(audio.currentTime).toBe(2);
    player.setSelection({ sourceStartUs: -1, sourceEndUs: 11e6 }); expect(player.selectionStart).toBe(2);
  } finally { player.stop(); }
});
test('preparation errors clear loading and a retry starts a fresh request', async () => {
  let attempts = 0;
  const { player } = fixture(async () => { if (++attempts === 1) throw new Error('Catalog download service is unavailable.'); return item; });
  try {
    await player.prepare(item); expect(player.state.error).toContain('unavailable'); expect(player.state.preparing).toBe(false); expect(player.state.progress).toBeUndefined();
    await player.prepare(item); expect(attempts).toBe(2); expect(player.state.error).toBe('');
  } finally { player.stop(); }
});
test('PostBob loading estimate never claims completion before playback readiness', () => {
  expect(preparationProgress(0, 'music')).toBe(0);
  expect(preparationProgress(40, 'music')).toBeCloseTo(0.8);
  expect(preparationProgress(4, 'sfx')).toBeCloseTo(0.8);
  expect(preparationProgress(600, 'music')).toBeLessThan(0.98);
});
