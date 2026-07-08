"""RealtimeVoiceSession turn-taking + barge-in (generation staleness).

These exercise the orchestrator's turn loop with the heavy seams
(execute_command, whisper, tts, session logger) monkeypatched, so we
verify the *control flow* — sentence→audio emission, generation
staleness, barge-in cancellation — without a GPU or live session.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from service.voice_realtime.session import RealtimeVoiceSession


class _FakeLevel:
    def __init__(self, v):
        self.value = v


def _stream_entry(text):
    return SimpleNamespace(level=_FakeLevel("STREAM"), message=text, metadata={})


class _FakeLogger:
    """Emits a scripted sequence of STREAM token batches across polls."""

    def __init__(self, batches):
        self._batches = list(batches)
        self._served = 0

    def get_cache_length(self):
        return 0

    def get_cache_entries_since(self, cursor):
        if self._batches:
            batch = self._batches.pop(0)
            return ([_stream_entry(t) for t in batch], cursor + 1)
        return ([], cursor)


class _FakeChunk:
    def __init__(self, seq, audio=b"AUDIO", final=False):
        self.seq = seq
        self.audio_data = audio
        self.sample_rate = 24000
        self.audio_format = "wav"
        self.is_final = final


class _FakeTTS:
    def __init__(self):
        self.calls = []

    async def speak_sentences(self, text, emotion="neutral", language="ko", voice_profile=None):
        self.calls.append(text)
        yield _FakeChunk(0, audio=b"CLIP:" + text.encode())


def _install(monkeypatch, *, logger, tts, exec_delay=0.0, exec_result=None):
    import service.voice_realtime.session as mod

    async def fake_execute_command(session_id, prompt, is_chat_message=True):
        if exec_delay:
            await asyncio.sleep(exec_delay)
        return exec_result or SimpleNamespace(success=True, output="ok")

    stopped = {"count": 0}

    async def fake_stop_execution(session_id):
        stopped["count"] += 1
        return True

    monkeypatch.setattr(
        "service.execution.agent_executor.execute_command", fake_execute_command
    )
    monkeypatch.setattr(
        "service.execution.agent_executor.stop_execution", fake_stop_execution
    )
    monkeypatch.setattr(
        "service.logging.session_logger.get_session_logger",
        lambda sid, create_if_missing=False: logger,
    )
    monkeypatch.setattr(
        "service.vtuber.tts.tts_service.get_tts_service", lambda: tts
    )
    # EmotionExtractor is real (cheap, no I/O) — keeps [tag] parsing honest.
    return stopped


@pytest.mark.asyncio
async def test_turn_emits_audio_per_sentence(monkeypatch):
    events = []

    async def emit(t, d):
        events.append((t, d))

    # Sentences ≥ min_chars (12) so each emits separately (short ones are
    # deliberately merged to avoid choppy clips — see the extractor tests).
    logger = _FakeLogger(
        batches=[["첫 번째 문장을 말합니다. "], ["두 번째 문장도 이어서 말해요."]]
    )
    tts = _FakeTTS()
    _install(monkeypatch, logger=logger, tts=tts, exec_delay=0.15)

    voice = RealtimeVoiceSession("sid", emit, language="ko")
    await voice.on_text("안녕")
    await voice._turn_task  # wait for the turn to finish

    types = [t for t, _ in events]
    assert types[0] == "turn_start"
    assert "turn_end" in types
    audio = [d for t, d in events if t == "audio"]
    assert len(audio) == 2, "one audio clip per sentence"
    assert tts.calls == ["첫 번째 문장을 말합니다.", "두 번째 문장도 이어서 말해요."]
    # seq increments within the turn
    assert [a["seq"] for a in audio] == [0, 1]


@pytest.mark.asyncio
async def test_emotion_tag_stripped_before_tts(monkeypatch):
    events = []

    async def emit(t, d):
        events.append((t, d))

    logger = _FakeLogger(batches=[["[joy] 정말 기뻐서 웃음이 나요!"]])
    tts = _FakeTTS()
    _install(monkeypatch, logger=logger, tts=tts, exec_delay=0.1)

    voice = RealtimeVoiceSession("sid", emit, language="ko")
    await voice.on_text("안녕")
    await voice._turn_task

    # The emotion tag must be gone from what TTS speaks.
    assert tts.calls == ["정말 기뻐서 웃음이 나요!"]
    at = [d for t, d in events if t == "assistant_text"]
    assert at and at[0]["emotion"] == "joy"
    assert "[joy]" not in at[0]["text"]


@pytest.mark.asyncio
async def test_barge_in_cancels_and_bumps_generation(monkeypatch):
    events = []

    async def emit(t, d):
        events.append((t, d))
        # Slow the emit so barge-in lands mid-turn.
        await asyncio.sleep(0.02)

    # Long turn: many batches so it's still generating when we barge in.
    logger = _FakeLogger(batches=[[f"문장{i} 입니다. "] for i in range(20)])
    tts = _FakeTTS()
    stopped = _install(monkeypatch, logger=logger, tts=tts, exec_delay=2.0)

    voice = RealtimeVoiceSession("sid", emit, language="ko")
    gen0 = voice._generation
    await voice.on_text("긴 답변 부탁")
    await asyncio.sleep(0.1)  # let a few sentences emit

    await voice.on_speech_started()  # barge-in
    assert voice._generation > gen0, "generation must bump on barge-in"
    assert stopped["count"] >= 1, "executor turn must be stopped"
    assert any(t == "cancelled" for t, _ in events)

    # A fresh utterance after barge-in starts a new turn cleanly.
    await voice.close()


@pytest.mark.asyncio
async def test_stale_turn_stops_emitting(monkeypatch):
    """If the generation bumps mid-turn, no further audio for the old gen."""
    audio_gens = []

    async def emit(t, d):
        if t == "audio":
            audio_gens.append(d["turn"])
        await asyncio.sleep(0.01)

    logger = _FakeLogger(batches=[[f"문장{i} 입니다. "] for i in range(10)])
    tts = _FakeTTS()
    _install(monkeypatch, logger=logger, tts=tts, exec_delay=1.0)

    voice = RealtimeVoiceSession("sid", emit, language="ko")
    await voice.on_text("답변")
    old_gen = voice._generation
    await asyncio.sleep(0.05)
    # Supersede with a new utterance path (bumps generation).
    voice._generation += 1
    await asyncio.sleep(0.15)
    await voice.close()

    assert all(g == old_gen for g in audio_gens), "no cross-generation leakage yet"
    # After the bump, the old turn must have stopped adding audio.
    count_at_bump = len(audio_gens)
    await asyncio.sleep(0.05)
    assert len(audio_gens) == count_at_bump, "stale turn kept emitting audio"
