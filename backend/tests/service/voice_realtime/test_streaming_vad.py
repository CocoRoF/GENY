"""Server-side streaming VAD + turn detection (onnxruntime Silero).

Covers the VAD turn detector's hysteresis/duration gating and the
session's streaming input path (PCM frames → speech_start/end →
transcribe → persona turn), with the model + heavy seams stubbed where
a GPU/live session would otherwise be required.
"""

from __future__ import annotations

import asyncio
import struct
from types import SimpleNamespace

import pytest

from service.voice_realtime.vad import StreamingTurnDetector, FRAME_SAMPLES
from service.voice_realtime.session import RealtimeVoiceSession, _pcm16_to_wav


# ── turn detector ────────────────────────────────────────────────────


def _run(det, probs):
    events = []
    for i, p in enumerate(probs):
        ev = det.process(p)
        if ev:
            events.append((i, ev.kind))
    return events


def test_turn_opens_after_min_speech():
    # frame_ms ≈ 32; min_speech 100ms → 3 sustained frames to open.
    det = StreamingTurnDetector(min_speech_ms=100, min_silence_ms=300)
    # 2 speech frames < 3-frame minimum → no turn opens.
    assert _run(det, [0.9] * 2 + [0.05] * 10) == []
    # 3 sustained frames → a turn opens.
    det2 = StreamingTurnDetector(min_speech_ms=100, min_silence_ms=300)
    events = _run(det2, [0.9] * 5 + [0.02] * 15)
    assert [k for _, k in events] == ["start", "end"]


def test_turn_open_and_close():
    det = StreamingTurnDetector(min_speech_ms=64, min_silence_ms=128)
    events = _run(det, [0.9] * 10 + [0.02] * 10)
    kinds = [k for _, k in events]
    assert kinds == ["start", "end"]


def test_hysteresis_holds_through_brief_dip():
    det = StreamingTurnDetector(
        threshold=0.5, min_speech_ms=64, min_silence_ms=200, hysteresis=0.2
    )
    # A brief dip to 0.4 (above neg-threshold 0.3) must NOT close the turn.
    probs = [0.9] * 6 + [0.4, 0.4] + [0.9] * 6 + [0.01] * 12
    events = _run(det, probs)
    kinds = [k for _, k in events]
    assert kinds == ["start", "end"]
    # Exactly one start and one end — the dip didn't spuriously close.
    assert kinds.count("start") == 1


def test_reset_turn_clears_latch():
    det = StreamingTurnDetector(min_speech_ms=32, min_silence_ms=999999)
    _run(det, [0.9] * 5)
    assert det.in_speech
    det.reset_turn()
    assert not det.in_speech


def test_shared_session_but_independent_state():
    """The onnx InferenceSession is shared across streams; the per-stream LSTM
    state/context must stay independent (else multi-connection VAD corrupts)."""
    import numpy as np
    from service.voice_realtime.vad import SileroOnnx, FRAME_SAMPLES, _get_shared_session

    a, b = SileroOnnx(), SileroOnnx()
    assert a._sess is b._sess is _get_shared_session(), "session must be shared"
    rng = np.random.default_rng(3)
    for _ in range(8):
        a(rng.standard_normal(FRAME_SAMPLES).astype(np.float32) * 0.2)
    assert not np.array_equal(a._state, b._state), "streams must not share state"


@pytest.mark.asyncio
async def test_oversized_frame_is_bounded_not_blocking(monkeypatch):
    """A single huge binary frame must be capped (not processed frame-by-frame
    for seconds) so it can't stall the event loop."""
    from service.voice_realtime.session import RealtimeVoiceSession
    from service.voice_realtime.vad import SAMPLE_RATE

    async def emit(t, d):
        pass

    voice = RealtimeVoiceSession("sid", emit)
    voice.configure(input_mode="server_vad")
    # 10 s of silence = 320 KB — far over the ~4 s cap.
    big = b"\x00\x00" * (SAMPLE_RATE * 10)
    await voice.on_audio_frame(big)
    # Backlog was trimmed to the cap and fully consumed → tiny remainder.
    assert len(voice._pcm_tail) < 1024


# ── WAV wrapping ─────────────────────────────────────────────────────


