import type { TimedTranscriptEntry } from './types';

export const MAX_ALIGNMENT_SEGMENT_US = 150_000_000;
const MAX_ALIGNMENT_CONTEXT_US = 2_000_000;
const SEGMENT_TEXT_GAP_US = 650_000;

export interface AlignmentRequestSegment {
  endUs: number;
  startUs: number;
  words: string[];
}

export interface ForcedAlignedWord extends TimedTranscriptEntry {
  normalized: string;
  score: number;
}

export interface ForcedAlignmentResult {
  durationUs: number;
  meanScore: number;
  model: string;
  seamRepairCount: number;
  words: ForcedAlignedWord[];
}

export function buildAlignmentSegments(
  words: TimedTranscriptEntry[],
  durationUs: number,
  maxSegmentUs = MAX_ALIGNMENT_SEGMENT_US,
): AlignmentRequestSegment[] {
  if (words.length === 0) {
    return [];
  }
  if (durationUs <= 0) {
    throw new Error('Audio duration must be positive for forced alignment.');
  }
  if (durationUs <= maxSegmentUs) {
    return [{ endUs: durationUs, startUs: 0, words: words.map(wordText) }];
  }

  // Provider timings are rough, but they are sufficient for placing a
  // bounded context window around each group. Do not cover long leading,
  // trailing, or internal silence: doing so can create a segment longer than
  // Modal's limit even though the actual speech is short.
  const contextUs = Math.min(
    MAX_ALIGNMENT_CONTEXT_US,
    Math.max(1, Math.floor(maxSegmentUs / 10)),
  );
  const segments: AlignmentRequestSegment[] = [];
  let firstWordIndex = 0;
  while (firstWordIndex < words.length) {
    const firstWord = words[firstWordIndex];
    if (!firstWord) {
      throw new Error('Unable to locate the next transcript word.');
    }
    const segmentStartUs = Math.max(0, firstWord.startUs - contextUs);
    const segmentLimitUs = Math.min(durationUs, segmentStartUs + maxSegmentUs);
    let nextWordIndex = firstWordIndex;
    if (segmentLimitUs === durationUs) {
      // This is the final possible window. Include every remaining word even
      // when its requested trailing context extends past the media boundary.
      // Requiring the full context here strands each word near the end in a
      // separate, heavily overlapping segment; independently aligning those
      // one-word segments can assign several words to the same sound and make
      // the combined result overlap.
      nextWordIndex = words.length;
    } else {
      while (
        nextWordIndex < words.length &&
        (words[nextWordIndex]?.endUs ?? durationUs) + contextUs <=
          segmentLimitUs
      ) {
        nextWordIndex += 1;
      }
    }
    if (nextWordIndex === firstWordIndex) {
      // A single provider range can be malformed, but it must not cause an
      // infinite loop. Include that word and let forced alignment decide
      // whether the bounded acoustic window is viable.
      nextWordIndex += 1;
    }
    const lastWord = words[nextWordIndex - 1];
    if (!lastWord) {
      throw new Error(
        'Unable to locate the final word in an alignment segment.',
      );
    }
    const segmentEndUs = Math.min(
      durationUs,
      segmentLimitUs,
      Math.max(segmentStartUs + 1, lastWord.endUs + contextUs),
    );
    segments.push({
      endUs: segmentEndUs,
      startUs: segmentStartUs,
      words: words.slice(firstWordIndex, nextWordIndex).map(wordText),
    });
    firstWordIndex = nextWordIndex;
  }
  return segments;
}

export function validateForcedAlignment(
  result: ForcedAlignmentResult,
  expectedWords: TimedTranscriptEntry[],
): void {
  if (!Number.isFinite(result.durationUs) || result.durationUs <= 0) {
    throw new Error('Forced alignment returned an invalid audio duration.');
  }
  if (result.words.length !== expectedWords.length) {
    throw new Error(
      `Forced alignment returned ${result.words.length} words for ${expectedWords.length} transcript words.`,
    );
  }
  let previousEndUs = -1;
  for (const [index, word] of result.words.entries()) {
    const expected = expectedWords[index];
    if (!expected || word.text !== expected.text) {
      throw new Error(`Forced alignment changed transcript word ${index}.`);
    }
    if (
      !(
        Number.isFinite(word.startUs) &&
        Number.isFinite(word.endUs) &&
        Number.isFinite(word.score)
      ) ||
      word.startUs < 0 ||
      word.endUs > result.durationUs ||
      word.endUs <= word.startUs
    ) {
      throw new Error(
        `Forced alignment returned an invalid range at word ${index}.`,
      );
    }
    if (word.startUs < previousEndUs) {
      throw new Error(`Forced alignment returned overlapping word ${index}.`);
    }
    previousEndUs = word.endUs;
  }
}

// Modal returns an empty `normalized` for a word CTC could not target (an
// emoji, bare punctuation, or anything the normalizer left without letters)
// and places it in the audio its aligned neighbors left free. Those neighbor
// bounds are trustworthy; where they leave room, the provider's own timing
// for the word is a better guess than an even spread across the gap.
export function isPlacedWord(word: ForcedAlignedWord): boolean {
  return word.normalized.length === 0;
}

