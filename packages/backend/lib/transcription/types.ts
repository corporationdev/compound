export interface TimedTranscriptEntry {
  text: string;
  startUs: number;
  endUs: number;
}
export interface SilenceInterval {
  startUs: number;
  endUs: number;
}
export type TranscriptSegment = {
  text: string;
  words: { text: string; start: number; end: number }[];
};
