"""Tests for the V3 screen-observation trigger.

Covers the public ``save_and_maybe_trigger`` path: image persistence,
caption short-circuit when vision is unavailable, per-session
cooldown gating, and the ``force_trigger`` override used by the
"Show Now" button.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Optional

import pytest


@pytest.fixture(autouse=True)
def _reset_cooldown_state() -> None:
    from service.vtuber.screen_observation import reset_cooldown_state_for_tests
    reset_cooldown_state_for_tests()


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _install_session_storage(
    monkeypatch: pytest.MonkeyPatch,
    *,
    storage_root: Optional[Path],
) -> None:
    """Patch the agent-session lookup so tests can pin the storage
    path without spinning up an executor."""
    from service.vtuber import screen_observation as so

    def _resolve(_session_id: str) -> Optional[Path]:
        return storage_root

    monkeypatch.setattr(so, "_resolve_session_storage", _resolve)


def _install_caption(
    monkeypatch: pytest.MonkeyPatch,
    *,
    caption: str = "User is editing a Python file in VSCode.",
    source: str = "vision",
) -> None:
    """Stub the vision-LLM caption helper."""
    from service.vtuber import screen_observation as so

    async def _stub(image_bytes: bytes, *, mime_type: str):
        return (caption, source)

    monkeypatch.setattr(so, "_caption_image", _stub)


def _install_trigger_recorder(
    monkeypatch: pytest.MonkeyPatch,
) -> list[dict]:
    """Capture ``_run_trigger`` invocations without actually hitting
    ``execute_command``."""
    from service.vtuber import screen_observation as so

    fired: list[dict] = []

    async def _stub(**kwargs):
        fired.append(kwargs)

    monkeypatch.setattr(so, "_run_trigger", _stub)
    return fired


# ── save_and_maybe_trigger ────────────────────────────────────────────


def test_save_writes_image_and_note(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber.screen_observation import save_and_maybe_trigger

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch)
    _install_trigger_recorder(monkeypatch)

    result = _run(
        save_and_maybe_trigger(
            session_id="sess-1",
            image_bytes=b"\x89PNG\r\n\x1a\nfakebytes",
            mime_type="image/png",
        )
    )

    assert result.image_path is not None
    assert result.note_path is not None
    img = Path(result.image_path)
    note = Path(result.note_path)
    assert img.exists() and img.suffix == ".png"
    assert note.exists()
    body = note.read_text(encoding="utf-8")
    assert "category: \"observations\"" in body
    assert "Auto-caption" in body
    assert "User is editing a Python file" in body
    # The image is referenced by wikilink so the VTuber's memory
    # tools can resolve it via the same convention user-opsidian
    # notes use.
    assert f"![[{img.name}]]" in body


def test_session_not_found_short_circuits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber.screen_observation import save_and_maybe_trigger

    _install_session_storage(monkeypatch, storage_root=None)
    _install_caption(monkeypatch)
    fired = _install_trigger_recorder(monkeypatch)

    result = _run(
        save_and_maybe_trigger(
            session_id="ghost",
            image_bytes=b"FAKE",
            mime_type="image/png",
        )
    )

    assert result.skipped_reason == "session_not_found"
    assert result.image_path is None
    assert fired == []


def test_empty_image_short_circuits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber.screen_observation import save_and_maybe_trigger

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch)
    fired = _install_trigger_recorder(monkeypatch)

    result = _run(
        save_and_maybe_trigger(
            session_id="sess-1",
            image_bytes=b"",
            mime_type="image/png",
        )
    )

    assert result.skipped_reason == "empty_image"
    assert fired == []


def test_no_caption_skips_trigger_but_keeps_image(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Vision LLM returned no caption (no vision provider configured
    or LLM rejected the image). The image still lands on disk so a
    later "list observations" tool can show it — but the trigger
    must not fire because we have no real content for the persona
    to react to."""
    from service.vtuber.screen_observation import save_and_maybe_trigger

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="", source="placeholder")
    fired = _install_trigger_recorder(monkeypatch)

    result = _run(
        save_and_maybe_trigger(
            session_id="sess-1",
            image_bytes=b"FAKE",
            mime_type="image/png",
        )
    )

    assert result.image_path is not None
    assert Path(result.image_path).exists()
    assert result.trigger_fired is False
    assert result.skipped_reason == "no_real_caption"
    assert fired == []


def test_cooldown_blocks_consecutive_triggers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber.screen_observation import save_and_maybe_trigger

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="working on code")
    fired = _install_trigger_recorder(monkeypatch)

    first = _run(
        save_and_maybe_trigger(
            session_id="sess-1",
            image_bytes=b"FRAME1",
            mime_type="image/png",
        )
    )
    second = _run(
        save_and_maybe_trigger(
            session_id="sess-1",
            image_bytes=b"FRAME2",
            mime_type="image/png",
        )
    )

    assert first.trigger_fired is True
    assert second.trigger_fired is False
    assert second.skipped_reason == "cooldown"
    # Second frame still landed on disk — only the trigger was
    # skipped.
    assert second.image_path is not None
    assert Path(second.image_path).exists()
    assert len(fired) == 1


