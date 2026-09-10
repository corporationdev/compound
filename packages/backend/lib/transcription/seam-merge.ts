// Seam merge: repair ASR words using one verbatim transcript of the whole
// asset.
//
// Deepgram is reliable inside a take and unreliable around take boundaries:
// at aborted takes it drops the dangling word ("…my chest. So—" →
// "…my chest."), drops the restart's first word ("So the sky's" → "the
// sky's"), renders a cut-off as a whole word ("actua—" → "actually"), and
// sometimes merges two takes and drops a whole phrase. An audio model asked
// for a verbatim transcript — with no ASR text in the prompt — hears all of
// that, but it cannot time anything, rewrites names ("Postbob" → "postub"),
// drops profanity, and occasionally paraphrases a clean sentence.
//
// So its text is diffed against the ASR words and only two kinds of
// difference are taken (2026-08-23 sweep, 7 clips: insertions were right
// ~90% of the time, substitutions ~25%, deletions ~10%):
//   - INSERT: words the model heard where the ASR has none. Timed into the
//     audio the ASR skipped — the slot beside the nearest measured gap, or
//     between the two neighbouring words — never from a model timestamp.
//   - REWORD: the same word marked cut off ("actually" → "actua—"). Never a
//     different word.
// Everything else the model says differently is ignored.
//
// Retakes are repeated text, so an inserted phrase can often attach to
// either copy. Every equivalent position is tried and the one with the most
// untranscribed audio between its neighbours wins — that is where the
// dropped take actually is.

import type { SilenceInterval, TimedTranscriptEntry } from './types';

export interface SeamEdit {
  detail: string;
  kind: 'insert' | 'reword';
}

export interface SeamRejection {
  reason: string;
  text: string;
}

// Cap on words inserted at a measured gap. The longest legitimate insert
// observed was ten words: two consecutive aborted attempts Deepgram dropped
// together ("You should get an insane amount of dopami— You should");
// beyond this the model is transcribing something other than a seam.
export const SEAM_MAX_GAP_INSERT_WORDS = 12;

// Cap on words inserted between two words with no measured gap. Real cases
// are a stutter ("I I"), a dropped function word, or a restart the analysis
// did not separate; anything longer is a rewrite.
export const SEAM_MAX_INNER_INSERT_WORDS = 3;

// Below this, a slot is too small to carry an inserted word; a neighbouring
// word's span is split instead.
const MIN_SLOT_US = 60_000;

// A word touches a gap when its corrected edge sits on the gap edge.
const GAP_TOUCH_US = 20_000;

export interface SeamMergeResult {
  edits: SeamEdit[];
  rejections: SeamRejection[];
}

// Applies `verbatim` to `words` in place. Only words inside
// [rangeStartUs, rangeEndUs] take part (the verbatim covers that audio);
// callers that transcribe in one piece pass the whole duration.
export function mergeSeamVerbatim({
  rangeEndUs = Number.POSITIVE_INFINITY,
  rangeStartUs = 0,
  rawWords,
  silences,
  verbatim,
  words,
}: {
  rangeEndUs?: number;
  rangeStartUs?: number;
  rawWords: TimedTranscriptEntry[];
  silences: SilenceInterval[];
  verbatim: string;
  words: TimedTranscriptEntry[];
}): SeamMergeResult {
  const edits: SeamEdit[] = [];
  const rejections: SeamRejection[] = [];
  const model = tokenize(verbatim);
  const scope = words.filter(
    (word) => word.startUs >= rangeStartUs && word.endUs <= rangeEndUs,
  );
  if (model.length === 0 || scope.length === 0) {
    return { edits, rejections };
  }
  const asr = scope.map((word) => normalize(word.text));
  const matches = diff(
    asr,
    model.map((token) => token.norm),
    model.map((token) => token.cut),
  );

  // Rewords first: they do not move anything.
  for (const [asrIndex, modelIndex] of matches) {
    const token = model[modelIndex];
    const word = scope[asrIndex];
    if (!(token && word && token.cut) || normalize(word.text) === token.norm) {
      continue;
    }
    const before = word.text;
    word.text = token.raw;
    edits.push({
      detail: `reword "${before}" -> "${token.raw}"`,
      kind: 'reword',
    });
  }

  // Inserts: model tokens between two consecutive matched ASR words that are
  // also consecutive in the ASR (no ASR words skipped, i.e. not a
  // substitution). Collected first, applied last, so positions stay valid.
  const inserts: Array<{ after: number; tokens: string[] }> = [];
  let prevAsr = -1;
  let prevModel = -1;
  for (const [asrIndex, modelIndex] of [
    ...matches,
    [scope.length, model.length] as const,
  ]) {
    const tokens = model.slice(prevModel + 1, modelIndex).map((t) => t.raw);
    if (tokens.length > 0) {
      if (asrIndex === prevAsr + 1) {
        inserts.push({ after: prevAsr, tokens });
      } else {
        rejections.push({
          reason: 'substitution',
          text: `${scope
            .slice(prevAsr + 1, asrIndex)
            .map((w) => w.text)
            .join(' ')} -> ${tokens.join(' ')}`,
        });
      }
    }
    prevAsr = asrIndex;
    prevModel = modelIndex;
  }

  for (const insert of inserts.reverse()) {
    const placed = placeInsert({
      after: insert.after,
      asr,
      rawWords,
      scope,
      silences,
      tokens: insert.tokens,
      words,
    });
    if (placed.edit) {
      edits.push(placed.edit);
    } else if (placed.rejection) {
      rejections.push(placed.rejection);
    }
  }
  words.sort((a, b) => a.startUs - b.startUs);
  edits.reverse();
  return { edits, rejections };
}