def test_pcm16_to_wav_header():
    pcm = b"\x00\x01" * 800  # 1600 bytes
    wav = _pcm16_to_wav(pcm, sample_rate=16000)
    assert wav[:4] == b"RIFF"
    assert wav[8:12] == b"WAVE"
    assert wav.endswith(pcm)
    # data chunk size field == len(pcm)
    data_idx = wav.index(b"data")
    (size,) = struct.unpack("<I", wav[data_idx + 4 : data_idx + 8])
    assert size == len(pcm)


# ── session streaming input ──────────────────────────────────────────


class _ScriptedVad:
    """Returns scripted probabilities so we drive turn detection
    deterministically without the real model."""

    def __init__(self, probs):
        self._probs = probs
        self._i = 0

    def __call__(self, frame_f32):
        p = self._probs[min(self._i, len(self._probs) - 1)]
        self._i += 1
        return p


@pytest.mark.asyncio
async def test_streaming_input_fires_turn_on_end_of_speech(monkeypatch):
    events = []

    async def emit(t, d):
        events.append((t, d))

    # Stub STT + the persona turn so we only test the VAD→turn plumbing.
    transcribed = {}

    async def fake_transcribe(self, audio_bytes, *, fmt):
        transcribed["fmt"] = fmt
        transcribed["is_wav"] = audio_bytes[:4] == b"RIFF"
        return "안녕하세요"

    turn_prompts = []

    async def fake_on_text(self, text, *, _gen=None):
        turn_prompts.append(text)

    monkeypatch.setattr(RealtimeVoiceSession, "_transcribe", fake_transcribe)
    monkeypatch.setattr(RealtimeVoiceSession, "on_text", fake_on_text)

    # stt_only=False → the session runs the persona turn itself.
    voice = RealtimeVoiceSession("sid", emit, language="ko")
    voice.configure(input_mode="server_vad", stt_only=False)

    # Inject a scripted VAD: ~10 speech frames then ~8 silence → one turn.
    from service.voice_realtime import vad as vadmod
    monkeypatch.setattr(voice, "_vad", _ScriptedVad([0.9] * 10 + [0.02] * 20))
    voice._turn_detector = vadmod.StreamingTurnDetector(
        min_speech_ms=64, min_silence_ms=128
    )

    # Feed 30 frames of PCM (content irrelevant — VAD is scripted).
    frame = b"\x00\x00" * FRAME_SAMPLES
    for _ in range(30):
        await voice.on_audio_frame(frame)

    kinds = [t for t, _ in events]
    assert "speech_start" in kinds
    assert "speech_end" in kinds
    assert "transcript" in kinds
    assert transcribed.get("is_wav") is True
    assert turn_prompts == ["안녕하세요"], "end-of-speech must feed the persona turn"


@pytest.mark.asyncio
async def test_stt_only_emits_transcript_without_running_turn(monkeypatch):
    """Default stt_only mode: end-of-speech emits the final transcript but
    does NOT run the persona turn (the frontend broadcasts it to chat)."""
    events = []

    async def emit(t, d):
        events.append((t, d))

    async def fake_transcribe(self, audio_bytes, *, fmt):
        return "실시간 발화"

    turn_calls = []

    async def fake_on_text(self, text, *, _gen=None):
        turn_calls.append(text)

    monkeypatch.setattr(RealtimeVoiceSession, "_transcribe", fake_transcribe)
    monkeypatch.setattr(RealtimeVoiceSession, "on_text", fake_on_text)

    voice = RealtimeVoiceSession("sid", emit, language="ko")
    voice.configure(input_mode="server_vad", stt_only=True)
    from service.voice_realtime import vad as vadmod
    monkeypatch.setattr(voice, "_vad", _ScriptedVad([0.9] * 10 + [0.02] * 20))
    voice._turn_detector = vadmod.StreamingTurnDetector(min_speech_ms=64, min_silence_ms=128)

    frame = b"\x00\x00" * FRAME_SAMPLES
    for _ in range(30):
        await voice.on_audio_frame(frame)

    final = [d for t, d in events if t == "transcript" and d.get("final")]
    assert final and final[0]["text"] == "실시간 발화"
    assert turn_calls == [], "stt_only must NOT run the persona turn"
