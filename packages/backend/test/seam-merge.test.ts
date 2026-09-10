import { describe, expect, test } from "bun:test";
import { mergeSeamVerbatim } from "../lib/transcription/seam-merge";

const S = 1_000_000;
const W = (startUs: number, endUs: number, text: string) => ({
  endUs,
  startUs,
  text,
});
const text = (words: Array<{ text: string }>) =>
  words.map((w) => w.text).join(" ");

describe("mergeSeamVerbatim", () => {
  test("so—so: the restart's dropped first word is prepended into the slot", () => {
    // Deepgram: "the sky's" starting at the gap end (corrected); raw started
    // 0.3s later — that slot is where the dropped "so" lives.
    const words = [
      W(451.0 * S, 451.69 * S, "So"),
      W(452.31 * S, 452.8 * S, "the"),
      W(452.8 * S, 453.1 * S, "sky's"),
    ];
    const raw = [
      W(451.0 * S, 451.69 * S, "So"),
      W(452.6 * S, 452.8 * S, "the"),
      W(452.8 * S, 453.1 * S, "sky's"),
    ];
    const result = mergeSeamVerbatim({
      rawWords: raw,
      silences: [{ endUs: 452.31 * S, startUs: 451.69 * S }],
      verbatim: "So— so the sky's",
      words,
    });
    expect(result.edits.map((e) => e.kind)).toEqual(["insert"]);
    expect(text(words)).toBe("So so the sky's");
    const so = words[1];
    expect(so?.startUs).toBe(452.31 * S);
    expect(so?.endUs).toBe(452.6 * S);
  });

  test("actua—actually: the cut-off is reworded, the restart word prepended", () => {
    const words = [
      W(10.0 * S, 10.3 * S, "and"),
      W(10.3 * S, 10.7 * S, "actually"),
      W(11.4 * S, 11.8 * S, "actually"),
      W(11.8 * S, 12.1 * S, "doing"),
    ];
    const result = mergeSeamVerbatim({
      rawWords: words.map((w) => ({ ...w })),
      silences: [{ endUs: 11.4 * S, startUs: 10.7 * S }],
      verbatim: "and actua— actually doing",
      words,
    });
    expect(result.edits.map((e) => e.kind)).toEqual(["reword"]);
    expect(text(words)).toBe("and actua— actually doing");
  });

  test("appends a dropped phrase at the end of the failed take", () => {
    const words = [
      W(1.0 * S, 1.4 * S, "demonstrate"),
      W(1.4 * S, 1.9 * S, "something"),
      W(5.2 * S, 5.6 * S, "demonstrate"),
      W(5.6 * S, 6.1 * S, "something"),
      W(6.1 * S, 6.4 * S, "more"),
    ];
    const raw = words.map((w) => ({ ...w }));
    // Raw "something" ended at 1.9 and the gap starts at 3.4: 1.5s of
    // untranscribed audio where the rest of the aborted take is.
    const result = mergeSeamVerbatim({
      rawWords: raw,
      silences: [{ endUs: 5.2 * S, startUs: 3.4 * S }],
      verbatim:
        "demonstrate something more important than any of your demonstrate something more",
      words,
    });
    expect(result.edits.map((e) => e.kind)).toEqual(["insert"]);
    expect(text(words)).toBe(
      "demonstrate something more important than any of your demonstrate something more"
    );
    // The insert lands in the tail slot, not across the gap.
    expect(words[2]?.startUs).toBe(1.9 * S);
    expect(words[7]?.endUs).toBe(3.4 * S);
  });

  test("places a repeated phrase beside the gap, not inside the good take", () => {
    // ASR has one copy; the model has two. Either copy could be "the
    // insert"; the one whose slot has untranscribed audio wins.
    const words = [
      W(1.0 * S, 1.3 * S, "reach"),
      W(1.3 * S, 1.5 * S, "for"),
      W(1.5 * S, 1.7 * S, "it"),
    ];
    const raw = words.map((w) => ({ ...w }));
    const result = mergeSeamVerbatim({
      rawWords: raw,
      silences: [{ endUs: 1.0 * S, startUs: 0.2 * S }],
      verbatim: "reach for reach for it",
      words,
    });
    expect(result.edits).toHaveLength(1);
    expect(text(words)).toBe("reach for reach for it");
    expect(words.map((w) => w.startUs <= w.endUs).every(Boolean)).toBe(true);
  });

  test("production retake regression: separate inserts reuse the same gap slot", () => {
    // Production source ending: "...helps you discover the strategies you
    // to help you discover the strategies to get into...". Deepgram kept
    // only one "to" while the verbatim seam transcript heard the full
    // restart. The diff consequently creates two inserts around that same
    // ASR word, and both are independently placed into the same 280ms of
    // untranscribed audio before the measured pause.
    const raw = [
      W(46.495 * S, 46.655 * S, "and"),
      W(46.655 * S, 46.975 * S, "helps"),
      W(46.975 * S, 47.135 * S, "you"),
      W(47.135 * S, 47.454_998 * S, "discover"),
      W(47.454_998 * S, 47.614_998 * S, "the"),
      W(47.614_998 * S, 48.414_997 * S, "strategies"),
      W(49.054_996 * S, 49.614_998 * S, "to"),
      W(50.655 * S, 50.734_997 * S, "get"),
      W(50.734_997 * S, 50.975 * S, "into"),
    ];
    const words = [
      W(46.641 * S, 46.655 * S, "and"),
      W(46.655 * S, 46.975 * S, "helps"),
      W(46.975 * S, 47.135 * S, "you"),
      W(47.135 * S, 47.454_998 * S, "discover"),
      W(47.454_998 * S, 47.614_998 * S, "the"),
      W(47.614_998 * S, 48.695 * S, "strategies"),
      W(49.137 * S, 50.134_999 * S, "to"),
      W(50.134_999 * S, 50.734_997 * S, "get"),
      W(50.734_997 * S, 50.975 * S, "into"),
    ];

    const result = mergeSeamVerbatim({
      rawWords: raw,
      silences: [{ endUs: 49.137 * S, startUs: 48.695 * S }],
      verbatim:
        "and helps you discover the strategies you to help you discover the strategies to get into",
      words,
    });

    expect(result.edits.map((edit) => edit.detail)).toEqual([
      'insert "you" at gap @48695000',
      'insert "to help you discover the strategies" at gap @48695000',
    ]);
    const overlappingPair = words.find(
      (word, index) =>
        index > 0 && word.startUs < (words[index - 1]?.endUs ?? 0)
    );
    expect(overlappingPair?.text).toBe("to");
    expect(overlappingPair?.startUs).toBe(48.414_997 * S);
    expect(words[6]?.text).toBe("you");
    expect(words[6]?.endUs).toBe(48.695 * S);
  });

  test("a stutter splits the word it repeats", () => {
    const words = [W(1.0 * S, 1.4 * S, "I"), W(1.4 * S, 1.8 * S, "tried")];
    mergeSeamVerbatim({
      rawWords: words.map((w) => ({ ...w })),
      silences: [],
      verbatim: "I I tried",
      words,
    });
    expect(text(words)).toBe("I I tried");
    expect(words[0]?.endUs).toBe(1.2 * S);
    expect(words[1]?.startUs).toBe(1.2 * S);
  });

  test("ignores substitutions and deletions", () => {
    const words = [
      W(1.0 * S, 1.3 * S, "with"),
      W(1.3 * S, 1.6 * S, "Postbob"),
      W(1.6 * S, 1.8 * S, "and"),
      W(1.8 * S, 2.1 * S, "shit"),
    ];
    const result = mergeSeamVerbatim({
      rawWords: words.map((w) => ({ ...w })),
      silences: [],
      verbatim: "with postub and",
      words,
    });
    expect(result.edits).toEqual([]);
    expect(result.rejections.map((r) => r.reason)).toEqual(["substitution"]);
    expect(text(words)).toBe("with Postbob and shit");
  });

  test("rejects rewording a real word into a different word", () => {
    const words = [W(1.0 * S, 1.2 * S, "if"), W(1.2 * S, 1.5 * S, "you")];
    const result = mergeSeamVerbatim({
      rawWords: words.map((w) => ({ ...w })),
      silences: [],
      verbatim: "fall— you",
      words,
    });
    expect(result.edits).toEqual([]);
    expect(text(words)).toBe("if you");
  });

  test("caps inner inserts short and gap inserts long", () => {
    const words = [W(1.0 * S, 1.3 * S, "one"), W(1.3 * S, 1.6 * S, "two")];
    const result = mergeSeamVerbatim({
      rawWords: words.map((w) => ({ ...w })),
      silences: [],
      verbatim: "one a b c d two",
      words,
    });
    expect(result.edits).toEqual([]);
    expect(result.rejections[0]?.reason).toContain("exceeds 3");
  });

  test("returns nothing when the model agrees", () => {
    const words = [
      W(1.0 * S, 1.3 * S, "Hello,"),
      W(1.3 * S, 1.6 * S, "world."),
    ];
    const result = mergeSeamVerbatim({
      rawWords: words.map((w) => ({ ...w })),
      silences: [],
      verbatim: "hello world",
      words,
    });
    expect(result.edits).toEqual([]);
    expect(result.rejections).toEqual([]);
  });
});
