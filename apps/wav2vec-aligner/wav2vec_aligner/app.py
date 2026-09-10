from __future__ import annotations

from typing import Any

import modal

APP_NAME = "compound-wav2vec-aligner"
MODEL_NAME = "torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H"
MODEL_SAMPLE_RATE = 16_000
MICROSECONDS_PER_SECOND = 1_000_000
MAX_SEGMENT_DURATION_US = 3 * 60 * MICROSECONDS_PER_SECOND
SEAM_ANCHOR_WORD_COUNT = 8
SEAM_CONTEXT_US = MICROSECONDS_PER_SECOND


def download_model() -> None:
    import torchaudio

    torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H.get_model()


image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install(
        "torch==2.8.0+cpu",
        "torchaudio==2.8.0+cpu",
        index_url="https://download.pytorch.org/whl/cpu",
    )
    .uv_pip_install("num2words==0.5.14")
    .run_function(download_model)
    .add_local_python_source("wav2vec_aligner")
)
app = modal.App(APP_NAME)


@app.cls(
    cpu=4.0,
    image=image,
    max_containers=10,
    memory=4096,
    scaledown_window=600,
    startup_timeout=180,
    timeout=300,
)
class Wav2VecAligner:
    @modal.enter()
    def load(self) -> None:
        import torch
        import torchaudio

        torch.set_grad_enabled(False)
        bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
        self.model = bundle.get_model().eval()
        self.labels = bundle.get_labels()

    @modal.method()
    def align(self, audio_url: str, segments: list[dict[str, Any]], metadata: dict[str, int]) -> dict[str, Any]:
        import torch

        from wav2vec_aligner.alignment import (
            align_emissions,
            alignment_words_to_dicts,
            clamp_segment_to_audio_duration,
            joint_seam_alignment_range,
            replace_overlapping_segment_seam,
            segment_pair_overlaps,
        )

        from wav2vec_aligner.audio import read_pcm_range, validate_metadata

        validate_metadata(metadata)
        duration_us = metadata["durationUs"]
        if not 1 <= len(segments) <= 2:
            raise ValueError("Alignment requires one or two segments.")

        def align_range(
            source_start_us: int, source_end_us: int, words: list[str]
        ) -> list[Any]:
            pcm = read_pcm_range(audio_url, metadata, source_start_us, source_end_us)
            audio = torch.frombuffer(bytearray(pcm), dtype=torch.int16).to(torch.float32).unsqueeze(0) / 32768.0
            with torch.inference_mode():
                emissions, _ = self.model(audio)
                log_probabilities = torch.log_softmax(emissions[0], dim=-1)
            return align_emissions(
                emissions=log_probabilities,
                labels=self.labels,
                source_end_us=source_end_us,
                source_start_us=source_start_us,
                words=words,
            )

        aligned_segments: list[list[Any]] = []
        for segment in segments:
            source_start_us, source_end_us = clamp_segment_to_audio_duration(
                source_start_us=int(segment["startUs"]),
                source_end_us=int(segment["endUs"]),
                duration_us=duration_us,
            )
            if source_end_us - source_start_us > MAX_SEGMENT_DURATION_US:
                raise ValueError("Alignment segment exceeds the three-minute limit.")
            words = [str(word) for word in segment["words"]]
            aligned_segments.append(align_range(source_start_us, source_end_us, words))

        seam_repair_count = 0
        for segment_index in range(1, len(aligned_segments)):
            left = aligned_segments[segment_index - 1]
            right = aligned_segments[segment_index]
            if not segment_pair_overlaps(left, right):
                continue

            left_anchor_count = min(SEAM_ANCHOR_WORD_COUNT, len(left))
            right_anchor_count = min(SEAM_ANCHOR_WORD_COUNT, len(right))
            left_anchor = left[-left_anchor_count:]
            right_anchor = right[:right_anchor_count]
            seam_start_us, seam_end_us = joint_seam_alignment_range(
                left=left,
                right=right,
                left_anchor_count=left_anchor_count,
                right_anchor_count=right_anchor_count,
                duration_us=duration_us,
                context_us=SEAM_CONTEXT_US,
            )
            seam_words = [
                *(word.text for word in left_anchor),
                *(word.text for word in right_anchor),
            ]
            replacement = align_range(seam_start_us, seam_end_us, seam_words)
            repaired_left, repaired_right = replace_overlapping_segment_seam(
                left=left,
                right=right,
                replacement=replacement,
                left_anchor_count=left_anchor_count,
                right_anchor_count=right_anchor_count,
            )
            aligned_segments[segment_index - 1] = repaired_left
            aligned_segments[segment_index] = repaired_right
            seam_repair_count += 1

        aligned_words = [word for segment in aligned_segments for word in segment]
        aligned = alignment_words_to_dicts(aligned_words)

        _validate_result(aligned, duration_us)
        # Placed (unalignable) words carry an empty ``normalized`` and a
        # neutral score; they must not inflate the acoustic confidence.
        scored = [word for word in aligned if word["normalized"]]
        mean_score = (
            sum(float(word["score"]) for word in scored) / len(scored)
            if scored
            else 0.0
        )
        return {
            "durationUs": duration_us,
            "meanScore": mean_score,
            "model": MODEL_NAME,
            "seamRepairCount": seam_repair_count,
            "words": aligned,
        }


def _validate_result(words: list[dict[str, Any]], duration_us: int) -> None:
    previous_end_us = -1
    for word in words:
        start_us = int(word["startUs"])
        end_us = int(word["endUs"])
        if start_us < 0 or end_us > duration_us or end_us <= start_us:
            raise RuntimeError(f"Invalid aligned word range: {word!r}")
        if start_us < previous_end_us:
            raise RuntimeError(f"Aligned words overlap: {word!r}")
        previous_end_us = end_us
