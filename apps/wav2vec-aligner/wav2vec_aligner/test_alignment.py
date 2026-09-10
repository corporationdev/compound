from __future__ import annotations

import unittest

import torch

from wav2vec_aligner.alignment import (
    AlignmentWord,
    NormalizedWord,
    _place_unaligned_words,
    align_emissions,
    clamp_segment_to_audio_duration,
    joint_seam_alignment_range,
    normalize_word,
    replace_overlapping_segment_seam,
    segment_pair_overlaps,
)

LABELS = (
    "-",
    "|",
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "I",
    "N",
    "O",
    "R",
    "T",
    "U",
    "V",
    "W",
    "Y",
    "'",
)


class AlignmentTests(unittest.TestCase):
    def test_joint_seam_window_cannot_invade_untouched_neighbors(self) -> None:
        left = [
            AlignmentWord("your", "YOUR", 149_000_000, 150_100_000, -0.03),
            AlignmentWord("go", "GO", 150_900_000, 151_500_000, -0.04),
            AlignmentWord("there", "THERE", 151_500_000, 152_400_000, -0.05),
        ]
        right = [
            AlignmentWord("with", "WITH", 152_030_097, 153_510_301, -0.05),
            AlignmentWord("me", "ME", 153_600_000, 154_100_000, -0.03),
            AlignmentWord("today", "TODAY", 154_300_000, 155_000_000, -0.03),
        ]

        start_us, end_us = joint_seam_alignment_range(
            left=left,
            right=right,
            left_anchor_count=2,
            right_anchor_count=2,
            duration_us=499_060_000,
            context_us=1_000_000,
        )

        self.assertEqual(start_us, 150_100_000)
        self.assertEqual(end_us, 154_300_000)

    def test_jointly_repairs_the_observed_august_28_segment_overlap(self) -> None:
        left = [
            AlignmentWord("go", "GO", 150_900_000, 151_500_000, -0.04),
            AlignmentWord("there", "THERE", 151_500_000, 152_400_000, -0.05),
        ]
        right = [
            AlignmentWord(
                "with", "WITH", 152_030_097, 153_510_301, -0.05816051515284926
            ),
            AlignmentWord("me", "ME", 153_600_000, 154_100_000, -0.03),
        ]
        self.assertTrue(segment_pair_overlaps(left, right))

        replacement = [
            AlignmentWord("go", "GO", 150_900_000, 151_350_000, -0.04),
            AlignmentWord("there", "THERE", 151_350_000, 152_150_000, -0.05),
            AlignmentWord("with", "WITH", 152_150_000, 153_510_301, -0.05),
            AlignmentWord("me", "ME", 153_600_000, 154_100_000, -0.03),
        ]
        repaired_left, repaired_right = replace_overlapping_segment_seam(
            left=left,
            right=right,
            replacement=replacement,
            left_anchor_count=2,
            right_anchor_count=2,
        )

        self.assertFalse(segment_pair_overlaps(repaired_left, repaired_right))
        self.assertEqual(
            [word.text for word in [*repaired_left, *repaired_right]],
            ["go", "there", "with", "me"],
        )

    def test_clamps_javascript_half_up_duration_to_python_audio_duration(
        self,
    ) -> None:
        sample_count = 1_534_437
        exact_duration_us = sample_count / 16_000 * 1_000_000
        javascript_duration_us = int(exact_duration_us + 0.5)
        python_duration_us = round(exact_duration_us)

        self.assertEqual(javascript_duration_us, 95_902_313)
        self.assertEqual(python_duration_us, 95_902_312)
        self.assertEqual(
            clamp_segment_to_audio_duration(
                source_start_us=0,
                source_end_us=javascript_duration_us,
                duration_us=python_duration_us,
            ),
            (0, python_duration_us),
        )

    def test_rejects_segment_more_than_rounding_tolerance_past_audio(self) -> None:
        with self.assertRaisesRegex(
            ValueError, "Alignment segment lies outside the audio duration"
        ):
            clamp_segment_to_audio_duration(
                source_start_us=0,
                source_end_us=1_000_002,
                duration_us=1_000_000,
            )

    def test_normalizes_numbers_without_changing_display_text(self) -> None:
        word = normalize_word("20%")
        self.assertEqual(word.text, "20%")
        self.assertEqual(word.normalized, "TWENTY|PERCENT")

    def test_normalizes_sentence_final_number_without_changing_display_text(
        self,
    ) -> None:
        word = normalize_word("2020.")
        self.assertEqual(word.text, "2020.")
        self.assertEqual(word.normalized, "TWO|THOUSAND|AND|TWENTY")

    def test_normalizes_grouped_number_with_trailing_punctuation(self) -> None:
        word = normalize_word("2,020,")
        self.assertEqual(word.text, "2,020,")
        self.assertEqual(word.normalized, "TWO|THOUSAND|AND|TWENTY")

    def test_normalizes_clock_times_the_way_they_are_spoken(self) -> None:
        # The September 4 production failure: Deepgram wrote "one thirty" as
        # "01:30" and the aligner had nothing left after stripping digits.
        self.assertEqual(normalize_word("01:30").normalized, "ONE|THIRTY")
        self.assertEqual(normalize_word("1:30").normalized, "ONE|THIRTY")
        self.assertEqual(normalize_word("10:45,").normalized, "TEN|FORTY|FIVE")
        self.assertEqual(normalize_word("1:05").normalized, "ONE|OH|FIVE")
        self.assertEqual(normalize_word("10:00").normalized, "TEN|O'CLOCK")
        self.assertEqual(normalize_word("12:00pm").normalized, "TWELVE|P|M")
        self.assertEqual(normalize_word("00:30").normalized, "TWELVE|THIRTY")
        self.assertEqual(normalize_word("1:30:15").normalized, "ONE|THIRTY|FIFTEEN")
        self.assertEqual(normalize_word("01:30").text, "01:30")

    def test_normalizes_dates_ranges_and_fractions(self) -> None:
        self.assertEqual(normalize_word("9/11").normalized, "NINE|ELEVEN")
        self.assertEqual(
            normalize_word("9/11/2001.").normalized,
            "NINE|ELEVEN|TWO|THOUSAND|AND|ONE",
        )
        self.assertEqual(normalize_word("24/7").normalized, "TWENTY|FOUR|SEVEN")
        self.assertEqual(normalize_word("3-4").normalized, "THREE|TO|FOUR")
        self.assertEqual(normalize_word("3\u20134").normalized, "THREE|TO|FOUR")
        self.assertEqual(normalize_word("1/2").normalized, "ONE|HALF")
        self.assertEqual(normalize_word("3/4").normalized, "THREE|QUARTERS")
        self.assertEqual(
            normalize_word("555-0199").normalized,
            "FIVE|HUNDRED|AND|FIFTY|FIVE|TO|ZERO|ONE|NINE|NINE",
        )

    def test_spells_digit_runs_inside_mixed_tokens(self) -> None:
        self.assertEqual(normalize_word("COVID-19").normalized, "COVID|NINETEEN")
        self.assertEqual(normalize_word("iPhone15").normalized, "IPHONE|FIFTEEN")
        self.assertEqual(normalize_word("3D").normalized, "THREE|D")
        self.assertEqual(normalize_word("90210").normalized, "NINE|ZERO|TWO|ONE|ZERO")
        self.assertEqual(normalize_word("007").normalized, "ZERO|ZERO|SEVEN")

    def test_returns_empty_target_instead_of_raising_for_unspeakable_tokens(
        self,
    ) -> None:
        for token in ("\U0001f600", "...", "\u2014", ""):
            self.assertEqual(normalize_word(token).normalized, "", token)
            self.assertEqual(normalize_word(token).text, token)

    def test_places_unalignable_word_in_the_free_gap_between_neighbors(
        self,
    ) -> None:
        frames = ["A", "N", "D", "|", "-", "-", "-", "-", "A", "N", "D"]
        emissions = torch.full((len(frames), len(LABELS)), -20.0)
        label_to_index = {label: index for index, label in enumerate(LABELS)}
        for index, label in enumerate(frames):
            emissions[index, label_to_index[label]] = 0.0

        aligned = align_emissions(
            emissions=emissions,
            labels=LABELS,
            source_end_us=1_100_000,
            source_start_us=0,
            words=["and", "\U0001f600", "and"],
        )

        self.assertEqual([word.text for word in aligned], ["and", "\U0001f600", "and"])
        self.assertEqual(
            [(word.start_us, word.end_us) for word in aligned],
            [(0, 300_000), (300_000, 800_000), (800_000, 1_100_000)],
        )
        self.assertEqual(aligned[1].normalized, "")
        self.assertEqual(aligned[1].score, 0.0)
        self.assertNotEqual(aligned[0].normalized, "")

    def test_borrows_from_touching_neighbors_for_an_unalignable_word(
        self,
    ) -> None:
        words = [
            NormalizedWord("and", "AND"),
            NormalizedWord("...", ""),
            NormalizedWord("and", "AND"),
        ]
        aligned = [
            AlignmentWord("and", "AND", 0, 300_000, -0.1),
            AlignmentWord("and", "AND", 300_000, 700_000, -0.2),
        ]

        placed = _place_unaligned_words(words, aligned, 0, 700_000)

        self.assertEqual([word.text for word in placed], ["and", "...", "and"])
        self.assertEqual(
            [(word.start_us, word.end_us) for word in placed],
            [(0, 260_000), (260_000, 300_000), (300_000, 700_000)],
        )
        self.assertEqual(placed[0].score, -0.1)
        self.assertEqual(placed[1].normalized, "")

    def test_spreads_words_over_the_range_when_nothing_is_alignable(
        self,
    ) -> None:
        emissions = torch.full((4, len(LABELS)), -20.0)
        aligned = align_emissions(
            emissions=emissions,
            labels=LABELS,
            source_end_us=400_000,
            source_start_us=100_000,
            words=["...", "\u2014"],
        )
        self.assertEqual(
            [(word.start_us, word.end_us) for word in aligned],
            [(100_000, 250_000), (250_000, 400_000)],
        )

    def test_aligns_repeated_words_as_distinct_occurrences(self) -> None:
        words = ["and", "and"]
        target = "AND|AND"
        frames = ["A", "N", "D", "|", "A", "N", "D"]
        emissions = torch.full((len(frames), len(LABELS)), -20.0)
        label_to_index = {label: index for index, label in enumerate(LABELS)}
        for index, label in enumerate(frames):
            emissions[index, label_to_index[label]] = 0.0

        aligned = align_emissions(
            emissions=emissions,
            labels=LABELS,
            source_end_us=700_000,
            source_start_us=0,
            words=words,
        )

        self.assertEqual(target, "|".join(word.normalized for word in aligned))
        self.assertEqual(
            [(word.start_us, word.end_us) for word in aligned],
            [
                (0, 300_000),
                (400_000, 700_000),
            ],
        )

    def test_repeated_character_requires_a_blank_frame(self) -> None:
        labels = ("-", "A")
        emissions = torch.tensor(
            [
                [-20.0, 0.0],
                [0.0, -20.0],
                [-20.0, 0.0],
            ]
        )
        aligned = align_emissions(
            emissions=emissions,
            labels=labels,
            source_end_us=300_000,
            source_start_us=0,
            words=["AA"],
        )
        self.assertEqual(aligned[0].start_us, 0)
        self.assertEqual(aligned[0].end_us, 300_000)


if __name__ == "__main__":
    unittest.main()
