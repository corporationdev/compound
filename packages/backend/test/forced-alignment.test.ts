import { describe, expect, test } from "bun:test";
import {
  applyProviderTimingToPlacedWords,
  buildAlignmentSegments,
  buildSegmentsFromAlignedWords,
  validateForcedAlignment,
} from "../lib/transcription/forced-alignment";

describe("forced alignment contract", () => {
  test("keeps short recordings in one full-context segment", () => {
    const words = [
      { endUs: 200_000, startUs: 100_000, text: "and" },
      { endUs: 400_000, startUs: 250_000, text: "and" },
    ];
    expect(buildAlignmentSegments(words, 1_000_000)).toEqual([
      { endUs: 1_000_000, startUs: 0, words: ["and", "and"] },
    ]);
  });

  test("splits long recordings without dropping transcript occurrences", () => {
    const words = [
      { endUs: 50, startUs: 10, text: "one" },
      { endUs: 100, startUs: 60, text: "two" },
      { endUs: 170, startUs: 140, text: "three" },
    ];
    const segments = buildAlignmentSegments(words, 200, 120);
    expect(segments).toEqual([
      { endUs: 112, startUs: 0, words: ["one", "two"] },
      { endUs: 182, startUs: 128, words: ["three"] },
    ]);
    expect(segments.flatMap((segment) => segment.words)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  test("skips long silence while keeping every segment bounded", () => {
    const segments = buildAlignmentSegments(
      [
        { endUs: 210, startUs: 200, text: "late" },
        { endUs: 410, startUs: 400, text: "later" },
      ],
      500,
      100
    );
    expect(segments).toEqual([
      { endUs: 220, startUs: 190, words: ["late"] },
      { endUs: 420, startUs: 390, words: ["later"] },
    ]);
    expect(
      segments.every((segment) => segment.endUs - segment.startUs <= 100)
    ).toBe(true);
  });

  test("keeps words near the media end together in the final window", () => {
    const segments = buildAlignmentSegments(
      [
        { endUs: 50, startUs: 10, text: "one" },
        { endUs: 100, startUs: 60, text: "two" },
        { endUs: 170, startUs: 140, text: "three" },
        { endUs: 181, startUs: 171, text: "four" },
        { endUs: 192, startUs: 182, text: "five" },
      ],
      200,
      120
    );

    expect(segments).toEqual([
      { endUs: 112, startUs: 0, words: ["one", "two"] },
      {
        endUs: 200,
        startUs: 128,
        words: ["three", "four", "five"],
      },
    ]);
  });

  test("rejects reordered or overlapping Modal results", () => {
    const expected = [
      { endUs: 10, startUs: 0, text: "one" },
      { endUs: 30, startUs: 20, text: "two" },
    ];
    expect(() =>
      validateForcedAlignment(
        {
          durationUs: 100,
          meanScore: -0.1,
          model: "test",
          seamRepairCount: 0,
          words: [
            {
              endUs: 20,
              normalized: "ONE",
              score: -0.1,
              startUs: 0,
              text: "one",
            },
            {
              endUs: 30,
              normalized: "TWO",
              score: -0.1,
              startUs: 10,
              text: "two",
            },
          ],
        },
        expected
      )
    ).toThrow("overlapping");
  });

  test("accepts placed words and prefers provider timing inside the gap", () => {
    const provider = [
      { endUs: 300_000, startUs: 100_000, text: "and" },
      { endUs: 650_000, startUs: 450_000, text: "\u{1F600}" },
      { endUs: 1_000_000, startUs: 800_000, text: "and" },
    ];
    const result = {
      durationUs: 1_100_000,
      meanScore: -0.1,
      model: "test",
      seamRepairCount: 0,
      words: [
        {
          endUs: 300_000,
          normalized: "AND",
          score: -0.1,
          startUs: 0,
          text: "and",
        },
        {
          endUs: 800_000,
          normalized: "",
          score: 0,
          startUs: 300_000,
          text: "\u{1F600}",
        },
        {
          endUs: 1_100_000,
          normalized: "AND",
          score: -0.1,
          startUs: 800_000,
          text: "and",
        },
      ],
    };
    expect(() => validateForcedAlignment(result, provider)).not.toThrow();

    const adjusted = applyProviderTimingToPlacedWords(result, provider);
    expect(adjusted.words.map((word) => [word.startUs, word.endUs])).toEqual([
      [0, 300_000],
      [450_000, 650_000],
      [800_000, 1_100_000],
    ]);
    expect(() => validateForcedAlignment(adjusted, provider)).not.toThrow();
  });

  test("keeps the placed gap when provider timing does not fit inside it", () => {
    const provider = [
      { endUs: 300_000, startUs: 100_000, text: "and" },
      { endUs: 900_000, startUs: 250_000, text: "..." },
      { endUs: 1_000_000, startUs: 800_000, text: "and" },
    ];
    const result = {
      durationUs: 1_100_000,
      meanScore: -0.1,
      model: "test",
      seamRepairCount: 0,
      words: [
        {
          endUs: 300_000,
          normalized: "AND",
          score: -0.1,
          startUs: 0,
          text: "and",
        },
        {
          endUs: 800_000,
          normalized: "",
          score: 0,
          startUs: 300_000,
          text: "...",
        },
        {
          endUs: 1_100_000,
          normalized: "AND",
          score: -0.1,
          startUs: 800_000,
          text: "and",
        },
      ],
    };
    expect(applyProviderTimingToPlacedWords(result, provider)).toEqual(result);
  });

  test("forms readable segments from aligned acoustic gaps", () => {
    expect(
      buildSegmentsFromAlignedWords([
        { endUs: 100_000, startUs: 0, text: "first" },
        { endUs: 300_000, startUs: 150_000, text: "take." },
        { endUs: 1_200_000, startUs: 1_000_000, text: "Second" },
      ])
    ).toEqual([
      { endUs: 300_000, startUs: 0, text: "first take." },
      { endUs: 1_200_000, startUs: 1_000_000, text: "Second" },
    ]);
  });
});
