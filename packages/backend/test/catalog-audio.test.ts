import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseYouTubeAudio } from "../convex/catalog_providers/youtube";

// Generated 0.2-second sine-wave fixtures, not downloaded music.
async function fixture(name: string): Promise<Uint8Array> {
  return await readFile(new URL(`./fixtures/${name}`, import.meta.url));
}

test("YouTube AAC with DASH/ISO brands is accepted without the M4A brand", async () => {
  const bytes = await fixture("youtube-aac-dash.m4a");
  expect(new TextDecoder().decode(bytes.subarray(8, 28))).not.toContain("M4A");
  const media = await parseYouTubeAudio(bytes);
  expect(media.mimeType).toBe("audio/mp4");
  expect(media.extension).toBe("m4a");
  expect(media.durationUs).toBeGreaterThan(0);
  expect(media.durationUs).toBeLessThan(1_000_000);
  expect(media.bytes).toBe(bytes);
});

test("traditional M4A-branded AAC is also accepted", async () => {
  const bytes = await fixture("youtube-aac-dash.m4a");
  bytes.set(new TextEncoder().encode("M4A "), 8);
  expect((await parseYouTubeAudio(bytes)).mediaKind).toBe("audio");
});

test("audio with a video stream is not accepted as an audio-only download", async () => {
  await expect(
    parseYouTubeAudio(await fixture("audio-with-video.mp4"))
  ).rejects.toThrow("audio-only");
});

test("HTML and truncated downloads are rejected", async () => {
  await expect(
    parseYouTubeAudio(new TextEncoder().encode("<html>upstream error</html>"))
  ).rejects.toThrow();
  await expect(
    parseYouTubeAudio((await fixture("youtube-aac-dash.m4a")).subarray(0, 28))
  ).rejects.toThrow();
});

test("an M4A brand without an AAC stream is not sufficient", async () => {
  const bytes = await fixture("youtube-aac-dash.m4a");
  const offset = Buffer.from(bytes).indexOf("mp4a");
  expect(offset).toBeGreaterThan(0);
  bytes.set(new TextEncoder().encode("xxxx"), offset);
  await expect(parseYouTubeAudio(bytes)).rejects.toThrow("audio-only");
});

test('downloader validates saved audio bytes and rejects successful runs without a matching file', async () => {
  const { prepareDownloadedMedia } = await import('../convex/catalog_providers/youtube');
  const { spyOn } = await import('bun:test');
  const bytes = await fixture('youtube-aac-dash.m4a');
  const previous = process.env.APIFY_TOKEN; process.env.APIFY_TOKEN = 'test-token';
  const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array(bytes)));
  try {
    const media = await prepareDownloadedMedia([{ id: 'testvideo01', downloadedFileUrl: 'https://api.apify.com/v2/key-value-stores/store/records/track.m4a' }], 'testvideo01');
    expect(media.mimeType).toBe('audio/mp4');
    await expect(prepareDownloadedMedia([{ id: 'different', downloadedFileUrl: 'https://api.apify.com/v2/key-value-stores/store/records/track.m4a' }], 'testvideo01')).rejects.toThrow('matching');
    await expect(prepareDownloadedMedia([{ id: 'testvideo01', error: 'blocked' }], 'testvideo01')).rejects.toThrow('no audio');
    await expect(prepareDownloadedMedia([{ id: 'testvideo01', downloadedFileUrl: 'https://attacker.example/v2/key-value-stores/store/records/track.m4a' }], 'testvideo01')).rejects.toThrow('unsupported URL');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally { fetchSpy.mockRestore(); if (previous === undefined) delete process.env.APIFY_TOKEN; else process.env.APIFY_TOKEN = previous; }
});
