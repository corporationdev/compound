import type { TimedTranscriptEntry, SilenceInterval } from './types';
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const MIN_PROVIDER_GAP_US = 40000;
export const MAX_TRANSCRIPT_PIECE_US = 180000000;
const VERBATIM_FIELD = /"verbatim"\s*:\s*"((?:[^"\\]|\\.)*)/;

export interface DeepgramResponse {
  metadata?: { duration?: number; language?: string };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{
        transcript?: string;
        words?: Array<{
          end: number;
          punctuated_word?: string;
          start: number;
          word?: string;
        }>;
      }>;
    }>;
    utterances?: Array<{ end: number; start: number; transcript: string }>;
  };
}

export interface DeepgramTranscript {
  language?: string;
  segments: TimedTranscriptEntry[];
  words: TimedTranscriptEntry[];
}


export function extractWavPcm(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...wav.subarray(offset, offset + length));
  if (wav.length < 12 || ascii(0, 4) !== 'RIFF') {
    throw new Error('Audio is not a RIFF WAV file.');
  }
  let offset = 12;
  let format: {
    bitsPerSample: number;
    channels: number;
    formatTag: number;
    isPcm: boolean;
    sampleRate: number;
  } | null = null;
  while (offset + 8 <= wav.length) {
    const chunkId = ascii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      const formatTag = view.getUint16(body, true);
      format = {
        bitsPerSample: view.getUint16(body + 14, true),
        channels: view.getUint16(body + 2, true),
        formatTag,
        // WAVE_FORMAT_EXTENSIBLE (0xfffe) carries the real format code in
        // the first two bytes of the SubFormat GUID; AVFoundation writes
        // 16-bit PCM this way, so a 40-byte extensible fmt chunk whose
        // SubFormat says PCM is the same contract.
        isPcm:
          formatTag === 1 ||
          (formatTag === 0xff_fe &&
            chunkSize >= 40 &&
            body + 26 <= wav.length &&
            view.getUint16(body + 24, true) === 1),
        sampleRate: view.getUint32(body + 4, true),
      };
    } else if (chunkId === 'data') {
      if (!format) {
        throw new Error('WAV data chunk appeared before fmt.');
      }
      if (
        !format.isPcm ||
        format.channels !== 1 ||
        format.sampleRate !== SAMPLE_RATE ||
        format.bitsPerSample !== 16
      ) {
        throw new Error(
          `Audio must be 16kHz mono 16-bit PCM (got tag ${format.formatTag}, ${format.channels}ch, ${format.sampleRate}Hz, ${format.bitsPerSample}bit).`,
        );
      }
      const end = Math.min(body + chunkSize, wav.length);
      return wav.subarray(body, end);
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  throw new Error('WAV file has no data chunk.');
}

export function pcmDurationUs(pcm: Uint8Array): number {
  // Keep requested media ranges inside the sample-backed duration. JavaScript
  // rounds half values up, while Python rounds ties to even; using Math.round
  // here could therefore make a segment one microsecond longer than the same
  // WAV reports to the Python aligner.
  return Math.floor((pcm.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1_000_000);
}

export function gapsBetweenProviderWords(
  words: TimedTranscriptEntry[],
  durationUs: number,
): SilenceInterval[] {
  if (words.length === 0) {
    return [];
  }
  const gaps: SilenceInterval[] = [];
  const first = words[0];
  if (first && first.startUs >= MIN_PROVIDER_GAP_US) {
    gaps.push({ endUs: first.startUs, startUs: 0 });
  }
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const current = words[index];
    if (
      previous &&
      current &&
      current.startUs - previous.endUs >= MIN_PROVIDER_GAP_US
    ) {
      gaps.push({ endUs: current.startUs, startUs: previous.endUs });
    }
  }
  const last = words.at(-1);
  if (last && durationUs - last.endUs >= MIN_PROVIDER_GAP_US) {
    gaps.push({ endUs: durationUs, startUs: last.endUs });
  }
  return gaps;
}


export function parseDeepgramResponse(
  response: DeepgramResponse,
): DeepgramTranscript {
  const channel = response.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  const words: TimedTranscriptEntry[] =
    alternative?.words?.map((word) => ({
      endUs: secondsToMicroseconds(word.end),
      startUs: secondsToMicroseconds(word.start),
      text: word.punctuated_word ?? word.word ?? '',
    })) ?? [];
  const lastWord = words.at(-1);
  const segments: TimedTranscriptEntry[] =
    response.results?.utterances?.map((utterance) => ({
      endUs: secondsToMicroseconds(utterance.end),
      startUs: secondsToMicroseconds(utterance.start),
      text: utterance.transcript,
    })) ??
    (alternative?.transcript
      ? [
          {
            endUs: lastWord?.endUs ?? 0,
            startUs: words[0]?.startUs ?? 0,
            text: alternative.transcript,
          },
        ]
      : []);
  return {
    ...((channel?.detected_language ?? response.metadata?.language)
      ? { language: channel?.detected_language ?? response.metadata?.language }
      : {}),
    segments,
    words,
  };
}

function secondsToMicroseconds(seconds: number): number {
  return Math.round(seconds * 1_000_000);
}

