import { test, expect } from 'bun:test';
import {
  buildWavBase64,
  readPcmWavMetadata,
  pcmByteRange,
  splitAtGaps,
} from '../lib/transcription/audio';
import { captionSegments } from '../lib/transcription/captions';
import {
  buildAlignmentBatches,
  alignmentSeam,
  mergeAlignmentBatches,
  type ForcedAlignmentResult,
} from '../lib/transcription/forced-alignment';

test('canonical WAV headers, precise PCM ranges and hard chunk cap', async () => {
  const wav = Buffer.from(
    buildWavBase64(new Uint8Array(32000 * 2), 0, 2e6),
    'base64',
  );
  const read = async (offset: number, length: number) =>
    wav.subarray(offset, offset + length);
  const metadata = await readPcmWavMetadata(read);
  expect(metadata).toEqual({
    dataOffset: 44,
    dataLength: 64000,
    durationUs: 2e6,
  });
  expect(pcmByteRange(metadata, 1e6, 2e6)).toEqual({
    offset: 32044,
    length: 32000,
  });
  expect(() => pcmByteRange(metadata, 0, 3e6)).toThrow();
  wav.writeUInt32LE(24000, 24);
  await expect(readPcmWavMetadata(read)).rejects.toThrow('16kHz');
  const pieces = splitAtGaps(601e6, []);
  expect(pieces[0].startUs).toBe(0);
  expect(pieces.at(-1)!.endUs).toBe(601e6);
  expect(pieces.every((p) => p.endUs - p.startUs <= 180e6)).toBe(true);
});

test('aligned timestamps preserve the exact caption shape and sentence grouping', () => {
  expect(
    captionSegments([
      { text: 'Hello', startUs: 100000, endUs: 250000 },
      { text: 'world.', startUs: 300000, endUs: 650000 },
    ]),
  ).toEqual([
    {
      text: 'Hello world.',
      words: [
        { text: 'Hello', start: 0.1, end: 0.25 },
        { text: 'world.', start: 0.3, end: 0.65 },
      ],
    },
  ]);
  expect(captionSegments([])).toEqual([]);
  expect(
    captionSegments(
      Array.from({ length: 31 }, (_, i) => ({
        text: 'word',
        startUs: i * 1e6,
        endUs: i * 1e6 + 0.5e6,
      })),
    ).map((s) => s.words.length),
  ).toEqual([30, 1]);
});

test('alignment batches preserve every occurrence and require acoustic seam repair', () => {
  const words = Array.from({ length: 600 }, (_, i) => ({
    text: 'word',
    startUs: i * 1e6,
    endUs: i * 1e6 + 5e5,
  }));
  const batches = buildAlignmentBatches(words, 600e6);
  expect(batches.flatMap((b) => b.words)).toEqual(words);
  expect(
    batches.every(
      (b) =>
        b.segments.length <= 2 &&
        b.segments.every((s) => s.endUs - s.startUs <= 150e6),
    ),
  ).toBe(true);
  const left: ForcedAlignmentResult = {
    model: 'test',
    durationUs: 3e6,
    meanScore: 0.8,
    seamRepairCount: 0,
    words: [
      { text: 'one', normalized: 'ONE', score: 0.8, startUs: 0, endUs: 1.1e6 },
    ],
  };
  const right: ForcedAlignmentResult = {
    ...left,
    words: [
      { text: 'two', normalized: 'TWO', score: 0.8, startUs: 1e6, endUs: 2e6 },
    ],
  };
  expect(alignmentSeam(left, right)).toBeTruthy();
  expect(() => mergeAlignmentBatches(left, right)).toThrow('repair');
  const repair = {
    ...left,
    words: [
      { ...left.words[0], endUs: 1e6 },
      { ...right.words[0], startUs: 1.05e6 },
    ],
  };
  expect(mergeAlignmentBatches(left, right, repair).words).toEqual(
    repair.words,
  );
});
