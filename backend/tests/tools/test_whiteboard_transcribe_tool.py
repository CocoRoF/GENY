"""Tests for ``whiteboard_transcribe`` — the W4 retry/backfill surface."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, Optional

import pytest


@pytest.fixture(autouse=True)
def _reset_whisper_singleton() -> None:
    """Drop the WhisperClient singleton between tests so monkeypatched
    config / client doesn't leak across cases."""
    try:
        from service.stt.whisper_client import reset_whisper_client_for_tests
    except Exception:  # noqa: BLE001
        return
    reset_whisper_client_for_tests()


def _stub_filesystem(
    monkeypatch: pytest.MonkeyPatch,
    *,
    audio_bytes: Optional[bytes],
    resolved_path: Optional[str] = "_attachments/voice.webm",
) -> None:
    """Patch the helper-level fs accessors used by the tool."""
    from tools.custom import whiteboard_tools as wt

    monkeypatch.setattr(
        wt, "_resolve_attachment_path",
        lambda _username, *, capture_id=None, attachment_path=None: resolved_path,
    )
    monkeypatch.setattr(
        wt, "_read_attachment_bytes",
        lambda _username, _rel: audio_bytes,
    )


def _stub_whisper(
    monkeypatch: pytest.MonkeyPatch,
    *,
    text: str = "hello",
    language: Optional[str] = "en",
    duration: Optional[float] = 1.0,
    source: str = "whisper",
    error: Optional[str] = None,
) -> None:
    from service.stt import whisper_client as wc_mod
    from service.stt.whisper_client import TranscriptionResult

    # Capture the fixture values explicitly so the inner-arg shadow
    # doesn't overwrite them when the caller passes ``language=None``.
    fixture_text = text
    fixture_language = language
    fixture_duration = duration
    fixture_source = source
    fixture_error = error

    class _StubClient:
        async def atranscribe(
            self, audio_bytes: bytes, *, filename: str = "audio.webm",
            language: Optional[str] = None,
        ) -> TranscriptionResult:
            return TranscriptionResult(
                text=fixture_text,
                language=fixture_language,
                duration_seconds=fixture_duration,
                source=fixture_source,
                error=fixture_error,
            )

    monkeypatch.setattr(wc_mod, "get_whisper_client", lambda: _StubClient())


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── transcribe_attachment_async ──────────────────────────────────────


def test_transcribe_returns_whisper_text(monkeypatch: pytest.MonkeyPatch) -> None:
    from tools.custom.whiteboard_tools import transcribe_attachment_async

    _stub_filesystem(monkeypatch, audio_bytes=b"FAKEWEBM")
    _stub_whisper(monkeypatch, text="hello world", language="en", duration=2.5)
    out = _run_async(
        transcribe_attachment_async("alice", capture_id="cap-1")
    )
    assert out["text"] == "hello world"
    assert out["language"] == "en"
    assert out["duration_seconds"] == 2.5
    assert out["source"] == "whisper"
    assert out["attachment_path"] == "_attachments/voice.webm"


def test_transcribe_returns_not_found_when_unresolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tools.custom.whiteboard_tools import transcribe_attachment_async

    _stub_filesystem(monkeypatch, audio_bytes=None, resolved_path=None)
    out = _run_async(
        transcribe_attachment_async("alice", capture_id="missing")
    )
    assert out["source"] == "not_found"
    assert out["text"] == ""


def test_transcribe_rejects_non_audio_extension(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`_looks_like_audio` keeps the GPU from running Whisper on PNGs.

    The PostCaptureHook only fires on ``CaptureType=audio``, but this
    tool can be called by the agent with any attachment path — guard
    explicitly.
    """
    from tools.custom.whiteboard_tools import transcribe_attachment_async

    _stub_filesystem(
        monkeypatch,
        audio_bytes=b"\x89PNG",
        resolved_path="_attachments/screenshot.png",
    )
    out = _run_async(
        transcribe_attachment_async("alice", attachment_path="_attachments/screenshot.png")
    )
    assert out["source"] == "not_found"
    assert "doesn't look like audio" in out["reason"]


def test_transcribe_surfaces_unavailable_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tools.custom.whiteboard_tools import transcribe_attachment_async

    _stub_filesystem(monkeypatch, audio_bytes=b"FAKEWEBM")
    _stub_whisper(
        monkeypatch,
        text="",
        language=None,
        duration=None,
        source="unavailable",
        error="connect failed",
    )
    out = _run_async(
        transcribe_attachment_async("alice", capture_id="cap-1")
    )
    assert out["source"] == "unavailable"
    assert out["error"] == "connect failed"
    assert out["text"] == ""


def test_transcribe_returns_not_found_when_attachment_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tools.custom.whiteboard_tools import transcribe_attachment_async

    _stub_filesystem(
        monkeypatch,
        audio_bytes=None,
        resolved_path="_attachments/voice.webm",
    )
    out = _run_async(
        transcribe_attachment_async("alice", capture_id="cap-1")
    )
    assert out["source"] == "not_found"
    assert "unavailable" in out["reason"]


def test_transcribe_passes_language_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ``language=`` kwarg must flow into ``atranscribe`` so the
    agent can force ``ko`` / ``en`` when the user asks for one explicitly."""
    from tools.custom.whiteboard_tools import transcribe_attachment_async
    from service.stt import whisper_client as wc_mod
    from service.stt.whisper_client import TranscriptionResult

    seen: Dict[str, Any] = {}

    class _CaptureClient:
        async def atranscribe(
            self, audio_bytes: bytes, *, filename: str = "audio.webm",
            language: Optional[str] = None,
        ) -> TranscriptionResult:
            seen["language"] = language
            seen["filename"] = filename
            return TranscriptionResult(text="ok", language=language or "auto",
                                       source="whisper")

    _stub_filesystem(monkeypatch, audio_bytes=b"FAKEWEBM")
    monkeypatch.setattr(wc_mod, "get_whisper_client", lambda: _CaptureClient())

    _run_async(
        transcribe_attachment_async(
            "alice", capture_id="cap-1", language="ko",
        )
    )
    assert seen["language"] == "ko"
    assert seen["filename"] == "_attachments/voice.webm"


# ── WhiteboardTranscribeTool wrapper ─────────────────────────────────


def test_tool_arun_returns_json_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tools.custom import whiteboard_tools as wt
    from tools.custom.whiteboard_tools import WhiteboardTranscribeTool
    # Bypass the session_id → username lookup which would otherwise
    # require the runtime agent_resolver.
    monkeypatch.setattr(wt, "_resolve_username", lambda _sid: "alice")
    _stub_filesystem(monkeypatch, audio_bytes=b"FAKEWEBM")
    _stub_whisper(monkeypatch, text="hi", language="en")

    raw = _run_async(
        WhiteboardTranscribeTool().arun("sess-1", capture_id="cap-1")
    )
    payload = json.loads(raw)
    assert payload["text"] == "hi"
    assert payload["language"] == "en"
    assert payload["source"] == "whisper"
