"""Bounded reads of the canonical PCM WAV, retaining source-time coordinates."""
import urllib.request

SAMPLE_RATE = 16_000
MAX_BYTES = 100 * 1024 * 1024
MAX_RANGE_US = 180_000_000


def validate_metadata(metadata: dict[str, int]) -> None:
    offset, length, duration = (metadata[k] for k in ("dataOffset", "dataLength", "durationUs"))
    if any(type(v) is not int for v in (offset, length, duration)):
        raise ValueError("WAV metadata must be integers.")
    if offset < 12 or length < 2 or length % 2 or offset + length > MAX_BYTES:
        raise ValueError("Invalid WAV data bounds.")
    if duration != length * 1_000_000 // (SAMPLE_RATE * 2):
        raise ValueError("WAV duration disagrees with sample count.")


def read_pcm_range(url: str, metadata: dict[str, int], start_us: int, end_us: int) -> bytes:
    validate_metadata(metadata)
    if start_us < 0 or end_us > metadata["durationUs"] or not 0 < end_us - start_us <= MAX_RANGE_US:
        raise ValueError("Invalid alignment window.")
    # Match JS Math.round for nonnegative sample positions.
    start = (start_us * SAMPLE_RATE + 500_000) // 1_000_000
    end = (end_us * SAMPLE_RATE + 500_000) // 1_000_000
    offset = metadata["dataOffset"] + start * 2
    length = (end - start) * 2
    if length <= 0 or offset + length > metadata["dataOffset"] + metadata["dataLength"]:
        raise ValueError("Invalid PCM byte range.")
    request = urllib.request.Request(url, headers={
        "Range": f"bytes={offset}-{offset + length - 1}",
        "User-Agent": "Compound-Wav2Vec-Aligner/1.0",
    })
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.status != 206 or int(response.headers.get("Content-Length", "-1")) != length:
            raise ValueError("Audio server did not return a bounded PCM range.")
        content_range = response.headers.get("Content-Range", "")
        if not content_range.startswith(f"bytes {offset}-{offset + length - 1}/"):
            raise ValueError("Audio server returned the wrong PCM range.")
        pcm = response.read(length + 1)
    if len(pcm) != length:
        raise ValueError("PCM range was truncated.")
    return pcm
