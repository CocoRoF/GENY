"""Tests for the V3 screen-observation upload path.

Covers the public ``save_observation`` path: marking the session active,
ensuring the session is live, caching the latest frame, recording the
perceptual hash, and persisting the image + a recall-able memory note
when the frame changed (or ``force=True``).

This module no longer fires its own proactive trigger — screen commentary
is owned by the single thinking-trigger ``screen_observation`` category,
which reuses the cached frame + hash recorded here. So there are no
cooldown / trigger / prompt-compose tests anymore.
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


# ── save_observation ──────────────────────────────────────────────────


def test_save_writes_image_and_note(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber.screen_observation import save_observation

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch)

    result = _run(
        save_observation(
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
    from service.vtuber.screen_observation import save_observation

    _install_session_storage(monkeypatch, storage_root=None)
    _install_caption(monkeypatch)

    result = _run(
        save_observation(
            session_id="ghost",
            image_bytes=b"FAKE",
            mime_type="image/png",
        )
    )

    assert result.skipped_reason == "session_not_found"
    assert result.image_path is None


def test_empty_image_short_circuits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber.screen_observation import save_observation

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch)

    result = _run(
        save_observation(
            session_id="sess-1",
            image_bytes=b"",
            mime_type="image/png",
        )
    )

    assert result.skipped_reason == "empty_image"


def test_empty_caption_still_persists_image_and_note(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Vision LLM returned no caption (no vision provider configured or
    LLM rejected the image). The image + note still land on disk so a
    later "list observations" tool can show it — a caption that comes
    back empty/placeholder is still WRITTEN now; it does not skip."""
    from service.vtuber.screen_observation import save_observation

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="", source="placeholder")

    result = _run(
        save_observation(
            session_id="sess-1",
            image_bytes=b"FAKE",
            mime_type="image/png",
        )
    )

    assert result.image_path is not None
    assert Path(result.image_path).exists()
    assert result.note_path is not None
    assert result.trigger_fired is False
    assert result.skipped_reason is None


def test_unchanged_hash_skips_persist_force_overrides(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same ``frame_hash`` twice → the 2nd is 'unchanged' (no image
    written). ``force=True`` on the 2nd persists anyway."""
    from service.vtuber.screen_observation import save_observation

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="working on code")

    h = "0123456789abcdef"
    first = _run(save_observation(
        session_id="sess-1", image_bytes=b"F1", mime_type="image/png", frame_hash=h,
    ))
    second = _run(save_observation(
        session_id="sess-1", image_bytes=b"F2", mime_type="image/png", frame_hash=h,
    ))

    assert first.image_path is not None
    assert second.skipped_reason == "unchanged"
    assert second.image_path is None      # returned before writing

    # force=True ignores the change-gate and persists.
    forced = _run(save_observation(
        session_id="sess-1", image_bytes=b"F3", mime_type="image/png",
        frame_hash=h, force=True,
    ))
    assert forced.skipped_reason is None
    assert forced.image_path is not None
    assert Path(forced.image_path).exists()


def test_changed_hash_passes_gate_and_persists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A far-apart hash is NOT 'unchanged' — it passes the change-gate and
    the image is written."""
    from service.vtuber.screen_observation import save_observation

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="working on code")

    _run(save_observation(
        session_id="sess-1", image_bytes=b"F1", mime_type="image/png",
        frame_hash="0000000000000000",
    ))
    second = _run(save_observation(
        session_id="sess-1", image_bytes=b"F2", mime_type="image/png",
        frame_hash="ffffffffffffffff",   # 64-bit flip → very changed
    ))
    assert second.skipped_reason is None
    assert second.image_path is not None
    assert Path(second.image_path).exists()


# ── Sanitiser interaction ─────────────────────────────────────────────


def test_silent_token_collapses_to_empty_via_sanitizer() -> None:
    """Confirm the existing display sanitiser strips ``[SILENT]`` so the
    chat-insert guard short-circuits naturally."""
    from service.utils.text_sanitizer import sanitize_for_display

    assert sanitize_for_display("[SILENT]") == ""
    assert sanitize_for_display("[SILENT]  ") == ""
    assert sanitize_for_display("[silent]") == ""
    # And longer responses lose the leading token too:
    assert sanitize_for_display("[SILENT] just kidding") == "just kidding"