def test_force_trigger_bypasses_cooldown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The frontend "Show Now" button uses ``force_trigger=True`` so
    a deliberate user click is never swallowed by a cooldown that
    happens to be active."""
    from service.vtuber.screen_observation import save_and_maybe_trigger

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="working on code")
    fired = _install_trigger_recorder(monkeypatch)

    _run(
        save_and_maybe_trigger(
            session_id="sess-1",
            image_bytes=b"FRAME1",
            mime_type="image/png",
        )
    )
    forced = _run(
        save_and_maybe_trigger(
            session_id="sess-1",
            image_bytes=b"FRAME2",
            mime_type="image/png",
            force_trigger=True,
        )
    )

    assert forced.trigger_fired is True
    assert len(fired) == 2


def test_different_sessions_have_independent_cooldowns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber.screen_observation import save_and_maybe_trigger

    alice = tmp_path / "alice"
    bob = tmp_path / "bob"
    alice.mkdir()
    bob.mkdir()

    from service.vtuber import screen_observation as so

    def _resolve(session_id: str) -> Optional[Path]:
        return {"alice": alice, "bob": bob}.get(session_id)

    monkeypatch.setattr(so, "_resolve_session_storage", _resolve)
    _install_caption(monkeypatch, caption="working")
    fired = _install_trigger_recorder(monkeypatch)

    _run(save_and_maybe_trigger(
        session_id="alice", image_bytes=b"a1", mime_type="image/png",
    ))
    _run(save_and_maybe_trigger(
        session_id="bob", image_bytes=b"b1", mime_type="image/png",
    ))

    # Both fire — they're in different sessions.
    assert len(fired) == 2


def test_trigger_error_releases_slot_for_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If ``_run_trigger`` itself blows up (executor offline, etc.),
    the cooldown slot must be released so the next 3-min capture
    can try again — otherwise a single failure silences the persona
    for the full 10-min window."""
    from service.vtuber.screen_observation import save_and_maybe_trigger
    from service.vtuber import screen_observation as so

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="working")

    call_count = {"n": 0}

    async def _flaky(**kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("executor offline")

    monkeypatch.setattr(so, "_run_trigger", _flaky)

    first = _run(
        save_and_maybe_trigger(
            session_id="sess-1",
            image_bytes=b"FRAME1",
            mime_type="image/png",
        )
    )
    second = _run(
        save_and_maybe_trigger(
            session_id="sess-1",
            image_bytes=b"FRAME2",
            mime_type="image/png",
        )
    )

    assert first.trigger_fired is False
    assert first.skipped_reason == "trigger_error"
    # Slot was released → second attempt is allowed to try.
    assert second.trigger_fired is True


# ── Compose prompt sanity ─────────────────────────────────────────────


def test_prompt_includes_silent_token_instruction() -> None:
    """The persona must be told it can return ``[SILENT]`` to skip
    the chat insert. Without this guidance the model produces
    awkward filler ("nothing to comment on") that still hits the
    chat room."""
    from datetime import datetime, timezone
    from service.vtuber.screen_observation import _compose_prompt

    prompt = _compose_prompt(
        caption="vscode editing python",
        observation_id="obs-1",
        captured_at=datetime.now(timezone.utc),
    )
    assert "[USER_OBSERVATION]" in prompt
    assert "[SILENT]" in prompt
    # And the payload carries the share_source the skill / telemetry
    # branches on.
    assert "vtuber_screen_observation" in prompt


def test_prompt_mentions_sensitive_content_guard() -> None:
    from datetime import datetime, timezone
    from service.vtuber.screen_observation import _compose_prompt

    prompt = _compose_prompt(
        caption="x", observation_id="o",
        captured_at=datetime.now(timezone.utc),
    )
    # Korean prompt asks the persona to skip sensitive text (password
    # / API key / private messages). Without this the persona could
    # repeat secrets it saw on the screen.
    assert "비밀번호" in prompt or "민감" in prompt


# ── Sanitiser interaction ─────────────────────────────────────────────


def test_silent_token_collapses_to_empty_via_sanitizer() -> None:
    """Confirm the existing display sanitiser already strips
    ``[SILENT]`` so the chat-insert guard short-circuits naturally —
    we rely on this in ``_save_trigger_response_to_chat``."""
    from service.utils.text_sanitizer import sanitize_for_display

    assert sanitize_for_display("[SILENT]") == ""
    assert sanitize_for_display("[SILENT]  ") == ""
    assert sanitize_for_display("[silent]") == ""
    # And longer responses lose the leading token too:
    assert sanitize_for_display("[SILENT] just kidding") == "just kidding"
