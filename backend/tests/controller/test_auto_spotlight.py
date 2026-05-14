"""Tests for the ``auto_spotlight`` capture-upload path.

The endpoint itself is a thin FastAPI wrapper; what's interesting
is :func:`_auto_spotlight_for_event` — it awaits the post-capture
hook synchronously *before* building the spotlight item so the
excerpt picks up the transcript line the hook prepends.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional

import pytest


def _make_event(
    *, capture_id: str = "cap-1", username: str = "alice",
    source: str = "vtuber_stt_stream",
) -> "CaptureEvent":
    from service.whiteboard.types import CaptureEvent, CapturePayload

    return CaptureEvent(
        capture_id=capture_id,
        type="audio",
        source=source,
        payload=CapturePayload(attachment_path="_attachments/voice.webm"),
        user_id=username,
    )


@pytest.fixture(autouse=True)
def _reset_spotlight_store() -> None:
    """Clear the in-memory spotlight store between tests so items
    don't leak across cases (the singleton is process-wide)."""
    from service.whiteboard.spotlight_store import get_spotlight_store
    store = get_spotlight_store()
    if hasattr(store, "_items"):
        store._items.clear()


def _stub_excerpt_from_note(
    monkeypatch: pytest.MonkeyPatch,
    *,
    title: str,
    excerpt: str,
    attachments: Optional[list[str]] = None,
) -> None:
    from controller import whiteboard_controller as wc

    def _stub(_username: str, _filename: str, _kind: str):
        return (title, excerpt, attachments or [])

    monkeypatch.setattr(wc, "_excerpt_from_note", _stub)


def _stub_dispatch_post_capture(
    monkeypatch: pytest.MonkeyPatch,
    *,
    side_effect: Optional[Any] = None,
) -> dict:
    """Stub the post-capture hook dispatcher; records call order."""
    from service.whiteboard import post_capture_hook as pch

    call_order: dict[str, list] = {"calls": []}

    async def _stub(event, draft_filename):
        call_order["calls"].append((event.capture_id, draft_filename))
        if side_effect is not None:
            if isinstance(side_effect, Exception):
                raise side_effect
            return side_effect
        return {"source": "whisper", "text_len": 12}

    monkeypatch.setattr(pch, "dispatch_post_capture", _stub)
    return call_order


def _stub_user_shared_trigger(monkeypatch: pytest.MonkeyPatch) -> list:
    """Stub the trigger fire so we don't recursively launch real agents."""
    from service.whiteboard import user_shared_trigger as ust
    fired: list = []
    monkeypatch.setattr(
        ust, "fire_user_shared_trigger_async",
        lambda item: fired.append(item),
    )
    return fired


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── Tests ────────────────────────────────────────────────────────────


