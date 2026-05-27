"""
Reference-audio analyzer for Voice Studio Tools.

Pure-numpy: no librosa / scipy dependency. Accepts WAV bytes only; the
controller rejects other containers at the multipart boundary.

Reports the basics needed to evaluate whether a reference clip will
clone well in OmniVoice:

- duration, sample_rate, channels
- RMS in dBFS over the full clip
- silence ratio (100 ms windows under -45 dBFS)
- top-3 candidate 5–15s windows for trimming, scored by mean RMS and
  penalised for embedded silence.
"""

from __future__ import annotations

import io
import math
import wave
from dataclasses import dataclass, field
from typing import List

import numpy as np

SILENCE_DBFS = -45.0
WINDOW_MS = 100  # silence-detection grid
MIN_REF_S = 5.0
MAX_REF_S = 15.0
MAX_INPUT_BYTES = 5 * 1024 * 1024  # 5 MB


@dataclass(slots=True)
class CutWindow:
    start: float
    end: float
    rms_db: float
    silent_ratio: float

    def to_dict(self) -> dict:
        return {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "rms_db": round(self.rms_db, 2),
            "silent_ratio": round(self.silent_ratio, 3),
        }


@dataclass(slots=True)
class RefAnalysis:
    duration_seconds: float
    sample_rate: int
    channels: int
    rms_db: float
    silence_ratio: float
    suggested_windows: List[CutWindow] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "duration_seconds": round(self.duration_seconds, 3),
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "rms_db": round(self.rms_db, 2),
            "silence_ratio": round(self.silence_ratio, 3),
            "suggested_windows": [w.to_dict() for w in self.suggested_windows],
        }


def analyze_ref(wav_bytes: bytes) -> RefAnalysis:
    if not wav_bytes:
        raise ValueError("empty wav payload")
    if len(wav_bytes) > MAX_INPUT_BYTES:
        raise ValueError(f"wav too large: {len(wav_bytes)} bytes > {MAX_INPUT_BYTES}")

    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        sample_rate = wf.getframerate()
        channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sample_width not in (1, 2, 4):
        raise ValueError(f"unsupported sample width: {sample_width}")

    # Decode to float32 mono ∈ [-1, 1].
    dtype = {1: np.uint8, 2: np.int16, 4: np.int32}[sample_width]
    samples = np.frombuffer(raw, dtype=dtype)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if dtype == np.uint8:
        samples = (samples.astype(np.float32) - 128.0) / 128.0
    else:
        max_int = float(np.iinfo(dtype).max)
        samples = samples.astype(np.float32) / max_int

    duration = samples.shape[0] / sample_rate if sample_rate else 0.0
    overall_rms = float(np.sqrt(np.mean(samples ** 2))) if samples.size else 0.0
    overall_db = 20.0 * math.log10(max(overall_rms, 1e-10))

    # Silence grid.
    win_size = max(1, int(sample_rate * WINDOW_MS / 1000))
    n_windows = samples.shape[0] // win_size
    window_db: List[float] = []
    if n_windows > 0:
        trimmed = samples[: n_windows * win_size].reshape(n_windows, win_size)
        rms_per_win = np.sqrt(np.mean(trimmed ** 2, axis=1))
        for r in rms_per_win:
            window_db.append(20.0 * math.log10(max(float(r), 1e-10)))
    silence_ratio = (
        sum(1 for db in window_db if db < SILENCE_DBFS) / len(window_db)
        if window_db else 0.0
    )

    suggested = _suggested_windows(window_db, win_size, sample_rate, duration)

    return RefAnalysis(
        duration_seconds=duration,
        sample_rate=int(sample_rate),
        channels=int(channels),
        rms_db=overall_db,
        silence_ratio=silence_ratio,
        suggested_windows=suggested,
    )


def _suggested_windows(
    window_db: List[float],
    win_size: int,
    sample_rate: int,
    duration: float,
) -> List[CutWindow]:
    """Sliding 5–15s scan over the 100 ms grid; pick top-3 non-overlapping."""
    if duration < MIN_REF_S or not window_db:
        return []

    windows_per_5s = int(MIN_REF_S * 1000 / WINDOW_MS)
    windows_per_15s = int(MAX_REF_S * 1000 / WINDOW_MS)
    candidates: List[CutWindow] = []

    for length_wins in (windows_per_15s, windows_per_5s):
        if length_wins > len(window_db):
            continue
        for start_w in range(0, len(window_db) - length_wins + 1, max(1, length_wins // 5)):
            chunk = window_db[start_w : start_w + length_wins]
            silent = sum(1 for db in chunk if db < SILENCE_DBFS) / len(chunk)
            mean_db = sum(chunk) / len(chunk)
            cut = CutWindow(
                start=start_w * win_size / sample_rate,
                end=(start_w + length_wins) * win_size / sample_rate,
                rms_db=mean_db,
                silent_ratio=silent,
            )
            candidates.append(cut)

    # Score: higher RMS, less silence is better. Reject very silent windows outright.
    candidates = [c for c in candidates if c.silent_ratio < 0.55]
    candidates.sort(key=lambda c: (c.rms_db - 30.0 * c.silent_ratio), reverse=True)

    # Greedy non-overlap dedup.
    picked: List[CutWindow] = []
    for c in candidates:
        if any(not (c.end <= p.start or c.start >= p.end) for p in picked):
            continue
        picked.append(c)
        if len(picked) >= 3:
            break
    picked.sort(key=lambda c: c.start)
    return picked