export function applyProviderTimingToPlacedWords(
  result: ForcedAlignmentResult,
  providerWords: TimedTranscriptEntry[],
): ForcedAlignmentResult {
  if (!result.words.some(isPlacedWord)) {
    return result;
  }
  const words = result.words.map((word, index) => {
    const provider = providerWords[index];
    if (
      !(isPlacedWord(word) && provider) ||
      provider.text !== word.text ||
      provider.startUs < word.startUs ||
      provider.endUs > word.endUs ||
      provider.endUs <= provider.startUs
    ) {
      return word;
    }
    return { ...word, endUs: provider.endUs, startUs: provider.startUs };
  });
  return { ...result, words };
}

export function buildSegmentsFromAlignedWords(
  words: TimedTranscriptEntry[],
): TimedTranscriptEntry[] {
  if (words.length === 0) {
    return [];
  }
  const segments: TimedTranscriptEntry[] = [];
  let groupStartIndex = 0;
  for (let index = 1; index <= words.length; index += 1) {
    const previous = words[index - 1];
    const current = words[index];
    const reachedBoundary =
      index === words.length ||
      Boolean(
        previous &&
        current &&
        current.startUs - previous.endUs >= SEGMENT_TEXT_GAP_US,
      );
    if (!reachedBoundary) {
      continue;
    }
    const group = words.slice(groupStartIndex, index);
    const first = group[0];
    const last = group.at(-1);
    if (first && last) {
      segments.push({
        endUs: last.endUs,
        startUs: first.startUs,
        text: group.map(wordText).join(' '),
      });
    }
    groupStartIndex = index;
  }
  return segments;
}

const wordText = (word: TimedTranscriptEntry): string => word.text;

// At most five minutes of audio per Modal invocation. Each invocation is a
// durable workflow step, so its 300-second timeout never covers a whole film.
export function buildAlignmentBatches(
  words: TimedTranscriptEntry[],
  durationUs: number,
): Array<{
  segments: AlignmentRequestSegment[];
  words: TimedTranscriptEntry[];
}> {
  const segments = buildAlignmentSegments(words, durationUs);
  const batches: Array<{
    segments: AlignmentRequestSegment[];
    words: TimedTranscriptEntry[];
  }> = [];
  let offset = 0;
  for (let index = 0; index < segments.length; index += 2) {
    const batch = segments.slice(index, index + 2);
    const count = batch.reduce((sum, segment) => sum + segment.words.length, 0);
    batches.push({
      segments: batch,
      words: words.slice(offset, offset + count),
    });
    offset += count;
  }
  return batches;
}

export function alignmentSeam(
  left: ForcedAlignmentResult,
  right: ForcedAlignmentResult,
): {
  leftCount: number;
  rightCount: number;
  segment: AlignmentRequestSegment;
  words: ForcedAlignedWord[];
} | null {
  const last = left.words.at(-1);
  const first = right.words[0];
  if (!(last && first) || first.startUs >= last.endUs) {
    return null;
  }
  const leftCount = Math.min(8, left.words.length);
  const rightCount = Math.min(8, right.words.length);
  const words = [
    ...left.words.slice(-leftCount),
    ...right.words.slice(0, rightCount),
  ];
  const startUs = Math.max(
    0,
    left.words.at(-leftCount - 1)?.endUs ?? 0,
    (words[0]?.startUs ?? 0) - 1_000_000,
  );
  const endUs = Math.min(
    left.durationUs,
    right.words[rightCount]?.startUs ?? right.durationUs,
    (words.at(-1)?.endUs ?? right.durationUs) + 1_000_000,
  );
  if (endUs <= startUs || endUs - startUs > MAX_ALIGNMENT_SEGMENT_US) {
    throw new Error('Alignment seam has no bounded acoustic window.');
  }
  return {
    leftCount,
    rightCount,
    segment: { startUs, endUs, words: words.map(wordText) },
    words,
  };
}

export function mergeAlignmentBatches(
  left: ForcedAlignmentResult,
  right: ForcedAlignmentResult,
  repair?: ForcedAlignmentResult,
): ForcedAlignmentResult {
  if (left.durationUs !== right.durationUs || left.model !== right.model) {
    throw new Error('Alignment batches disagree on audio duration or model.');
  }
  const seam = alignmentSeam(left, right);
  let words = [...left.words, ...right.words];
  if (seam) {
    if (!repair) {
      throw new Error(
        'Overlapping alignment batches require acoustic seam repair.',
      );
    }
    validateForcedAlignment(repair, seam.words);
    if (
      repair.durationUs !== left.durationUs ||
      repair.model !== left.model ||
      (repair.words[0]?.startUs ?? -1) < seam.segment.startUs ||
      (repair.words.at(-1)?.endUs ?? Number.POSITIVE_INFINITY) >
        seam.segment.endUs
    ) {
      throw new Error('Alignment seam repair crossed its untouched neighbors.');
    }
    words = [
      ...left.words.slice(0, left.words.length - seam.leftCount),
      ...repair.words,
      ...right.words.slice(seam.rightCount),
    ];
  }
  const scored = words.filter((word) => !isPlacedWord(word));
  const result = {
    durationUs: left.durationUs,
    meanScore: scored.length
      ? scored.reduce((sum, word) => sum + word.score, 0) / scored.length
      : 0,
    model: left.model,
    seamRepairCount:
      left.seamRepairCount + right.seamRepairCount + (seam ? 1 : 0),
    words,
  };
  validateForcedAlignment(result, [...left.words, ...right.words]);
  return result;
}
