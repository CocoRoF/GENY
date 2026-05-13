"""Tests for the PostCaptureHook dispatcher."""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional

import pytest

from service.whiteboard import post_capture_hook
from service.whiteboard.post_capture_hook import (
    clear_hooks_for_tests,
    dispatch_post_capture,
    get_post_capture_hook,
    register_post_capture_hook,
)
from service.whiteboard.types import CaptureEvent, CapturePayload


def _make_event(capture_type: str = "image") -> CaptureEvent:
    return CaptureEvent(
        capture_id="cap-1",
        type=capture_type,  # type: ignore[arg-type]
        source="manual",
        payload=CapturePayload(attachment_path="_attachments/x.png"),
        user_id="alice",
    )


@pytest.fixture(autouse=True)
def _reset_hooks() -> None:
    clear_hooks_for_tests()


def test_register_replaces_previous_hook() -> None:
    async def first(event: CaptureEvent, _: str) -> Dict[str, Any]:
        return {"who": "first"}

    async def second(event: CaptureEvent, _: str) -> Dict[str, Any]:
        return {"who": "second"}

    register_post_capture_hook("image", first)
    register_post_capture_hook("image", second)

    assert get_post_capture_hook("image") is second


def test_unregister_callback_removes_only_owner() -> None:
    async def hook_a(event: CaptureEvent, _: str) -> Dict[str, Any]:
        return {"who": "a"}

    async def hook_b(event: CaptureEvent, _: str) -> Dict[str, Any]:
        return {"who": "b"}

    unregister_a = register_post_capture_hook("image", hook_a)
    register_post_capture_hook("image", hook_b)
    # `unregister_a` shouldn't blow away b — it only owns a.
    unregister_a()
    assert get_post_capture_hook("image") is hook_b


def test_dispatch_returns_none_for_unregistered_type() -> None:
    out = asyncio.new_event_loop().run_until_complete(
        dispatch_post_capture(_make_event("audio"), "x.md")
    )
    assert out is None


def test_dispatch_swallows_hook_exceptions() -> None:
    async def bad(event: CaptureEvent, _: str) -> Dict[str, Any]:
        raise RuntimeError("boom")

    register_post_capture_hook("image", bad)
    out = asyncio.new_event_loop().run_until_complete(
        dispatch_post_capture(_make_event("image"), "x.md")
    )
    assert out is None  # swallowed


def test_dispatch_returns_hook_result() -> None:
    async def fine(
        event: CaptureEvent, draft: str
    ) -> Optional[Dict[str, Any]]:
        return {"got": event.capture_id, "for": draft}

    register_post_capture_hook("screenshot", fine)
    out = asyncio.new_event_loop().run_until_complete(
        dispatch_post_capture(_make_event("screenshot"), "inbox/foo.md")
    )
    assert out == {"got": "cap-1", "for": "inbox/foo.md"}


def test_fire_and_forget_returns_none_outside_loop() -> None:
    # No running loop → no scheduling, no error.
    out = post_capture_hook.fire_and_forget(_make_event(), "x.md")
    assert out is None


# ── _transcribe_audio_hook tests ─────────────────────────────────────


class _StubMgr:
    """Stand-in for UserOpsidianManager — captures update_note calls."""

    def __init__(
        self,
        *,
        audio_bytes: Optional[bytes],
        note: Optional[Dict[str, Any]],
    ) -> None:
        self._audio = audio_bytes
        self._note = note
        self.updated_body: Optional[str] = None
        self.update_calls = 0

    def read_attachment(self, _: str) -> Optional[bytes]:
        return self._audio

    def read_note(self, _: str) -> Optional[Dict[str, Any]]:
        return self._note

    def update_note(self, filename: str, *, body: str) -> None:
        self.update_calls += 1
        self.updated_body = body
        if self._note is not None:
            self._note["body"] = body


def _audio_event() -> CaptureEvent:
    return CaptureEvent(
        capture_id="cap-audio-1",
        type="audio",
        source="microphone_record",
        payload=CapturePayload(attachment_path="_attachments/voice.webm"),
        user_id="alice",
    )


def _install_audio_hook_stubs(
    monkeypatch: pytest.MonkeyPatch,
    *,
    mgr: _StubMgr,
    result,
) -> None:
    """Wire stubs for the imports done inside ``_transcribe_audio_hook``.

    The hook does late imports, so we have to patch the *origin* modules
    rather than ``post_capture_hook``'s namespace.
    """
    from service.memory import user_opsidian as user_opsidian_mod
    from service.stt import whisper_client as wc_mod

    monkeypatch.setattr(
        user_opsidian_mod,
        "get_user_opsidian_manager",
        lambda _user: mgr,
    )

    class _StubClient:
        async def atranscribe(self, audio_bytes: bytes, *, filename: str = "audio.webm"):
            return result

    monkeypatch.setattr(wc_mod, "get_whisper_client", lambda: _StubClient())