# ── P1: vision gating ─────────────────────────────────────────────────


class _FakeAgent:
    def __init__(self, *, model_name=None, memory_manager=None):
        self.model_name = model_name
        self.memory_manager = memory_manager
        self.storage_path = None


def _install_agent(monkeypatch, agent) -> None:
    from service.vtuber import screen_observation as so
    monkeypatch.setattr(so, "_resolve_agent", lambda _sid: agent)


# ── P2: recall-able vault recording + dedup ───────────────────────────


class _FakeMemoryManager:
    def __init__(self):
        self.calls: list[dict] = []

    async def awrite_note(self, title, content, *, category, tags,
                          importance, source, filename_override):  # noqa: ANN001
        self.calls.append({
            "title": title, "content": content, "category": category,
            "tags": list(tags), "source": source,
            "filename_override": filename_override,
        })
        return f"{category}/{filename_override}"


def test_record_note_writes_to_vault_via_manager(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from datetime import datetime, timezone
    from service.vtuber import screen_observation as so

    mm = _FakeMemoryManager()
    _install_agent(monkeypatch, _FakeAgent(memory_manager=mm))
    img = tmp_path / "f.jpg"
    img.write_bytes(b"x")

    ref = _run(so._record_observation_note(
        session_id="sess-1", image_path=img, note_path=tmp_path / "f.md",
        caption="User editing main.py", vision_source="vision",
        captured_at=datetime.now(timezone.utc), observation_id="obs-1",
    ))

    assert len(mm.calls) == 1
    call = mm.calls[0]
    assert call["category"] == "observations"
    assert "screen" in call["tags"] and "observation" in call["tags"]
    assert "![[f.jpg]]" in call["content"]
    assert "User editing main.py" in call["content"]
    assert ref == "observations/" + call["filename_override"]


def test_record_note_dedups_identical_caption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from datetime import datetime, timezone
    from service.vtuber import screen_observation as so

    mm = _FakeMemoryManager()
    _install_agent(monkeypatch, _FakeAgent(memory_manager=mm))
    img = tmp_path / "f.jpg"
    img.write_bytes(b"x")

    def _write(force=False):
        return _run(so._record_observation_note(
            session_id="sess-1", image_path=img, note_path=tmp_path / "f.md",
            caption="same caption", vision_source="vision",
            captured_at=datetime.now(timezone.utc), observation_id="o",
            force=force,
        ))

    assert _write() is not None        # first records
    assert _write() is None            # identical caption → deduped
    assert len(mm.calls) == 1
    assert _write(force=True) is not None  # force ("Show Now") bypasses dedup
    assert len(mm.calls) == 2


def test_record_note_write_failure_does_not_poison_dedup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transient write failure must NOT mark the caption as seen — the
    next identical capture has to be allowed to retry, not silently
    dropped for the rest of the session."""
    from datetime import datetime, timezone
    from service.vtuber import screen_observation as so

    class _FlakyMM:
        def __init__(self):
            self.n = 0

        async def awrite_note(self, *a, **k):  # noqa: ANN001
            self.n += 1
            if self.n == 1:
                raise RuntimeError("provider down")
            return "observations/ok.md"

    mm = _FlakyMM()
    _install_agent(monkeypatch, _FakeAgent(memory_manager=mm))
    img = tmp_path / "f.jpg"
    img.write_bytes(b"x")

    def _write():
        return _run(so._record_observation_note(
            session_id="sess-1", image_path=img, note_path=tmp_path / "f.md",
            caption="retry me", vision_source="vision",
            captured_at=datetime.now(timezone.utc), observation_id="o",
        ))

    assert _write() is None        # first write raised → not recorded
    assert _write() == "observations/ok.md"  # identical caption retried (not deduped)
    assert mm.n == 2


def test_record_note_falls_back_to_raw_sidecar_without_manager(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No live memory manager (e.g. agent still initialising) → the
    observation is still written to a raw sidecar so it's never lost."""
    from datetime import datetime, timezone
    from service.vtuber import screen_observation as so

    _install_agent(monkeypatch, None)  # no agent → no manager
    img = tmp_path / "f.jpg"
    img.write_bytes(b"x")
    note = tmp_path / "f.md"

    ref = _run(so._record_observation_note(
        session_id="sess-1", image_path=img, note_path=note,
        caption="fallback caption", vision_source="vision",
        captured_at=datetime.now(timezone.utc), observation_id="o",
    ))

    assert ref == str(note)
    assert note.exists()
    assert "fallback caption" in note.read_text(encoding="utf-8")


def test_e2e_save_records_to_vault(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Full upload path with a live (fake) memory manager records the
    observation into the recall-able vault under category=observations."""
    from service.vtuber.screen_observation import save_observation

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="terminal showing a stack trace")
    mm = _FakeMemoryManager()
    _install_agent(monkeypatch, _FakeAgent(
        model_name="claude-sonnet-4", memory_manager=mm,
    ))

    result = _run(save_observation(
        session_id="sess-1", image_bytes=b"FRAME", mime_type="image/jpeg",
    ))

    assert result.image_path is not None and Path(result.image_path).exists()
    # Image lands inside the vault so the embed resolves + retention finds it.
    assert "memory" in result.image_path and "observations" in result.image_path
    assert len(mm.calls) == 1
    assert mm.calls[0]["category"] == "observations"
    assert result.note_path == "observations/" + mm.calls[0]["filename_override"]


def test_redact_sensitive_masks_secrets_keeps_prose() -> None:
    from service.vtuber.screen_observation import _redact_sensitive

    assert "[REDACTED]" in _redact_sensitive("password: hunter2thequickbrown")
    assert "[REDACTED]" in _redact_sensitive("API_KEY=sk-abcdef0123456789ABCDEF")
    assert "[REDACTED]" in _redact_sensitive("key AKIAIOSFODNN7EXAMPLE here")
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456"
    assert "[REDACTED]" in _redact_sensitive(jwt)
    # Normal prose with short words is untouched.
    plain = "User is editing main.py in VSCode and reading the docs."
    assert _redact_sensitive(plain) == plain


def test_redaction_applied_to_caption_in_save(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A secret transcribed by the captioner must be masked before the
    caption is recorded."""
    from service.vtuber.screen_observation import save_observation

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(
        monkeypatch,
        caption="terminal shows password: hunter2theverylongsecret123",
    )

    result = _run(save_observation(
        session_id="sess-1", image_bytes=b"FRAME", mime_type="image/jpeg",
    ))

    assert "[REDACTED]" in result.caption
    assert "hunter2theverylongsecret123" not in result.caption


def test_cleanup_session_state_drops_tables() -> None:
    from service.vtuber import screen_observation as so

    so._last_caption["sess-x"] = "something"
    so._last_hash["sess-x"] = "deadbeefdeadbeef"
    so._last_comment_hash["sess-x"] = "deadbeefdeadbeef"
    so.cleanup_session_state("sess-x")
    assert "sess-x" not in so._last_caption
    assert "sess-x" not in so._last_hash
    assert "sess-x" not in so._last_comment_hash


# ── Change-gate (perceptual-hash) ─────────────────────────────────────


def test_hamming_and_invalid_input() -> None:
    from service.vtuber import screen_observation as so

    assert so._hamming("00", "00") == 0
    assert so._hamming("0f", "00") == 4           # 0x0f = 1111
    assert so._hamming("ff", "00") == 8
    assert so._hamming("zz", "00") is None        # non-hex → None (treated changed)


def test_upload_wakes_dormant_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every upload calls ensure_session_live so an observing connector
    keeps the persona alive across a backend restart (no manual re-open)."""
    from service.vtuber.screen_observation import save_observation
    from service.vtuber import screen_observation as so

    woken: list[str] = []

    async def _record(sid: str) -> None:
        woken.append(sid)

    monkeypatch.setattr(so, "_ensure_session_live", _record)
    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="working")

    _run(save_observation(
        session_id="sess-1", image_bytes=b"F", mime_type="image/png",
    ))
    assert woken == ["sess-1"]


def test_uploaded_frame_cached_and_served_even_without_caption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The HTTP-uploaded frame is cached + served as an attachment even when
    the caption LLM fails (placeholder) — this is the path the thinking-trigger
    uses to comment on the screen without depending on captions. Caption no
    longer gates persistence."""
    from service.vtuber.screen_observation import (
        save_observation, get_recent_frame_attachment, list_active_sessions,
    )
    from service.vtuber import screen_observation as so
    import base64

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="", source="placeholder")  # caption fails (like prod)
    monkeypatch.setattr(so, "_session_vision_capable", lambda _sid: True)

    _run(save_observation(session_id="s1", image_bytes=b"FRAMEBYTES", mime_type="image/jpeg"))

    assert "s1" in list_active_sessions()
    att = get_recent_frame_attachment("s1")
    assert att is not None
    assert att["kind"] == "image" and att["source"] == "screen_observation"
    assert base64.b64decode(att["data"]) == b"FRAMEBYTES"


def test_vision_capable_optimistic_for_unknown_and_alias(monkeypatch) -> None:
    """Screen obs is opt-in + default model is Claude → unknown/empty/alias
    models are treated as vision-capable (so the feature isn't silently off);
    a recognised non-vision model is still rejected; env override wins."""
    from service.vtuber import screen_observation as so

    monkeypatch.setattr(so, "_resolve_agent", lambda _sid: None)  # no live agent
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    monkeypatch.delenv("GENY_DEFAULT_MODEL", raising=False)
    monkeypatch.delenv("GENY_SCREEN_OBS_ASSUME_VISION", raising=False)

    assert so._session_vision_capable("s") is True  # empty/unknown → optimistic

    class _A:
        model_name = "sonnet"  # bare alias is_vision_capable misses
    monkeypatch.setattr(so, "_resolve_agent", lambda _sid: _A())
    assert so._session_vision_capable("s") is True

    class _B:
        model_name = "some-local-text-only"  # recognised non-vision → rejected
    monkeypatch.setattr(so, "_resolve_agent", lambda _sid: _B())
    assert so._session_vision_capable("s") is False

    monkeypatch.setenv("GENY_SCREEN_OBS_ASSUME_VISION", "0")  # override forces off
    monkeypatch.setattr(so, "_resolve_agent", lambda _sid: None)
    assert so._session_vision_capable("s") is False


def test_recent_frame_none_for_non_vision_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber.screen_observation import save_observation, get_recent_frame_attachment
    from service.vtuber import screen_observation as so

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="x")
    monkeypatch.setattr(so, "_session_vision_capable", lambda _sid: False)

    _run(save_observation(session_id="s2", image_bytes=b"F", mime_type="image/jpeg"))
    assert get_recent_frame_attachment("s2") is None