interface Placement {
  after: number;
  gap?: SilenceInterval;
  slotUs: number;
  tokens: string[];
}

// Chooses where an insert goes among its equivalent positions, then times
// it into the audio there.
function placeInsert({
  after,
  asr,
  rawWords,
  scope,
  silences,
  tokens,
  words,
}: {
  after: number;
  asr: string[];
  rawWords: TimedTranscriptEntry[];
  scope: TimedTranscriptEntry[];
  silences: SilenceInterval[];
  tokens: string[];
  words: TimedTranscriptEntry[];
}): { edit?: SeamEdit; rejection?: SeamRejection } {
  const best = choosePlacement(after, tokens, asr, scope, silences, rawWords);
  if (!best) {
    return {};
  }
  const cap = best.gap
    ? SEAM_MAX_GAP_INSERT_WORDS
    : SEAM_MAX_INNER_INSERT_WORDS;
  if (best.tokens.length > cap) {
    return {
      rejection: {
        reason: `insert of ${best.tokens.length} words exceeds ${cap}`,
        text: best.tokens.join(' '),
      },
    };
  }
  const prev = scope[best.after];
  const next = scope[best.after + 1];
  const text = best.tokens.join(' ');
  if (best.gap) {
    insertAtGap(words, prev, next, best.tokens, best.gap, rawWords);
    return {
      edit: {
        detail: `insert "${text}" at gap @${best.gap.startUs}`,
        kind: 'insert',
      },
    };
  }
  insertInner(words, prev, next, best.tokens, rawWords);
  return {
    edit: {
      detail: `insert "${text}" @${prev?.endUs ?? next?.startUs}`,
      kind: 'insert',
    },
  };
}

// The equivalent position with the most untranscribed audio between its
// neighbours.
function choosePlacement(
  after: number,
  tokens: string[],
  asr: string[],
  scope: TimedTranscriptEntry[],
  silences: SilenceInterval[],
  rawWords: TimedTranscriptEntry[],
): Placement | undefined {
  let best: Placement | undefined;
  for (const candidate of equivalentPositions(after, tokens, asr)) {
    const prev = scope[candidate.after];
    const next = scope[candidate.after + 1];
    const gap = gapBetween(prev, next, silences);
    const slotUs = gap
      ? gapSlotUs(prev, next, gap, rawWords)
      : Math.max(
          0,
          (next?.startUs ?? prev?.endUs ?? 0) -
            (prev?.endUs ?? next?.startUs ?? 0),
        );
    if (!best || slotUs > best.slotUs) {
      best = {
        after: candidate.after,
        ...(gap ? { gap } : {}),
        slotUs,
        tokens: candidate.tokens,
      };
    }
  }
  return best;
}