export function splitAtGaps(
  durationUs: number,
  silences: SilenceInterval[],
  maxPieceUs = MAX_TRANSCRIPT_PIECE_US,
): Array<{ endUs: number; startUs: number }> {
  if (!(
    Number.isFinite(durationUs) &&
    durationUs >= 0 &&
    Number.isFinite(maxPieceUs) &&
    maxPieceUs >= 1
  )) {
    throw new Error('Invalid transcript chunk duration.');
  }
  const pieces = [{ endUs: durationUs, startUs: 0 }];
  const byWidth = [...silences].sort(
    (a, b) => b.endUs - b.startUs - (a.endUs - a.startUs),
  );
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index] as { endUs: number; startUs: number };
    if (piece.endUs - piece.startUs <= maxPieceUs) {
      continue;
    }
    const cut = byWidth.find(
      (gap) =>
        gap.startUs > piece.startUs + maxPieceUs / 4 &&
        gap.endUs < piece.endUs - maxPieceUs / 4 &&
        Math.round((gap.startUs + gap.endUs) / 2) - piece.startUs <= maxPieceUs,
    );
    // Continuous speech and long silence still have to respect the hard cap.
    const at = cut
      ? Math.round((cut.startUs + cut.endUs) / 2)
      : piece.startUs + maxPieceUs;
    pieces.splice(
      index,
      1,
      { endUs: at, startUs: piece.startUs },
      { endUs: piece.endUs, startUs: at },
    );
    index -= 1;
  }
  return pieces;
}

// Cuts [startUs, endUs) out of the PCM and wraps it in a minimal WAV header.
export function buildWavBase64(
  pcm: Uint8Array,
  startUs: number,
  endUs: number,
): string {
  const startByte = clampSampleByte(pcm.length, startUs);
  const endByte = clampSampleByte(pcm.length, endUs);
  const data = pcm.subarray(startByte, Math.max(startByte, endByte));
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  writeAscii(header, 0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  writeAscii(header, 8, 'WAVE');
  writeAscii(header, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(header, 36, 'data');
  view.setUint32(40, data.length, true);
  const wav = new Uint8Array(header.length + data.length);
  wav.set(header, 0);
  wav.set(data, header.length);
  return bytesToBase64(wav);
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    target[offset + i] = text.charCodeAt(i);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).toString('base64');
  }
  let binary = '';
  const chunk = 0x80_00;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function clampSampleByte(pcmLength: number, timeUs: number): number {
  const sample = Math.round((timeUs / 1_000_000) * SAMPLE_RATE);
  const byte = sample * BYTES_PER_SAMPLE;
  return Math.min(Math.max(0, byte), pcmLength - (pcmLength % 2));
}

export function parseVerbatim(text: string): string {
  for (const candidate of [text, `${text}}`, `${text}"}`]) {
    try {
      const parsed = JSON.parse(candidate) as { verbatim?: unknown };
      return typeof parsed.verbatim === 'string' ? parsed.verbatim : '';
    } catch {
      // try the next repair
    }
  }
  const match = VERBATIM_FIELD.exec(text);
  if (!match?.[1]) {
    return '';
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return '';
  }
}

export interface PcmWavMetadata {
  dataLength: number;
  dataOffset: number;
  durationUs: number;
}

// Read only RIFF headers, skipping arbitrary metadata/padding chunks. Each
// read is at most 40 bytes; the PCM is fetched separately by sample range.
export async function readPcmWavMetadata(
  read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<PcmWavMetadata> {
  const header = await read(0, 12);
  const ascii = (bytes: Uint8Array, offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  const viewOf = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(header, 0, 4) !== 'RIFF' || ascii(header, 8, 4) !== 'WAVE') {
    throw new Error('Audio proxy is not a RIFF WAV file.');
  }
  const fileEnd = viewOf(header).getUint32(4, true) + 8;
  let offset = 12;
  let validFormat = false;
  for (let chunks = 0; offset + 8 <= fileEnd && chunks < 1024; chunks += 1) {
    const chunk = await read(offset, 8);
    const id = ascii(chunk, 0, 4);
    const size = viewOf(chunk).getUint32(4, true);
    const body = offset + 8;
    if (body + size > fileEnd) {
      throw new Error('WAV chunk exceeds the declared file size.');
    }
    if (id === 'fmt ') {
      assertPcmWavFormat(await read(body, Math.min(size, 40)));
      validFormat = true;
    } else if (id === 'data') {
      if (!validFormat || size % 2 !== 0) {
        throw new Error('Invalid WAV PCM data chunk.');
      }
      return {
        dataOffset: body,
        dataLength: size,
        durationUs: Math.floor((size / 2 / SAMPLE_RATE) * 1_000_000),
      };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no supported data chunk.');
}

export function pcmByteRange(
  metadata: PcmWavMetadata,
  startUs: number,
  endUs: number,
): { offset: number; length: number } {
  if (
    !(Number.isFinite(startUs) && Number.isFinite(endUs)) ||
    startUs < 0 ||
    endUs <= startUs ||
    endUs > metadata.durationUs ||
    endUs - startUs > MAX_TRANSCRIPT_PIECE_US
  ) {
    throw new Error('Audio transcription range exceeds its bounds.');
  }
  const start = clampSampleByte(metadata.dataLength, startUs);
  const end = clampSampleByte(metadata.dataLength, endUs);
  return { offset: metadata.dataOffset + start, length: end - start };
}

function assertPcmWavFormat(bytes: Uint8Array): void {
  if (bytes.length < 16) {
    throw new Error('WAV format header is truncated.');
  }
  const format = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = format.getUint16(0, true);
  const pcm =
    tag === 1 ||
    (tag === 0xff_fe && bytes.length >= 40 && format.getUint16(24, true) === 1);
  if (!(
    pcm &&
    format.getUint16(2, true) === 1 &&
    format.getUint32(4, true) === SAMPLE_RATE &&
    format.getUint16(14, true) === 16
  )) {
    throw new Error('Audio proxy must be 16kHz mono 16-bit PCM.');
  }
}