# ── P3b: real-time per-turn capture via connector ─────────────────────


class _FakeConn:
    def __init__(self, *, caps=("screen_capture",), result=None, raise_exc=None):
        self.accepted_capabilities = set(caps)
        self._result = result
        self._raise = raise_exc
        self.calls = []

    async def capability_call(self, tool, args, reason="", timeout=30.0):
        self.calls.append((tool, args, reason, timeout))
        if self._raise:
            raise self._raise
        return self._result


def _install_connector(monkeypatch, conn):
    """Patch the lazily-imported get_connector_registry inside
    capture_current_screen_attachment."""
    import service.executor.connector_registry as creg

    class _Reg:
        def get(self, _sid):
            return conn

    monkeypatch.setattr(creg, "get_connector_registry", lambda: _Reg())


def _arm_capture(monkeypatch, session_id="sess-1", vision=True):
    from service.vtuber import screen_observation as so
    monkeypatch.setattr(so, "_session_vision_capable", lambda _sid: vision)
    so._mark_screen_active(session_id)  # toggle "ON"


def test_turn_capture_returns_attachment_when_all_gates_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber import screen_observation as so

    _arm_capture(monkeypatch)
    conn = _FakeConn(result={
        "ok": True,
        "result": {"image_b64": "data:image/jpeg;base64,QUJD", "mime": "image/jpeg",
                   "source_name": "screen (live)"},
    })
    _install_connector(monkeypatch, conn)

    att = _run(so.capture_current_screen_attachment("sess-1"))
    assert att is not None
    assert att["kind"] == "image"
    assert att["mime_type"] == "image/jpeg"
    assert att["data"] == "QUJD"          # data: URL prefix stripped → raw b64
    assert att["source"] == "screen_observation"
    assert conn.calls[0][0] == "screen_capture"