// The dropped audio is on one side of the gap: whichever side Deepgram's raw
// timing left more room on.
function insertAtGap(
  words: TimedTranscriptEntry[],
  prev: TimedTranscriptEntry | undefined,
  next: TimedTranscriptEntry | undefined,
  tokens: string[],
  gap: SilenceInterval,
  rawWords: TimedTranscriptEntry[],
): void {
  if (prev && next) {
    const tailUs = gap.startUs - (findRaw(rawWords, prev)?.endUs ?? prev.endUs);
    const headUs =
      (findRaw(rawWords, next)?.startUs ?? next.startUs) - gap.endUs;
    if (tailUs >= headUs) {
      insertAfter(words, prev, tokens, gap.startUs, rawWords);
    } else {
      insertBefore(words, next, tokens, gap.endUs, rawWords);
    }
  } else if (next) {
    insertBefore(words, next, tokens, gap.endUs, rawWords);
  } else if (prev) {
    insertAfter(words, prev, tokens, gap.startUs, rawWords);
  }
}

function insertInner(
  words: TimedTranscriptEntry[],
  prev: TimedTranscriptEntry | undefined,
  next: TimedTranscriptEntry | undefined,
  tokens: string[],
  rawWords: TimedTranscriptEntry[],
): void {
  if (prev && next) {
    insertBetween(words, prev, next, tokens);
  } else if (next) {
    insertBefore(
      words,
      next,
      tokens,
      Math.max(0, next.startUs - MIN_SLOT_US * tokens.length),
      rawWords,
    );
  } else if (prev) {
    insertAfter(
      words,
      prev,
      tokens,
      prev.endUs + MIN_SLOT_US * tokens.length,
      rawWords,
    );
  }
}

// Sliding an insert over equal neighbouring words gives the same merged
// text: "[reach for] reach for it" == "reach for [reach for] it". Returns
// every such (after, tokens) pair, the given one first.
function equivalentPositions(
  after: number,
  tokens: string[],
  asr: string[],
): Array<{ after: number; tokens: string[] }> {
  const out = [{ after, tokens }];
  let at = after;
  let current = tokens;
  while (at >= 0 && normalize(current.at(-1) ?? '') === asr[at]) {
    current = [current.at(-1) as string, ...current.slice(0, -1)];
    at -= 1;
    out.push({ after: at, tokens: current });
  }
  at = after;
  current = tokens;
  while (at + 1 < asr.length && normalize(current[0] ?? '') === asr[at + 1]) {
    current = [...current.slice(1), current[0] as string];
    at += 1;
    out.push({ after: at, tokens: current });
  }
  return out;
}

function gapBetween(
  prev: TimedTranscriptEntry | undefined,
  next: TimedTranscriptEntry | undefined,
  silences: SilenceInterval[],
): SilenceInterval | undefined {
  return (
    silences.find(
      (gap) =>
        (prev
          ? Math.abs(gap.startUs - prev.endUs) <= GAP_TOUCH_US
          : gap.startUs <= GAP_TOUCH_US) &&
        (next ? Math.abs(gap.endUs - next.startUs) <= GAP_TOUCH_US : true),
    ) ??
    silences.find(
      (gap) =>
        (prev && Math.abs(gap.startUs - prev.endUs) <= GAP_TOUCH_US) ||
        (next && Math.abs(gap.endUs - next.startUs) <= GAP_TOUCH_US),
    )
  );
}

// Untranscribed audio beside a gap: between the raw ASR edges and the gap.
function gapSlotUs(
  prev: TimedTranscriptEntry | undefined,
  next: TimedTranscriptEntry | undefined,
  gap: SilenceInterval,
  rawWords: TimedTranscriptEntry[],
): number {
  const tail = prev
    ? gap.startUs - (findRaw(rawWords, prev)?.endUs ?? prev.endUs)
    : 0;
  const head = next
    ? (findRaw(rawWords, next)?.startUs ?? next.startUs) - gap.endUs
    : 0;
  return Math.max(tail, head, 0) + 1; // +1: a gap always beats a zero inner slot
}