def test_transcribe_audio_hook_prepends_block(monkeypatch: pytest.MonkeyPatch) -> None:
    from service.stt.whisper_client import TranscriptionResult
    from service.whiteboard.post_capture_hook import _transcribe_audio_hook

    note: Dict[str, Any] = {"body": "existing body\n"}
    mgr = _StubMgr(audio_bytes=b"FAKEWEBM", note=note)
    _install_audio_hook_stubs(
        monkeypatch,
        mgr=mgr,
        result=TranscriptionResult(
            text="hello world",
            language="en",
            duration_seconds=1.2,
            source="whisper",
        ),
    )

    out = asyncio.new_event_loop().run_until_complete(
        _transcribe_audio_hook(_audio_event(), "inbox/note.md")
    )

    assert mgr.update_calls == 1
    assert mgr.updated_body is not None
    assert mgr.updated_body.startswith("> **Transcript (en):** hello world\n\n")
    assert "existing body" in mgr.updated_body
    assert out is not None and out["source"] == "whisper"


def test_transcribe_audio_hook_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    from service.stt.whisper_client import TranscriptionResult
    from service.whiteboard.post_capture_hook import _transcribe_audio_hook

    note: Dict[str, Any] = {
        "body": "> **Transcript (en):** hello world\n\nexisting body\n",
    }
    mgr = _StubMgr(audio_bytes=b"FAKEWEBM", note=note)
    _install_audio_hook_stubs(
        monkeypatch,
        mgr=mgr,
        result=TranscriptionResult(
            text="hello world",
            language="en",
            source="whisper",
        ),
    )

    out = asyncio.new_event_loop().run_until_complete(
        _transcribe_audio_hook(_audio_event(), "inbox/note.md")
    )

    assert mgr.update_calls == 0  # idempotent — block already present
    assert out is not None and out.get("skipped") == "already_present"


def test_transcribe_audio_hook_noop_when_service_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.stt.whisper_client import TranscriptionResult
    from service.whiteboard.post_capture_hook import _transcribe_audio_hook

    note: Dict[str, Any] = {"body": "untouched\n"}
    mgr = _StubMgr(audio_bytes=b"FAKEWEBM", note=note)
    _install_audio_hook_stubs(
        monkeypatch,
        mgr=mgr,
        result=TranscriptionResult(
            text="",
            source="unavailable",
            error="connect failed",
        ),
    )

    out = asyncio.new_event_loop().run_until_complete(
        _transcribe_audio_hook(_audio_event(), "inbox/note.md")
    )

    assert mgr.update_calls == 0
    assert note["body"] == "untouched\n"
    assert out is not None and out["source"] == "unavailable"


def test_transcribe_audio_hook_skips_when_no_attachment() -> None:
    from service.whiteboard.post_capture_hook import _transcribe_audio_hook

    event = CaptureEvent(
        capture_id="cap-audio-2",
        type="audio",
        source="microphone_record",
        payload=CapturePayload(),  # no attachment_path
        user_id="alice",
    )
    out = asyncio.new_event_loop().run_until_complete(
        _transcribe_audio_hook(event, "inbox/note.md")
    )
    assert out is None


def test_transcribe_audio_hook_skips_when_attachment_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.stt.whisper_client import TranscriptionResult
    from service.whiteboard.post_capture_hook import _transcribe_audio_hook

    mgr = _StubMgr(audio_bytes=b"", note={"body": ""})
    _install_audio_hook_stubs(
        monkeypatch,
        mgr=mgr,
        result=TranscriptionResult(text="ignored", source="whisper"),
    )
    out = asyncio.new_event_loop().run_until_complete(
        _transcribe_audio_hook(_audio_event(), "inbox/note.md")
    )
    assert out is None
    assert mgr.update_calls == 0


def test_default_hooks_register_audio() -> None:
    """The auto-registration site must include the audio hook."""
    from service.whiteboard import post_capture_hook as pch

    clear_hooks_for_tests()
    pch.register_default_hooks()
    assert pch.get_post_capture_hook("audio") is pch._transcribe_audio_hook
    assert pch.get_post_capture_hook("image") is pch._describe_image_hook
    assert pch.get_post_capture_hook("screenshot") is pch._describe_image_hook