def test_turn_capture_none_when_not_active(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber import screen_observation as so
    monkeypatch.setattr(so, "_session_vision_capable", lambda _sid: True)
    # NOT marked active → no capture even if a connector exists.
    _install_connector(monkeypatch, _FakeConn(result={"ok": True, "result": {}}))
    assert _run(so.capture_current_screen_attachment("sess-1")) is None


def test_turn_capture_none_when_killswitch_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber import screen_observation as so
    monkeypatch.setenv("GENY_SCREEN_OBS_SEND_IMAGE", "0")
    _arm_capture(monkeypatch)
    _install_connector(monkeypatch, _FakeConn(result={
        "ok": True, "result": {"image_b64": "QUJD"}}))
    assert _run(so.capture_current_screen_attachment("sess-1")) is None


def test_turn_capture_none_when_non_vision_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber import screen_observation as so
    _arm_capture(monkeypatch, vision=False)
    _install_connector(monkeypatch, _FakeConn(result={
        "ok": True, "result": {"image_b64": "QUJD"}}))
    assert _run(so.capture_current_screen_attachment("sess-1")) is None


def test_turn_capture_none_when_no_connector_or_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber import screen_observation as so
    _arm_capture(monkeypatch)
    # No connector registered.
    _install_connector(monkeypatch, None)
    assert _run(so.capture_current_screen_attachment("sess-1")) is None
    # Connector present but doesn't advertise screen_capture.
    _install_connector(monkeypatch, _FakeConn(caps=("ping",)))
    assert _run(so.capture_current_screen_attachment("sess-1")) is None


def test_turn_capture_none_on_transport_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber import screen_observation as so
    _arm_capture(monkeypatch)
    _install_connector(monkeypatch, _FakeConn(raise_exc=TimeoutError("slow")))
    assert _run(so.capture_current_screen_attachment("sess-1")) is None


def test_is_screen_active_tracks_uploads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber.screen_observation import save_observation, is_screen_active

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch)

    assert is_screen_active("sess-1") is False
    _run(save_observation(
        session_id="sess-1", image_bytes=b"F", mime_type="image/jpeg",
    ))
    assert is_screen_active("sess-1") is True