function insertBefore(
  words: TimedTranscriptEntry[],
  first: TimedTranscriptEntry,
  tokens: string[],
  gapEdgeUs: number,
  rawWords: TimedTranscriptEntry[],
): void {
  const raw = findRaw(rawWords, first);
  let slotStartUs = gapEdgeUs;
  let slotEndUs = raw && raw.startUs > gapEdgeUs ? raw.startUs : first.startUs;
  if (slotEndUs - slotStartUs < MIN_SLOT_US) {
    slotEndUs = first.startUs + Math.round((first.endUs - first.startUs) / 2);
    first.startUs = slotEndUs;
  }
  if (slotStartUs > first.startUs) {
    slotStartUs = first.startUs;
  }
  words.splice(
    words.indexOf(first),
    0,
    ...spread(tokens, slotStartUs, slotEndUs),
  );
}

function insertAfter(
  words: TimedTranscriptEntry[],
  last: TimedTranscriptEntry,
  tokens: string[],
  gapEdgeUs: number,
  rawWords: TimedTranscriptEntry[],
): void {
  const raw = findRaw(rawWords, last);
  let slotStartUs = raw && raw.endUs < gapEdgeUs ? raw.endUs : last.endUs;
  const slotEndUs = gapEdgeUs;
  if (slotEndUs - slotStartUs < MIN_SLOT_US) {
    slotStartUs = last.startUs + Math.round((last.endUs - last.startUs) / 2);
    last.endUs = slotStartUs;
  } else if (slotStartUs < last.endUs) {
    last.endUs = slotStartUs;
  }
  words.splice(
    words.indexOf(last) + 1,
    0,
    ...spread(tokens, slotStartUs, slotEndUs),
  );
}

// No gap between the neighbours: use whatever audio lies between them, else
// split the neighbour the insert repeats (a stutter "I I" lives inside the
// ASR's one "I"), else the longer one.
function insertBetween(
  words: TimedTranscriptEntry[],
  prev: TimedTranscriptEntry,
  next: TimedTranscriptEntry,
  tokens: string[],
): void {
  let slotStartUs = prev.endUs;
  let slotEndUs = next.startUs;
  if (slotEndUs - slotStartUs < MIN_SLOT_US) {
    const repeatsNext = normalize(tokens[0] ?? '') === normalize(next.text);
    const repeatsPrev = normalize(tokens.at(-1) ?? '') === normalize(prev.text);
    const splitNext =
      repeatsNext ||
      (!repeatsPrev && next.endUs - next.startUs > prev.endUs - prev.startUs);
    if (splitNext) {
      slotStartUs = next.startUs;
      slotEndUs = next.startUs + Math.round((next.endUs - next.startUs) / 2);
      next.startUs = slotEndUs;
    } else {
      slotStartUs = prev.startUs + Math.round((prev.endUs - prev.startUs) / 2);
      slotEndUs = prev.endUs;
      prev.endUs = slotStartUs;
    }
  }
  words.splice(
    words.indexOf(next),
    0,
    ...spread(tokens, slotStartUs, slotEndUs),
  );
}

function spread(
  tokens: string[],
  startUs: number,
  endUs: number,
): TimedTranscriptEntry[] {
  const step = (endUs - startUs) / tokens.length;
  return tokens.map((text, index) => ({
    endUs: Math.round(startUs + step * (index + 1)),
    startUs: Math.round(startUs + step * index),
    text,
  }));
}

function findRaw(
  rawWords: TimedTranscriptEntry[],
  word: TimedTranscriptEntry,
): TimedTranscriptEntry | undefined {
  return rawWords.find(
    (raw) =>
      raw.text === word.text &&
      Math.abs(raw.startUs - word.startUs) < 1_500_000 &&
      Math.abs(raw.endUs - word.endUs) < 1_500_000,
  );
}

// ---- diff -----------------------------------------------------------------

// Longest common subsequence between the ASR words and the model tokens as
// (asrIndex, modelIndex) pairs, ascending. A model token marked cut off
// matches the whole ASR word it is a prefix of ("actua—" ~ "actually").
// Patience-style: tokens unique to both sides anchor the alignment, which is
// what keeps repeated take text from pairing across takes; the stretches
// between anchors are solved by a plain LCS table.
function diff(
  asr: string[],
  model: string[],
  cut: boolean[],
): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  const walk = (a0: number, a1: number, m0: number, m1: number): void => {
    if (a0 >= a1 || m0 >= m1) {
      return;
    }
    const anchors = uniqueAnchors(asr, model, a0, a1, m0, m1);
    if (anchors.length === 0) {
      out.push(...lcs(asr, model, cut, a0, a1, m0, m1));
      return;
    }
    let lastA = a0;
    let lastM = m0;
    for (const [a, m] of anchors) {
      walk(lastA, a, lastM, m);
      out.push([a, m]);
      lastA = a + 1;
      lastM = m + 1;
    }
    walk(lastA, a1, lastM, m1);
  };
  walk(0, asr.length, 0, model.length);
  return out;
}