def test_auto_spotlight_awaits_hook_before_reading_note(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The transcript must be on the note before the excerpt is
    sampled. Confirmed by ordering: hook gets called first, then
    ``_excerpt_from_note`` is invoked."""
    from controller.whiteboard_controller import _auto_spotlight_for_event

    order: list[str] = []
    calls = _stub_dispatch_post_capture(monkeypatch)

    # Override the dispatch stub to log into the shared order list.
    # Return a successful audit (whisper + non-empty text) so the
    # auto-spotlight flow proceeds to the excerpt read — the only
    # thing we're asserting here is *ordering*, not the prune
    # semantics added later.
    from service.whiteboard import post_capture_hook as pch

    async def _hook(event, _filename):
        order.append("hook")
        calls["calls"].append(event.capture_id)
        return {"source": "whisper", "text_len": 12}

    monkeypatch.setattr(pch, "dispatch_post_capture", _hook)

    from controller import whiteboard_controller as wc

    def _excerpt(_user, _file, _kind):
        order.append("excerpt")
        return (
            "Audio memo 2026-05-13",
            "> **Transcript (en):** hello world\n\n",
            ["voice.webm"],
        )

    monkeypatch.setattr(wc, "_excerpt_from_note", _excerpt)
    _stub_user_shared_trigger(monkeypatch)

    item_id = _run(
        _auto_spotlight_for_event(
            username="alice",
            session_id="sess-1",
            event=_make_event(),
            draft_note_filename="inbox/audio-1.md",
        )
    )

    assert order == ["hook", "excerpt"], (
        "hook must run BEFORE the excerpt is sampled so the "
        "transcript ends up in the spotlight"
    )
    assert item_id  # spotlight item created


def test_auto_spotlight_returns_none_without_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No session → no agent to deliver USER_SHARED to. The hook
    still runs (transcript still lands on the note) but no spotlight
    item is created and no trigger fires."""
    from controller.whiteboard_controller import _auto_spotlight_for_event

    hook_calls = _stub_dispatch_post_capture(monkeypatch)
    _stub_excerpt_from_note(
        monkeypatch, title="t", excerpt="x", attachments=[],
    )
    fired = _stub_user_shared_trigger(monkeypatch)

    item_id = _run(
        _auto_spotlight_for_event(
            username="alice",
            session_id=None,  # no session
            event=_make_event(),
            draft_note_filename="inbox/audio-1.md",
        )
    )

    assert item_id is None
    assert len(hook_calls["calls"]) == 1  # hook ran
    assert fired == []  # no trigger


def test_auto_spotlight_skips_when_hook_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A raising hook (e.g. Whisper service blip mid-dispatch) means
    we have no transcript guarantee — skip the trigger rather than
    bother the VTuber with a no-content "what did you say?" reply.

    Previously this flow fell back to a no-transcript spotlight,
    but the user's feedback (mid-2026-05-14) is that empty / noise
    captures should never reach the persona.
    """
    from controller.whiteboard_controller import _auto_spotlight_for_event

    _stub_dispatch_post_capture(
        monkeypatch, side_effect=RuntimeError("whisper down")
    )
    fired = _stub_user_shared_trigger(monkeypatch)

    item_id = _run(
        _auto_spotlight_for_event(
            username="alice",
            session_id="sess-1",
            event=_make_event(),
            draft_note_filename="inbox/audio-1.md",
        )
    )

    assert item_id is None
    assert fired == []


def test_auto_spotlight_skips_when_hook_pruned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the post-capture hook pruned the note as noise, we MUST
    NOT create a spotlight item — the VTuber should never react to
    a deleted "uh" / "음" / silence capture."""
    from controller.whiteboard_controller import _auto_spotlight_for_event
    from service.whiteboard.spotlight_store import get_spotlight_store

    _stub_dispatch_post_capture(
        monkeypatch,
        side_effect={
            "source": "whisper",
            "language": "en",
            "text_len": 2,
            "pruned": True,
            "prune_reason": "noise_transcript",
        },
    )
    excerpt_called = {"hit": False}

    def _stub(_u, _f, _k):
        excerpt_called["hit"] = True
        return ("t", "x", [])

    from controller import whiteboard_controller as wc
    monkeypatch.setattr(wc, "_excerpt_from_note", _stub)
    fired = _stub_user_shared_trigger(monkeypatch)

    item_id = _run(
        _auto_spotlight_for_event(
            username="alice",
            session_id="sess-1",
            event=_make_event(),
            draft_note_filename="inbox/audio-1.md",
        )
    )

    assert item_id is None
    assert excerpt_called["hit"] is False
    assert fired == []
    assert get_spotlight_store().list(
        user_id="alice", session_id="sess-1",
    ) == []


def test_auto_spotlight_skips_when_whisper_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``source != "whisper"`` (unavailable / disabled / not_found)
    means there's no transcript for the VTuber to react to — skip."""
    from controller.whiteboard_controller import _auto_spotlight_for_event

    _stub_dispatch_post_capture(
        monkeypatch,
        side_effect={
            "source": "unavailable",
            "text_len": 0,
            "error": "connect refused",
        },
    )
    fired = _stub_user_shared_trigger(monkeypatch)

    item_id = _run(
        _auto_spotlight_for_event(
            username="alice",
            session_id="sess-1",
            event=_make_event(),
            draft_note_filename="inbox/audio-1.md",
        )
    )

    assert item_id is None
    assert fired == []


def test_auto_spotlight_skips_on_empty_transcript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Whisper sometimes returns ``source="whisper"`` with an empty
    string (silence). Don't bother the VTuber with a blank note."""
    from controller.whiteboard_controller import _auto_spotlight_for_event

    _stub_dispatch_post_capture(
        monkeypatch,
        side_effect={"source": "whisper", "text_len": 0},
    )
    fired = _stub_user_shared_trigger(monkeypatch)

    item_id = _run(
        _auto_spotlight_for_event(
            username="alice",
            session_id="sess-1",
            event=_make_event(),
            draft_note_filename="inbox/audio-1.md",
        )
    )

    assert item_id is None
    assert fired == []


def test_auto_spotlight_skips_when_dispatch_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Hook not registered or dispatch swallowed an error → returns
    None. Without an audit signal we don't know the transcript
    quality, so skip rather than fire on an unknown."""
    from controller.whiteboard_controller import _auto_spotlight_for_event
    from service.whiteboard import post_capture_hook as pch

    async def _stub(_e, _f):
        return None

    monkeypatch.setattr(pch, "dispatch_post_capture", _stub)
    fired = _stub_user_shared_trigger(monkeypatch)

    item_id = _run(
        _auto_spotlight_for_event(
            username="alice",
            session_id="sess-1",
            event=_make_event(),
            draft_note_filename="inbox/audio-1.md",
        )
    )

    assert item_id is None
    assert fired == []


def test_auto_spotlight_defence_in_depth_rejects_filler_excerpt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Even when the audit reported ``text_len > 0``, the excerpt
    re-read happens AFTER the hook so it should still trip the noise
    check on the actual body content (e.g. a "uh" transcript that
    somehow slipped past the hook's prune)."""
    from controller.whiteboard_controller import _auto_spotlight_for_event

    _stub_dispatch_post_capture(
        monkeypatch,
        side_effect={"source": "whisper", "text_len": 2},
    )
    from controller import whiteboard_controller as wc

    def _stub(_u, _f, _k):
        return ("Audio memo", "> **Transcript (auto):** uh\n\n", [])

    monkeypatch.setattr(wc, "_excerpt_from_note", _stub)
    fired = _stub_user_shared_trigger(monkeypatch)

    item_id = _run(
        _auto_spotlight_for_event(
            username="alice",
            session_id="sess-1",
            event=_make_event(),
            draft_note_filename="inbox/audio-1.md",
        )
    )

    assert item_id is None
    assert fired == []


def test_auto_spotlight_records_source_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Items added via this path carry ``metadata.source='vtuber_stt_stream'``
    so downstream telemetry and the whiteboard-voice-notes skill can
    distinguish auto-streamed utterances from manual mic recordings."""
    from controller.whiteboard_controller import _auto_spotlight_for_event
    from service.whiteboard.spotlight_store import get_spotlight_store

    _stub_dispatch_post_capture(monkeypatch)
    _stub_excerpt_from_note(
        monkeypatch, title="t", excerpt="> **Transcript (ko):** 안녕",
    )
    _stub_user_shared_trigger(monkeypatch)

    item_id = _run(
        _auto_spotlight_for_event(
            username="alice",
            session_id="sess-1",
            event=_make_event(source="vtuber_stt_stream"),
            draft_note_filename="inbox/audio-1.md",
        )
    )

    store = get_spotlight_store()
    items = store.list(user_id="alice", session_id="sess-1")
    assert len(items) == 1
    item = items[0]
    assert item.item_id == item_id
    assert item.metadata.get("source") == "vtuber_stt_stream"
    assert item.metadata.get("capture_source") == "vtuber_stt_stream"
    assert item.excerpt.startswith("> **Transcript (")