def test_prune_removes_old_images_keeps_notes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import os
    import time as _time
    from service.vtuber import screen_observation as so

    monkeypatch.setenv("GENY_SCREEN_OBS_RETENTION_DAYS", "7")
    obs = tmp_path / "memory" / "observations" / "2020-01-01"
    obs.mkdir(parents=True)
    old_img = obs / "old.jpg"
    old_img.write_bytes(b"x")
    old_note = obs / "old.md"
    old_note.write_text("caption", encoding="utf-8")
    fresh_img = obs / "fresh.jpg"
    fresh_img.write_bytes(b"y")

    old = _time.time() - 30 * 86400
    os.utime(old_img, (old, old))
    os.utime(old_note, (old, old))

    so._prune_old_observations(tmp_path)

    assert not old_img.exists()   # old image pruned
    assert old_note.exists()      # note kept (recall value)
    assert fresh_img.exists()     # recent image kept


def test_screen_comment_dedup_robust_to_avatar(monkeypatch: pytest.MonkeyPatch) -> None:
    """De-dup: an unchanged screen (incl. small avatar-overlay jitter) is NOT
    re-commented; a substantial change is. Lenient threshold ignores the avatar."""
    from service.vtuber import screen_observation as so

    sid = "s-dedup"
    # First comment ever → allowed (no prior comment hash).
    so._last_hash[sid] = "0f0f0f0f0f0f0f0f"
    assert so.screen_changed_since_last_comment(sid) is True
    so.mark_screen_comment(sid)

    # Same frame again → skip (0 bits differ).
    assert so.screen_changed_since_last_comment(sid) is False

    # Tiny jitter (avatar idle animation: flip ~2 bits, < threshold 10) → skip.
    so._last_hash[sid] = "0f0f0f0f0f0f0f0d"  # low nibble f→d = 1 bit
    assert so.screen_changed_since_last_comment(sid) is False

    # Substantial change (many bits) → allowed again.
    so._last_hash[sid] = "f0f0f0f0f0f0f0f0"  # ~32 bits differ
    assert so.screen_changed_since_last_comment(sid) is True
    so.cleanup_session_state(sid)
    assert sid not in so._last_comment_hash
