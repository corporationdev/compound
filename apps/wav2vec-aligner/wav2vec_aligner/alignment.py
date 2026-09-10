from __future__ import annotations

import re
import struct
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Any

import torch
from num2words import num2words

MICROSECONDS_PER_SECOND = 1_000_000
DURATION_ROUNDING_TOLERANCE_US = 1
NUMBER_PATTERN = re.compile(
    r"^(?P<prefix>[$£€])?(?P<number>\d[\d,]*(?:\.\d+)?)"
    r"(?P<ordinal>st|nd|rd|th)?(?P<percent>%)?$",
    re.IGNORECASE,
)
NON_LABEL_PATTERN = re.compile(r"[^A-Z']+")
SEPARATOR_PATTERN = re.compile(r"\|+")
NUMBER_EDGE_PUNCTUATION = ".,!?;:\"'()[]{}"
# Deepgram formats spoken clock times as "01:30", "1:30pm" or "10:45:30".
CLOCK_TIME_PATTERN = re.compile(
    r"^(?P<hour>\d{1,2}):(?P<minute>\d{2})(?::(?P<second>\d{2}))?"
    r"\s*(?P<meridiem>a\.?m\.?|p\.?m\.?)?$",
    re.IGNORECASE,
)
# Slash- or dash-joined plain integers: dates ("9/11", "3-4-2026"), ranges
# ("3-4"), fractions ("1/2") and phrases such as "24/7".
COMPOUND_NUMBER_PATTERN = re.compile(r"^\d+(?:(?P<separator>[/-])\d+)+$")
DIGIT_RUN_PATTERN = re.compile(r"\d+")
DASH_VARIANTS = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"
FRACTION_WORDS = {
    ("1", "2"): "one half",
    ("1", "3"): "one third",
    ("2", "3"): "two thirds",
    ("1", "4"): "one quarter",
    ("3", "4"): "three quarters",
    ("1", "5"): "one fifth",
    ("1", "8"): "one eighth",
}
# Digit runs longer than this are read digit by digit ("90210" is spoken as
# "nine zero two one zero", not as a ninety-thousand quantity).
MAX_CARDINAL_DIGITS = 4
DIGIT_WORDS = (
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
)
MIN_UNALIGNED_WORD_US = 40_000
MAX_NEIGHBOR_BORROW_FRACTION = 0.25


@dataclass(frozen=True)
class AlignmentWord:
    text: str
    normalized: str
    start_us: int
    end_us: int
    score: float


@dataclass(frozen=True)
class NormalizedWord:
    text: str
    normalized: str


def segment_pair_overlaps(
    left: Sequence[AlignmentWord], right: Sequence[AlignmentWord]
) -> bool:
    """Return whether independently aligned neighboring segments conflict."""
    return bool(left and right and right[0].start_us < left[-1].end_us)


def joint_seam_alignment_range(
    *,
    left: Sequence[AlignmentWord],
    right: Sequence[AlignmentWord],
    left_anchor_count: int,
    right_anchor_count: int,
    duration_us: int,
    context_us: int,
) -> tuple[int, int]:
    """Bound a joint seam alignment between the untouched neighbor words.

    Context may move anchor words relative to their independent alignments,
    but it must never let the replacement invade the prefix or suffix that is
    not being realigned. Those two untouched boundaries own the interval.
    """
    if left_anchor_count <= 0 or right_anchor_count <= 0:
        raise ValueError("Alignment seam anchors must be positive.")
    if left_anchor_count > len(left) or right_anchor_count > len(right):
        raise ValueError("Alignment seam anchors exceed the segment word count.")

    left_anchor = left[-left_anchor_count:]
    right_anchor = right[:right_anchor_count]
    untouched_prefix_end_us = (
        left[-left_anchor_count - 1].end_us if len(left) > left_anchor_count else 0
    )
    untouched_suffix_start_us = (
        right[right_anchor_count].start_us
        if len(right) > right_anchor_count
        else duration_us
    )
    start_us = max(
        0,
        untouched_prefix_end_us,
        left_anchor[0].start_us - context_us,
    )
    end_us = min(
        duration_us,
        untouched_suffix_start_us,
        right_anchor[-1].end_us + context_us,
    )
    if end_us <= start_us:
        raise RuntimeError("Joint seam alignment has no owned audio interval.")
    return start_us, end_us