// Longest increasing chain of tokens that occur exactly once on each side.
function uniqueAnchors(
  asr: string[],
  model: string[],
  a0: number,
  a1: number,
  m0: number,
  m1: number,
): [number, number][] {
  const countA = new Map<string, number>();
  const countM = new Map<string, number>();
  const posA = new Map<string, number>();
  const posM = new Map<string, number>();
  for (let i = a0; i < a1; i += 1) {
    const t = asr[i] as string;
    countA.set(t, (countA.get(t) ?? 0) + 1);
    posA.set(t, i);
  }
  for (let j = m0; j < m1; j += 1) {
    const t = model[j] as string;
    countM.set(t, (countM.get(t) ?? 0) + 1);
    posM.set(t, j);
  }
  const pairs: [number, number][] = [];
  for (let i = a0; i < a1; i += 1) {
    const t = asr[i] as string;
    if (countA.get(t) === 1 && countM.get(t) === 1) {
      pairs.push([i, posM.get(t) as number]);
    }
  }
  // Longest increasing subsequence on the model index (pairs are already
  // ascending in the ASR index).
  const tails: number[] = [];
  const tailIdx: number[] = [];
  const prevIdx = new Array<number>(pairs.length).fill(-1);
  for (const [k, [, m]] of pairs.entries()) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((tails[mid] as number) < m) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    tails[lo] = m;
    tailIdx[lo] = k;
    prevIdx[k] = lo > 0 ? (tailIdx[lo - 1] as number) : -1;
  }
  const chain: [number, number][] = [];
  let k = tailIdx.at(-1) ?? -1;
  while (k >= 0) {
    chain.push(pairs[k] as [number, number]);
    k = prevIdx[k] as number;
  }
  return chain.reverse();
}

// Regions between anchors are short (a take or two); a table is fine. A
// pathological region is left unmatched rather than blowing memory.
const MAX_LCS_CELLS = 4_000_000;

function lcs(
  asr: string[],
  model: string[],
  cut: boolean[],
  a0: number,
  a1: number,
  m0: number,
  m1: number,
): Array<readonly [number, number]> {
  const n = a1 - a0;
  const m = m1 - m0;
  if (n * m > MAX_LCS_CELLS) {
    return [];
  }
  const eq = (i: number, j: number): boolean => {
    const a = asr[a0 + i] as string;
    const b = model[m0 + j] as string;
    return a === b || ((cut[m0 + j] ?? false) && isSameWordCutOff(a, b));
  };
  const table = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] = eq(i, j)
        ? (table[at(i + 1, j + 1)] as number) + 1
        : Math.max(
            table[at(i + 1, j)] as number,
            table[at(i, j + 1)] as number,
          );
    }
  }
  const out: Array<readonly [number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(i, j)) {
      out.push([a0 + i, m0 + j]);
      i += 1;
      j += 1;
    } else if (
      (table[at(i + 1, j)] as number) >= (table[at(i, j + 1)] as number)
    ) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return out;
}

// ---- tokens ---------------------------------------------------------------

const TRAILING_DASH = /[—-]+$/;
const NON_WORD = /[^a-z0-9']/g;
const WHITESPACE = /\s+/;

// "actually" vs "actua—": the cut-off shares the word's opening.
function isSameWordCutOff(asrToken: string, stem: string): boolean {
  if (asrToken.length < 2 || stem.length < 2) {
    return false;
  }
  return asrToken.startsWith(stem) || stem.startsWith(asrToken);
}

function tokenize(
  text: string,
): Array<{ cut: boolean; norm: string; raw: string }> {
  return text
    .split(WHITESPACE)
    .filter(Boolean)
    .map((raw) => ({ cut: TRAILING_DASH.test(raw), norm: normalize(raw), raw }))
    .filter((token) => token.norm.length > 0);
}

function normalize(token: string): string {
  return token.toLowerCase().replace(NON_WORD, '');
}
