import type { TimedTranscriptEntry, TranscriptSegment } from './types';
// Preserve Compound's sentence/30-word segmentation and public seconds-based
// JSON. Caption presets continue receiving exactly the same shape.
export function captionSegments(
  words: TimedTranscriptEntry[],
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment = { text: '', words: [] };
  for (const word of words) {
    current.words.push({
      text: word.text,
      start: word.startUs / 1e6,
      end: word.endUs / 1e6,
    });
    if (/[.!?]$/.test(word.text) || current.words.length >= 30) {
      current.text = current.words.map((w) => w.text).join(' ');
      segments.push(current);
      current = { text: '', words: [] };
    }
  }
  if (current.words.length) {
    current.text = current.words.map((w) => w.text).join(' ');
    segments.push(current);
  }
  return segments;
}