def replace_overlapping_segment_seam(
    *,
    left: Sequence[AlignmentWord],
    right: Sequence[AlignmentWord],
    replacement: Sequence[AlignmentWord],
    left_anchor_count: int,
    right_anchor_count: int,
) -> tuple[list[AlignmentWord], list[AlignmentWord]]:
    """Replace both sides of a segment seam with one joint alignment.

    The overlapping audio windows are useful context, but their disjoint word
    lists have no shared timing constraint. A joint alignment of anchor words
    from both sides supplies that missing constraint. This helper verifies the
    replacement is exactly the requested word sequence before splicing it.
    """
    if left_anchor_count <= 0 or right_anchor_count <= 0:
        raise ValueError("Alignment seam anchors must be positive.")
    if left_anchor_count > len(left) or right_anchor_count > len(right):
        raise ValueError("Alignment seam anchors exceed the segment word count.")

    expected = [
        *left[-left_anchor_count:],
        *right[:right_anchor_count],
    ]
    if len(replacement) != len(expected) or any(
        actual.text != wanted.text
        for actual, wanted in zip(replacement, expected, strict=True)
    ):
        raise RuntimeError("Joint seam alignment changed the transcript words.")

    repaired_left = [
        *left[:-left_anchor_count],
        *replacement[:left_anchor_count],
    ]
    repaired_right = [
        *replacement[left_anchor_count:],
        *right[right_anchor_count:],
    ]
    _validate_aligned_words(repaired_left)
    _validate_aligned_words(repaired_right)
    _validate_aligned_words([*repaired_left, *repaired_right])
    return repaired_left, repaired_right


def clamp_segment_to_audio_duration(
    *, source_start_us: int, source_end_us: int, duration_us: int
) -> tuple[int, int]:
    """Clamp only the one-microsecond cross-runtime rounding discrepancy."""
    if source_start_us < 0 or source_end_us <= source_start_us:
        raise ValueError("Alignment segment range is invalid.")
    if (
        source_start_us >= duration_us
        or source_end_us > duration_us + DURATION_ROUNDING_TOLERANCE_US
    ):
        raise ValueError("Alignment segment lies outside the audio duration.")
    return source_start_us, min(source_end_us, duration_us)


