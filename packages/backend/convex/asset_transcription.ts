'use node';

import { v } from 'convex/values';
import { z } from 'zod';
import { ModalClient } from 'modal';
import {
  MAX_AUDIO_BYTES,
  MODAL_ALIGNER_APP,
} from '@compound/config/transcription';
import { internal } from './_generated/api';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import {
  buildWavBase64,
  gapsBetweenProviderWords,
  pcmByteRange,
  readPcmWavMetadata,
  splitAtGaps,
  type PcmWavMetadata,
  type DeepgramTranscript,
} from '../lib/transcription/audio';
import {
  alignmentSeam,
  applyProviderTimingToPlacedWords,
  buildAlignmentBatches,
  mergeAlignmentBatches,
  validateForcedAlignment,
  type ForcedAlignmentResult,
  type AlignmentRequestSegment,
} from '../lib/transcription/forced-alignment';
import {
  mergeSeamVerbatim,
  type SeamEdit,
  type SeamRejection,
} from '../lib/transcription/seam-merge';
import { captionSegments } from '../lib/transcription/captions';
import { deepgram, geminiVerbatim } from '../lib/transcription/providers';
import {
  head,
  readArtifact,
  readRange,
  requireEnv,
  signedAudioUrl,
  writeArtifact,
} from '../lib/transcription/storage';
import type { TimedTranscriptEntry } from '../lib/transcription/types';

const args = { jobId: v.id('transcriptionJobs'), attempt: v.number() };
const batchArgs = { ...args, index: v.number() };
type JobArgs = { jobId: Id<'transcriptionJobs'>; attempt: number };
type BatchArgs = JobArgs & { index: number };
type Source = {
  raw: DeepgramTranscript;
  metadata: PcmWavMetadata;
  pieces: { startUs: number; endUs: number }[];
  enhance: boolean;
};
type Merged = {
  words: TimedTranscriptEntry[];
  edits: SeamEdit[];
  rejections: SeamRejection[];
  batches: ReturnType<typeof buildAlignmentBatches>;
};
const alignmentSchema = z.object({
  durationUs: z.number(),
  model: z.string(),
  meanScore: z.number(),
  seamRepairCount: z.number(),
  words: z.array(
    z.object({
      text: z.string(),
      startUs: z.number(),
      endUs: z.number(),
      normalized: z.string(),
      score: z.number(),
    }),
  ),
});

async function context(ctx: ActionCtx, input: JobArgs, stage?: string) {
  const ids = { jobId: input.jobId, attempt: input.attempt };
  const value = await ctx.runQuery(internal.transcriptions.context, ids);
  if (stage)
    await ctx.runMutation(internal.transcriptions.progress, { ...ids, stage });
  return { ...value, prefix: `media/transcripts/${input.jobId}/` };
}
async function load<T>(prefix: string, name: string): Promise<T> {
  const value = await readArtifact<T>(prefix + name + '.json');
  if (value === null) throw new Error(`Missing transcription stage: ${name}`);
  return value;
}
async function save(
  ctx: ActionCtx,
  input: JobArgs,
  prefix: string,
  name: string,
  value: unknown,
) {
  await context(ctx, input);
  await writeArtifact(prefix + name + '.json', value);
}
function indexOf<T>(values: T[], index: number): T {
  if (!Number.isSafeInteger(index) || index < 0 || index >= values.length)
    throw new Error('Invalid transcription batch');
  return values[index];
}

export const prepare = internalAction({
  args,
  handler: async (
    ctx,
    input,
  ): Promise<{ pieces: number; enhance: boolean }> => {
    const { prefix, upload, job } = await context(ctx, input, 'transcribing');
    let source = await readArtifact<Source>(prefix + 'source.json');
    if (!source) {
      const object = await head(upload.key);
      if (
        object.size !== upload.size ||
        object.size > MAX_AUDIO_BYTES ||
        object.contentType !== 'audio/wav'
      )
        throw new Error('Uploaded audio does not match its declared size/type');
      const metadata = await readPcmWavMetadata((offset, length) => {
        if (offset + length > object.size)
          throw new Error('WAV header exceeds audio size');
        return readRange(upload.key, offset, length);
      });
      if (
        !metadata.dataLength ||
        metadata.dataOffset + metadata.dataLength > object.size
      )
        throw new Error('WAV audio is empty or truncated');
      const raw = await deepgram(
        await signedAudioUrl(upload.key),
        requireEnv('DEEPGRAM_API_KEY'),
        job.language,
      );
      // Clamp provider rounding to the real sample duration. Invalid ordering is
      // left to alignment validation rather than manufacturing precise timing.
      raw.words = raw.words.map((w) => ({
        ...w,
        startUs: Math.min(w.startUs, metadata.durationUs),
        endUs: Math.min(w.endUs, metadata.durationUs),
      }));
      const language = job.language ?? raw.language;
      const enhance =
        raw.words.length > 0 && !!language && /^en(?:-|$)/i.test(language);
      source = {
        raw,
        metadata,
        enhance,
        pieces: splitAtGaps(
          metadata.durationUs,
          gapsBetweenProviderWords(raw.words, metadata.durationUs),
        ),
      };
      await save(ctx, input, prefix, 'source', source);
    }
    return { pieces: source.pieces.length, enhance: source.enhance };
  },
});

