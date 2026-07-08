"""Server-side streaming voice-activity detection (Silero v5, onnxruntime).

Runs the Silero VAD ONNX model with **onnxruntime + numpy only** — no
torch (the ``silero-vad`` pip package pulls in ~2 GB of torch even for
the onnx path, so we bundle just the 1.3 MB 16 kHz model and drive it
directly). CPU-only; negligible load.

Two layers:

* :class:`SileroOnnx` — stateless-per-frame model wrapper. Feed one
  512-sample float32 frame @ 16 kHz, get a speech probability, carrying
  the LSTM state across calls.
* :class:`StreamingTurnDetector` — turns per-frame probabilities into
  speech start / end events with hysteresis + minimum-duration gates,
  reimplemented from the reference ``VADIterator`` turn logic. This is
  what lets audio stream in continuously and the server decide when a
  turn is over.

The model expects 16 kHz mono; frames are 512 samples (32 ms). Callers
feed int16 PCM; conversion to float32 [-1, 1] happens here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from logging import getLogger
from typing import Optional

import numpy as np

logger = getLogger(__name__)

SAMPLE_RATE = 16000
FRAME_SAMPLES = 512           # 32 ms @ 16 kHz — Silero v5's native window
FRAME_BYTES = FRAME_SAMPLES * 2  # int16
# Silero v5 prepends the previous frame's last 64 samples as context, so the
# actual model input is 64 + 512 = 576 samples. Omitting this yields ~0
# probability on real speech (the model never sees a valid window).
_CONTEXT_SAMPLES = 64

_MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "silero_vad_16k.onnx")


class SileroOnnx:
    """Silero VAD v5 onnx model, driven with onnxruntime only.

    Stateful across frames (LSTM hidden state). One instance per audio
    stream; call :meth:`reset` between turns is optional (the detector
    handles turn state itself).
    """

    def __init__(self) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        # VAD is tiny; single-thread avoids contention with the event loop.
        self._sess = ort.InferenceSession(
            _MODEL_PATH, sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self._sr = np.array(SAMPLE_RATE, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        # v5 state: [2, batch=1, 128]; context: last 64 samples of prev frame
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, _CONTEXT_SAMPLES), dtype=np.float32)

    def __call__(self, frame_f32: np.ndarray) -> float:
        """Return speech probability [0, 1] for one 512-sample frame.

        The model input is the 64-sample context from the previous call
        prepended to this frame (→ 576 samples) — matching Silero's own
        OnnxWrapper. Without the context the model scores real speech ~0.
        """
        x = frame_f32.reshape(1, -1).astype(np.float32)
        x = np.concatenate([self._context, x], axis=1)
        out, self._state = self._sess.run(
            ["output", "stateN"],
            {"input": x, "state": self._state, "sr": self._sr},
        )
        self._context = x[:, -_CONTEXT_SAMPLES:]
        return float(out[0, 0])


@dataclass
class TurnEvent:
    """Emitted by the detector. ``kind`` is 'start' or 'end'."""

    kind: str


class StreamingTurnDetector:
    """Per-frame VAD probabilities → speech start/end turn events.

    Hysteresis + minimum durations, reimplemented from the reference
    VADIterator so streamed audio yields clean turns:

    * open a turn when speech probability stays above ``threshold`` for
      ``min_speech_ms``;
    * close it when probability stays below ``threshold - hysteresis``
      for ``min_silence_ms`` (natural inter-sentence pause);
    * ignore turns shorter than ``min_speech_ms`` (clicks / bumps).

    All thresholds are constructor args so the config layer can tune them.
    """

    def __init__(
        self,
        *,
        threshold: float = 0.5,
        min_speech_ms: int = 250,
        min_silence_ms: int = 700,
        speech_pad_ms: int = 120,
        hysteresis: float = 0.15,
    ) -> None:
        self._threshold = threshold
        self._neg_threshold = max(0.01, threshold - hysteresis)
        frame_ms = FRAME_SAMPLES / SAMPLE_RATE * 1000.0
        self._min_speech_frames = max(1, int(min_speech_ms / frame_ms))
        self._min_silence_frames = max(1, int(min_silence_ms / frame_ms))
        self._pad_frames = max(0, int(speech_pad_ms / frame_ms))

        self._triggered = False        # inside an open turn
        self._speech_run = 0           # consecutive above-threshold frames (pre-trigger)
        self._silence_run = 0          # consecutive below-neg-threshold frames (in-turn)

    def process(self, prob: float) -> Optional[TurnEvent]:
        """Feed one frame's speech probability; maybe return a TurnEvent."""
        if not self._triggered:
            if prob >= self._threshold:
                self._speech_run += 1
                if self._speech_run >= self._min_speech_frames:
                    self._triggered = True
                    self._silence_run = 0
                    return TurnEvent("start")
            else:
                self._speech_run = 0
            return None

        # Triggered — watch for sustained silence to close the turn.
        if prob < self._neg_threshold:
            self._silence_run += 1
            if self._silence_run >= self._min_silence_frames:
                self._triggered = False
                self._speech_run = 0
                self._silence_run = 0
                return TurnEvent("end")
        else:
            self._silence_run = 0
        return None

    def reset_turn(self) -> None:
        """Force the detector back to the not-in-speech state (used when a
        turn is force-closed at the max-utterance cap)."""
        self._triggered = False
        self._speech_run = 0
        self._silence_run = 0

    @property
    def in_speech(self) -> bool:
        return self._triggered

    @property
    def pad_frames(self) -> int:
        """Frames of audio to keep before the trigger point (so the turn
        buffer doesn't clip the leading consonant)."""
        return self._pad_frames


def pcm16_to_f32(pcm: bytes) -> np.ndarray:
    """int16 little-endian PCM bytes → float32 [-1, 1] samples."""
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