def normalize_word(text: str) -> NormalizedWord:
    """Return the CTC target for one transcript token.

    ``normalized`` is empty when the token carries no speakable content (for
    example an emoji or a lone punctuation mark). Callers must treat such a
    word as unalignable rather than failing: one odd token must never sink
    the whole clip.
    """
    ascii_text = (
        unicodedata.normalize(
            "NFKD",
            text.replace("\u2019", "'").translate(
                str.maketrans({dash: "-" for dash in DASH_VARIANTS})
            ),
        )
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    # Deepgram's display token keeps sentence punctuation attached (for
    # example, "2020."). Strip only punctuation at the token edges before
    # deciding whether the complete token is numeric; the original text is
    # still returned unchanged for captions. Internal decimal points and
    # grouping commas remain available to NUMBER_PATTERN.
    number_candidate = ascii_text.strip().strip(NUMBER_EDGE_PUNCTUATION)
    spoken = _spell_number_token(number_candidate)
    if spoken is None:
        # Anything else that still carries digits ("COVID-19", "iPhone15",
        # "A1") gets every digit run spelled in place so the letters that
        # remain are speakable instead of vanishing.
        spoken = DIGIT_RUN_PATTERN.sub(
            lambda match: f" {_spell_digit_run(match.group(0))} ", ascii_text
        )

    normalized = SEPARATOR_PATTERN.sub(
        "|", NON_LABEL_PATTERN.sub("|", spoken.upper())
    ).strip("|")
    return NormalizedWord(text=text, normalized=normalized)


def _spell_number_token(candidate: str) -> str | None:
    number_match = NUMBER_PATTERN.fullmatch(candidate)
    if number_match:
        if candidate.isdigit() and (
            len(candidate) > MAX_CARDINAL_DIGITS
            or (len(candidate) > 1 and candidate.startswith("0"))
        ):
            # Deepgram groups spoken quantities ("10,000"); an ungrouped long
            # run or a zero-padded code ("007") is read digit by digit.
            return _spell_digit_run(candidate)
        number_text = number_match.group("number").replace(",", "")
        value: int | float = (
            float(number_text) if "." in number_text else int(number_text)
        )
        mode = "ordinal" if number_match.group("ordinal") else "cardinal"
        spoken = str(num2words(value, to=mode))
        currency = number_match.group("prefix")
        if currency == "$":
            spoken = f"{spoken} dollars"
        elif currency == "\u00a3":
            spoken = f"{spoken} pounds"
        elif currency == "\u20ac":
            spoken = f"{spoken} euros"
        if number_match.group("percent"):
            spoken = f"{spoken} percent"
        return spoken

    time_match = CLOCK_TIME_PATTERN.fullmatch(candidate)
    if time_match:
        return _spell_clock_time(time_match)

    compound_match = COMPOUND_NUMBER_PATTERN.fullmatch(candidate)
    if compound_match:
        separator = compound_match.group("separator")
        parts = re.split(r"[/-]", candidate)
        if separator == "/" and len(parts) == 2:
            fraction = FRACTION_WORDS.get((parts[0], parts[1]))
            if fraction is not None:
                return fraction
        joiner = " to " if separator == "-" and len(parts) == 2 else " "
        return joiner.join(_spell_digit_run(part) for part in parts)
    return None


def _spell_clock_time(match: re.Match[str]) -> str:
    hour = int(match.group("hour"))
    minute = int(match.group("minute"))
    second = match.group("second")
    meridiem = match.group("meridiem")
    words = [str(num2words(12 if hour == 0 else hour))]
    if minute == 0:
        if second is None and meridiem is None:
            words.append("o'clock")
    elif minute < 10:
        words.extend(["oh", str(num2words(minute))])
    else:
        words.append(str(num2words(minute)))
    if second is not None:
        words.append(str(num2words(int(second))))
    if meridiem is not None:
        words.append("a m" if meridiem.lower().startswith("a") else "p m")
    return " ".join(words)


def _spell_digit_run(digits: str) -> str:
    if len(digits) <= MAX_CARDINAL_DIGITS and not (
        len(digits) > 1 and digits.startswith("0")
    ):
        return str(num2words(int(digits)))
    return " ".join(DIGIT_WORDS[int(digit)] for digit in digits)


def align_emissions(
    *,
    emissions: torch.Tensor,
    labels: Sequence[str],
    words: Sequence[str],
    source_start_us: int,
    source_end_us: int,
) -> list[AlignmentWord]:
    if emissions.ndim != 2:
        raise ValueError("Expected emissions shaped [frames, labels].")
    if source_end_us <= source_start_us:
        raise ValueError("Alignment source range must have positive duration.")
    if not words:
        return []

    normalized_words = [normalize_word(word) for word in words]
    alignable_words = [word for word in normalized_words if word.normalized]
    if not alignable_words:
        return _place_unaligned_words(
            normalized_words, [], source_start_us, source_end_us
        )
    target_text = "|".join(word.normalized for word in alignable_words)
    label_to_index = {label: index for index, label in enumerate(labels)}
    blank_index = label_to_index.get("-")
    if blank_index is None:
        raise ValueError("Alignment model labels do not contain the '-' blank token.")
    unsupported = sorted(set(target_text).difference(label_to_index))
    if unsupported:
        raise ValueError(f"Unsupported transcript characters: {unsupported}")

    target_tokens = torch.tensor(
        [label_to_index[character] for character in target_text],
        dtype=torch.long,
        device=emissions.device,
    )
    character_frames = _viterbi_character_frames(
        emissions=emissions,
        target_tokens=target_tokens,
        blank_index=blank_index,
    )
    duration_us = source_end_us - source_start_us
    microseconds_per_frame = duration_us / emissions.shape[0]

    aligned_words: list[AlignmentWord] = []
    character_cursor = 0
    for word in alignable_words:
        character_count = len(word.normalized)
        word_frames = [
            frame
            for character_index in range(
                character_cursor, character_cursor + character_count
            )
            if target_text[character_index] != "|"
            for frame in character_frames[character_index]
        ]
        if not word_frames:
            raise RuntimeError(f"Alignment produced no frames for {word.text!r}.")
        character_scores = [
            emissions[character_frames[index], target_tokens[index]].mean().item()
            for index in range(character_cursor, character_cursor + character_count)
            if target_text[index] != "|"
        ]
        start_us = source_start_us + round(min(word_frames) * microseconds_per_frame)
        end_us = source_start_us + round(
            (max(word_frames) + 1) * microseconds_per_frame
        )
        aligned_words.append(
            AlignmentWord(
                text=word.text,
                normalized=word.normalized,
                start_us=start_us,
                end_us=end_us,
                score=sum(character_scores) / len(character_scores),
            )
        )
        character_cursor += character_count
        if character_cursor < len(target_text):
            if target_text[character_cursor] != "|":
                raise RuntimeError("Expected a separator between transcript words.")
            character_cursor += 1

    _validate_aligned_words(aligned_words)
    return _place_unaligned_words(
        normalized_words, aligned_words, source_start_us, source_end_us
    )


def _place_unaligned_words(
    words: Sequence[NormalizedWord],
    aligned: Sequence[AlignmentWord],
    source_start_us: int,
    source_end_us: int,
) -> list[AlignmentWord]:
    """Merge acoustically aligned words with the ones CTC could not target.

    An unalignable word (empty ``normalized``) is placed in the audio the
    aligned neighbors left free. When the neighbors touch, each lends up to a
    quarter of its own span so the word still gets a real interval. Its score
    is 0.0 and ``normalized`` stays empty, which is how callers recognize a
    placed rather than aligned word.
    """
    aligned_iterator = iter(aligned)
    placed: list[AlignmentWord | None] = []
    for word in words:
        if word.normalized:
            aligned_word = next(aligned_iterator)
            if aligned_word.text != word.text:
                raise RuntimeError("Aligned words diverged from the transcript.")
            placed.append(aligned_word)
        else:
            placed.append(None)
    if next(aligned_iterator, None) is not None:
        raise RuntimeError("Aligned words diverged from the transcript.")

    index = 0
    while index < len(placed):
        if placed[index] is not None:
            index += 1
            continue
        run_end = index
        while run_end < len(placed) and placed[run_end] is None:
            run_end += 1
        run_length = run_end - index
        previous = placed[index - 1] if index > 0 else None
        following = placed[run_end] if run_end < len(placed) else None
        free_start_us = previous.end_us if previous else source_start_us
        free_end_us = following.start_us if following else source_end_us
        wanted_us = MIN_UNALIGNED_WORD_US * run_length
        if free_end_us - free_start_us < wanted_us:
            if previous is not None:
                borrow_us = min(
                    int(
                        (previous.end_us - previous.start_us)
                        * MAX_NEIGHBOR_BORROW_FRACTION
                    ),
                    wanted_us - (free_end_us - free_start_us),
                )
                if borrow_us > 0:
                    previous = replace(previous, end_us=previous.end_us - borrow_us)
                    placed[index - 1] = previous
                    free_start_us = previous.end_us
            if following is not None and free_end_us - free_start_us < wanted_us:
                borrow_us = min(
                    int(
                        (following.end_us - following.start_us)
                        * MAX_NEIGHBOR_BORROW_FRACTION
                    ),
                    wanted_us - (free_end_us - free_start_us),
                )
                if borrow_us > 0:
                    following = replace(
                        following, start_us=following.start_us + borrow_us
                    )
                    placed[run_end] = following
                    free_end_us = following.start_us
        if free_end_us - free_start_us < run_length:
            raise RuntimeError(
                f"No audio interval is free for the unalignable word {words[index].text!r}."
            )
        for offset in range(run_length):
            word = words[index + offset]
            start_us = free_start_us + round(
                (free_end_us - free_start_us) * offset / run_length
            )
            end_us = free_start_us + round(
                (free_end_us - free_start_us) * (offset + 1) / run_length
            )
            placed[index + offset] = AlignmentWord(
                text=word.text,
                normalized="",
                start_us=start_us,
                end_us=end_us,
                score=0.0,
            )
        index = run_end

    result = [word for word in placed if word is not None]
    if len(result) != len(words):
        raise RuntimeError("Unaligned word placement dropped a transcript word.")
    _validate_aligned_words(result)
    return result


def _viterbi_character_frames(
    *, emissions: torch.Tensor, target_tokens: torch.Tensor, blank_index: int
) -> list[list[int]]:
    frame_count, _ = emissions.shape
    target_count = target_tokens.numel()
    state_count = target_count * 2 + 1
    if frame_count < target_count:
        raise ValueError(
            f"Audio has {frame_count} frames for {target_count} target characters."
        )

    state_tokens = torch.full(
        (state_count,), blank_index, dtype=torch.long, device=emissions.device
    )
    state_tokens[1::2] = target_tokens
    negative_infinity = torch.tensor(
        float("-inf"), dtype=emissions.dtype, device=emissions.device
    )
    previous = torch.full(
        (state_count,),
        negative_infinity,
        dtype=emissions.dtype,
        device=emissions.device,
    )
    previous[0] = emissions[0, blank_index]
    previous[1] = emissions[0, target_tokens[0]]
    backpointers = torch.full(
        (frame_count, state_count),
        -1,
        dtype=torch.int8,
        device=emissions.device,
    )

    skip_allowed = torch.zeros(state_count, dtype=torch.bool, device=emissions.device)
    if target_count > 1:
        current_targets = target_tokens[1:]
        previous_targets = target_tokens[:-1]
        skip_allowed[3::2] = current_targets != previous_targets

    for frame_index in range(1, frame_count):
        advance_one = torch.cat((negative_infinity.expand(1), previous[:-1]))
        advance_two = torch.cat((negative_infinity.expand(2), previous[:-2]))
        advance_two = torch.where(skip_allowed, advance_two, negative_infinity)
        candidates = torch.stack((previous, advance_one, advance_two), dim=0)
        best_scores, best_moves = candidates.max(dim=0)
        current = best_scores + emissions[frame_index, state_tokens]
        backpointers[frame_index] = best_moves.to(torch.int8)
        previous = current

    final_candidates = torch.stack((previous[-1], previous[-2]))
    final_choice = int(final_candidates.argmax().item())
    state_index = state_count - 1 - final_choice
    if not torch.isfinite(previous[state_index]):
        raise RuntimeError("No valid CTC alignment path was found.")

    character_frames: list[list[int]] = [[] for _ in range(target_count)]
    for frame_index in range(frame_count - 1, -1, -1):
        if state_index % 2 == 1:
            character_frames[(state_index - 1) // 2].append(frame_index)
        if frame_index == 0:
            break
        move = int(backpointers[frame_index, state_index].item())
        if move < 0:
            raise RuntimeError("CTC alignment backtrace reached an invalid state.")
        state_index -= move

    for frames in character_frames:
        frames.reverse()
        if not frames:
            raise RuntimeError("CTC alignment omitted a transcript character.")
    return character_frames


def read_pcm16_wav(wav: bytes) -> tuple[torch.Tensor, int]:
    if len(wav) < 12 or wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise ValueError("Audio is not a RIFF WAV file.")
    offset = 12
    format_info: tuple[int, int, int, int] | None = None
    while offset + 8 <= len(wav):
        chunk_id = wav[offset : offset + 4]
        chunk_size = struct.unpack_from("<I", wav, offset + 4)[0]
        body = offset + 8
        if body + chunk_size > len(wav):
            raise ValueError("WAV chunk extends past the end of the file.")
        if chunk_id == b"fmt ":
            if chunk_size < 16:
                raise ValueError("WAV fmt chunk is incomplete.")
            format_tag, channels, sample_rate = struct.unpack_from("<HHI", wav, body)
            bits_per_sample = struct.unpack_from("<H", wav, body + 14)[0]
            is_pcm = format_tag == 1
            if format_tag == 0xFFFE and chunk_size >= 40:
                is_pcm = struct.unpack_from("<H", wav, body + 24)[0] == 1
            format_info = (channels, sample_rate, bits_per_sample, int(is_pcm))
        elif chunk_id == b"data":
            if format_info is None:
                raise ValueError("WAV data chunk appeared before fmt.")
            channels, sample_rate, bits_per_sample, is_pcm = format_info
            if not is_pcm or channels != 1 or bits_per_sample != 16:
                raise ValueError(
                    "Audio must be mono 16-bit PCM "
                    f"(got {channels} channels and {bits_per_sample} bits)."
                )
            pcm = bytearray(wav[body : body + chunk_size])
            waveform = torch.frombuffer(pcm, dtype=torch.int16).to(torch.float32)
            return waveform.unsqueeze(0) / 32768.0, sample_rate
        offset = body + chunk_size + (chunk_size % 2)
    raise ValueError("WAV file has no data chunk.")


def alignment_words_to_dicts(words: Sequence[AlignmentWord]) -> list[dict[str, Any]]:
    return [
        {
            "endUs": word.end_us,
            "normalized": word.normalized,
            "score": word.score,
            "startUs": word.start_us,
            "text": word.text,
        }
        for word in words
    ]


def _validate_aligned_words(words: Sequence[AlignmentWord]) -> None:
    previous_end_us = -1
    for word in words:
        if word.end_us <= word.start_us:
            raise RuntimeError(f"Non-positive word duration: {word.text!r}")
        if word.start_us < previous_end_us:
            raise RuntimeError(f"Overlapping word timing: {word.text!r}")
        previous_end_us = word.end_us