export const correctPiece = internalAction({
  args: batchArgs,
  handler: async (ctx, input): Promise<null> => {
    const { prefix, upload } = await context(ctx, input, 'correcting');
    const name = `gemini-${input.index}`;
    if ((await readArtifact(prefix + name + '.json')) !== null) return null;
    const source = await load<Source>(prefix, 'source');
    const piece = indexOf(source.pieces, input.index);
    const range = pcmByteRange(source.metadata, piece.startUs, piece.endUs);
    const pcm = await readRange(upload.key, range.offset, range.length);
    const verbatim = await geminiVerbatim(
      buildWavBase64(pcm, 0, piece.endUs - piece.startUs),
      requireEnv('GOOGLE_GENERATIVE_AI_API_KEY'),
    );
    await save(ctx, input, prefix, name, { verbatim });
    return null;
  },
});

export const mergeWords = internalAction({
  args,
  handler: async (ctx, input): Promise<number> => {
    const { prefix } = await context(ctx, input, 'correcting');
    let merged = await readArtifact<Merged>(prefix + 'merged.json');
    if (!merged) {
      const source = await load<Source>(prefix, 'source');
      const words = source.raw.words.map((w) => ({ ...w }));
      const edits: SeamEdit[] = [],
        rejections: SeamRejection[] = [];
      const silences = gapsBetweenProviderWords(
        source.raw.words,
        source.metadata.durationUs,
      );
      for (const [index, piece] of source.pieces.entries()) {
        const { verbatim } = await load<{ verbatim: string }>(
          prefix,
          `gemini-${index}`,
        );
        const result = mergeSeamVerbatim({
          rangeStartUs: piece.startUs,
          rangeEndUs: piece.endUs,
          rawWords: source.raw.words,
          words,
          silences,
          verbatim,
        });
        edits.push(...result.edits);
        rejections.push(...result.rejections);
      }
      merged = {
        words,
        edits,
        rejections,
        batches: buildAlignmentBatches(words, source.metadata.durationUs),
      };
      await save(ctx, input, prefix, 'merged', merged);
    }
    return merged.batches.length;
  },
});

async function align(
  audioKey: string,
  metadata: PcmWavMetadata,
  segments: AlignmentRequestSegment[],
  words: TimedTranscriptEntry[],
): Promise<ForcedAlignmentResult> {
  const environment = requireEnv('STAGE');
  const modal = new ModalClient({
    environment,
    tokenId: requireEnv('MODAL_TOKEN_ID'),
    tokenSecret: requireEnv('MODAL_TOKEN_SECRET'),
    timeoutMs: 330000,
    maxRetries: 1,
  });
  try {
    const cls = await modal.cls.fromName(MODAL_ALIGNER_APP, 'Wav2VecAligner', {
      environment,
    });
    const instance = await cls.instance();
    const raw: unknown = await instance
      .method('align')
      .remote([await signedAudioUrl(audioKey), segments, metadata]);
    const result = alignmentSchema.parse(raw);
    if (result.durationUs !== metadata.durationUs)
      throw new Error('Alignment changed audio duration');
    validateForcedAlignment(result, words);
    return applyProviderTimingToPlacedWords(result, words);
  } finally {
    modal.close();
  }
}
export const alignBatch = internalAction({
  args: batchArgs,
  handler: async (ctx, input: BatchArgs): Promise<null> => {
    const { prefix, upload } = await context(ctx, input, 'aligning');
    const name = `alignment-${input.index}`;
    if ((await readArtifact(prefix + name + '.json')) !== null) return null;
    const source = await load<Source>(prefix, 'source');
    const merged = await load<Merged>(prefix, 'merged');
    const batch = indexOf(merged.batches, input.index);
    await save(
      ctx,
      input,
      prefix,
      name,
      await align(upload.key, source.metadata, batch.segments, batch.words),
    );
    return null;
  },
});
export const joinBatch = internalAction({
  args: batchArgs,
  handler: async (ctx, input): Promise<null> => {
    const { prefix, upload } = await context(ctx, input, 'aligning');
    const name = `joined-${input.index}`;
    if ((await readArtifact(prefix + name + '.json')) !== null) return null;
    let result = await load<ForcedAlignmentResult>(
      prefix,
      `alignment-${input.index}`,
    );
    if (input.index > 0) {
      const left = await load<ForcedAlignmentResult>(
        prefix,
        `joined-${input.index - 1}`,
      );
      const seam = alignmentSeam(left, result);
      const source = await load<Source>(prefix, 'source');
      const repair = seam
        ? await align(upload.key, source.metadata, [seam.segment], seam.words)
        : undefined;
      result = mergeAlignmentBatches(left, result, repair);
    }
    await save(ctx, input, prefix, name, result);
    return null;
  },
});

export const finish = internalAction({
  args,
  handler: async (ctx, input): Promise<null> => {
    const { prefix } = await context(ctx, input, 'finishing');
    const source = await load<Source>(prefix, 'source');
    let words = source.raw.words;
    let quality = words.length ? 'deepgram-language-fallback' : 'no-speech';
    if (source.enhance) {
      const merged = await load<Merged>(prefix, 'merged');
      const result = await load<ForcedAlignmentResult>(
        prefix,
        `joined-${merged.batches.length - 1}`,
      );
      validateForcedAlignment(result, merged.words);
      words = result.words;
      quality = result.words.some((w) => !w.normalized)
        ? 'aligned-with-placed-words'
        : 'aligned';
    }
    await save(ctx, input, prefix, 'result', captionSegments(words));
    await ctx.runMutation(internal.transcriptions.progress, {
      ...input,
      stage: 'ready',
      resultKey: prefix + 'result.json',
      quality,
    });
    return null;
  },
});
