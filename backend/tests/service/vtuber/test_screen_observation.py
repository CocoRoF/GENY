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


# ── P1: real-image attachment + vision gating ─────────────────────────


class _FakeAgent:
    def __init__(self, *, model_name=None, memory_manager=None):
        self.model_name = model_name
        self.memory_manager = memory_manager
        self.storage_path = None


def _install_agent(monkeypatch, agent) -> None:
    from service.vtuber import screen_observation as so
    monkeypatch.setattr(so, "_resolve_agent", lambda _sid: agent)


def test_attachment_built_for_vision_capable_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber import screen_observation as so

    _install_agent(monkeypatch, _FakeAgent(model_name="claude-sonnet-4-20250514"))
    img = tmp_path / "frame.jpg"
    img.write_bytes(b"FAKEJPEG")

    att = so._maybe_image_attachment("sess-1", img)
    assert att is not None and len(att) == 1
    assert att[0]["kind"] == "image"
    assert att[0]["mime_type"] == "image/jpeg"
    assert att[0]["url"].startswith("file://")
    assert att[0]["url"].endswith("frame.jpg")


def test_attachment_omitted_for_non_vision_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber import screen_observation as so

    _install_agent(monkeypatch, _FakeAgent(model_name="some-local-text-only"))
    img = tmp_path / "frame.png"
    img.write_bytes(b"FAKE")

    assert so._maybe_image_attachment("sess-1", img) is None


def test_attachment_omitted_when_send_image_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber import screen_observation as so

    monkeypatch.setenv("GENY_SCREEN_OBS_SEND_IMAGE", "0")
    _install_agent(monkeypatch, _FakeAgent(model_name="claude-sonnet-4-20250514"))
    img = tmp_path / "frame.png"
    img.write_bytes(b"FAKE")

    assert so._maybe_image_attachment("sess-1", img) is None


def test_run_trigger_passes_attachments_when_vision_capable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The synthetic ``[USER_OBSERVATION]`` execute_command call must
    carry the real frame as a multimodal attachment for a vision model."""
    import sys
    import types
    from datetime import datetime, timezone
    from service.vtuber import screen_observation as so

    captured: dict = {}

    fake_mod = types.ModuleType("service.execution.agent_executor")

    async def _fake_exec(session_id, prompt, **kwargs):  # noqa: ANN001
        captured["session_id"] = session_id
        captured["prompt"] = prompt
        captured["kwargs"] = kwargs

        class _R:
            success = True
            output = "[SILENT]"
            duration_ms = 1
            cost_usd = 0.0

        return _R()

    fake_mod.execute_command = _fake_exec  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "service.execution.agent_executor", fake_mod)
    monkeypatch.setattr(so, "_save_trigger_response_to_chat", lambda **k: None)
    _install_agent(monkeypatch, _FakeAgent(model_name="claude-opus-4"))

    img = tmp_path / "frame.jpg"
    img.write_bytes(b"FAKEJPEG")

    _run(so._run_trigger(
        session_id="sess-1",
        observation_id="obs-1",
        caption="vscode editing python",
        captured_at=datetime.now(timezone.utc),
        image_path=img,
    ))

    assert "attachments" in captured["kwargs"]
    att = captured["kwargs"]["attachments"]
    assert att[0]["kind"] == "image" and att[0]["url"].startswith("file://")
    assert captured["kwargs"]["is_trigger"] is True


def test_run_trigger_caption_only_for_non_vision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sys
    import types
    from datetime import datetime, timezone
    from service.vtuber import screen_observation as so

    captured: dict = {}
    fake_mod = types.ModuleType("service.execution.agent_executor")

    async def _fake_exec(session_id, prompt, **kwargs):  # noqa: ANN001
        captured["kwargs"] = kwargs

        class _R:
            success = True
            output = ""
            duration_ms = 1
            cost_usd = 0.0

        return _R()

    fake_mod.execute_command = _fake_exec  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "service.execution.agent_executor", fake_mod)
    monkeypatch.setattr(so, "_save_trigger_response_to_chat", lambda **k: None)
    _install_agent(monkeypatch, _FakeAgent(model_name="local-llama-text"))

    img = tmp_path / "frame.png"
    img.write_bytes(b"FAKE")

    _run(so._run_trigger(
        session_id="sess-1", observation_id="o", caption="c",
        captured_at=datetime.now(timezone.utc), image_path=img,
    ))

    assert "attachments" not in captured["kwargs"]


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
    from service.vtuber.screen_observation import save_and_maybe_trigger
    from service.vtuber import screen_observation as so

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="terminal showing a stack trace")
    _install_trigger_recorder(monkeypatch)
    mm = _FakeMemoryManager()
    _install_agent(monkeypatch, _FakeAgent(
        model_name="claude-sonnet-4", memory_manager=mm,
    ))

    result = _run(save_and_maybe_trigger(
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
    caption is recorded or fed to the trigger."""
    from service.vtuber.screen_observation import save_and_maybe_trigger

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(
        monkeypatch,
        caption="terminal shows password: hunter2theverylongsecret123",
    )
    fired = _install_trigger_recorder(monkeypatch)

    result = _run(save_and_maybe_trigger(
        session_id="sess-1", image_bytes=b"FRAME", mime_type="image/jpeg",
    ))

    assert "[REDACTED]" in result.caption
    assert "hunter2theverylongsecret123" not in result.caption
    # The trigger receives the redacted caption too.
    assert "hunter2theverylongsecret123" not in fired[0]["caption"]


def test_cleanup_session_state_drops_tables() -> None:
    from service.vtuber import screen_observation as so

    so._last_fire_at["sess-x"] = 123.0
    so._last_caption["sess-x"] = "something"
    so._last_hash["sess-x"] = "deadbeefdeadbeef"
    so.cleanup_session_state("sess-x")
    assert "sess-x" not in so._last_fire_at
    assert "sess-x" not in so._last_caption
    assert "sess-x" not in so._last_hash


# ── Change-gate (perceptual-hash) + talkativeness ─────────────────────


def test_hamming_and_invalid_input() -> None:
    from service.vtuber import screen_observation as so

    assert so._hamming("00", "00") == 0
    assert so._hamming("0f", "00") == 4           # 0x0f = 1111
    assert so._hamming("ff", "00") == 8
    assert so._hamming("zz", "00") is None        # non-hex → None (treated changed)


def test_level_params_clamps_min_gap_to_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    from service.vtuber import screen_observation as so

    assert so._level_params("chatty")["min_gap"] == 45.0
    assert so._level_params("calm")["min_gap"] == 180.0
    assert so._level_params(None)["min_gap"] == 45.0      # default = chatty
    assert so._level_params("bogus")["min_gap"] == 45.0   # unknown → chatty
    # Server floor wins over a too-small requested level value.
    monkeypatch.setenv("GENY_SCREEN_OBS_MIN_GAP_FLOOR_S", "120")
    assert so._level_params("chatty")["min_gap"] == 120.0


def test_unchanged_frame_skips_caption_and_trigger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Identical consecutive frame_hash → the vision call + trigger are
    skipped entirely (no image written, no caption, no fire)."""
    from service.vtuber.screen_observation import save_and_maybe_trigger

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="working on code")
    fired = _install_trigger_recorder(monkeypatch)

    h = "0123456789abcdef"
    first = _run(save_and_maybe_trigger(
        session_id="sess-1", image_bytes=b"F1", mime_type="image/png", frame_hash=h,
    ))
    second = _run(save_and_maybe_trigger(
        session_id="sess-1", image_bytes=b"F2", mime_type="image/png", frame_hash=h,
    ))

    assert first.trigger_fired is True
    assert second.skipped_reason == "unchanged"
    assert second.image_path is None      # returned before writing
    assert second.caption == ""           # never captioned
    assert len(fired) == 1


def test_changed_frame_passes_gate_then_hits_min_gap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A far-apart hash is NOT 'unchanged' — it reaches the min-gap check
    (reason 'cooldown'), proving the change-gate let it through."""
    from service.vtuber.screen_observation import save_and_maybe_trigger

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="working on code")
    _install_trigger_recorder(monkeypatch)

    _run(save_and_maybe_trigger(
        session_id="sess-1", image_bytes=b"F1", mime_type="image/png",
        frame_hash="0000000000000000",
    ))
    second = _run(save_and_maybe_trigger(
        session_id="sess-1", image_bytes=b"F2", mime_type="image/png",
        frame_hash="ffffffffffffffff",   # 64-bit flip → very changed
    ))
    assert second.skipped_reason == "cooldown"   # passed change-gate, blocked by min_gap
    assert second.skipped_reason != "unchanged"


def test_force_bypasses_change_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber.screen_observation import save_and_maybe_trigger

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="working on code")
    fired = _install_trigger_recorder(monkeypatch)

    h = "0123456789abcdef"
    _run(save_and_maybe_trigger(
        session_id="sess-1", image_bytes=b"F1", mime_type="image/png", frame_hash=h,
    ))
    forced = _run(save_and_maybe_trigger(
        session_id="sess-1", image_bytes=b"F2", mime_type="image/png",
        frame_hash=h, force_trigger=True,   # identical hash, but forced
    ))
    assert forced.trigger_fired is True
    assert len(fired) == 2


def test_ambient_fires_despite_unchanged_after_max_silence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Even with an identical frame, an ambient comment surfaces once the
    max_silence window has elapsed since the last fire."""
    import time as _time
    from service.vtuber.screen_observation import save_and_maybe_trigger
    from service.vtuber import screen_observation as so

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="still on the same screen")
    fired = _install_trigger_recorder(monkeypatch)

    # Pretend we last fired long ago, and already saw this exact hash.
    h = "0123456789abcdef"
    so._last_hash["sess-1"] = h
    so._last_fire_at["sess-1"] = _time.monotonic() - 10_000  # > chatty max_silence (300)

    res = _run(save_and_maybe_trigger(
        session_id="sess-1", image_bytes=b"F", mime_type="image/png", frame_hash=h,
    ))
    assert res.trigger_fired is True
    assert len(fired) == 1


def test_upload_wakes_dormant_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every upload calls ensure_session_live so an observing connector
    keeps the persona alive across a backend restart (no manual re-open)."""
    from service.vtuber.screen_observation import save_and_maybe_trigger
    from service.vtuber import screen_observation as so

    woken: list[str] = []

    async def _record(sid: str) -> None:
        woken.append(sid)

    monkeypatch.setattr(so, "_ensure_session_live", _record)
    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="working")
    _install_trigger_recorder(monkeypatch)

    _run(save_and_maybe_trigger(
        session_id="sess-1", image_bytes=b"F", mime_type="image/png",
    ))
    assert woken == ["sess-1"]


def test_uploaded_frame_cached_and_served_even_without_caption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The HTTP-uploaded frame is cached + served as an attachment even when the
    caption LLM fails (placeholder) — this is the path the thinking-trigger uses
    to comment on the screen without depending on captions."""
    from service.vtuber.screen_observation import (
        save_and_maybe_trigger, get_recent_frame_attachment, list_active_sessions,
    )
    from service.vtuber import screen_observation as so
    import base64

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="", source="placeholder")  # caption fails (like prod)
    _install_trigger_recorder(monkeypatch)
    monkeypatch.setattr(so, "_session_vision_capable", lambda _sid: True)

    _run(save_and_maybe_trigger(session_id="s1", image_bytes=b"FRAMEBYTES", mime_type="image/jpeg"))

    assert "s1" in list_active_sessions()
    att = get_recent_frame_attachment("s1")
    assert att is not None
    assert att["kind"] == "image" and att["source"] == "screen_observation"
    assert base64.b64decode(att["data"]) == b"FRAMEBYTES"


def test_recent_frame_none_for_non_vision_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.vtuber.screen_observation import save_and_maybe_trigger, get_recent_frame_attachment
    from service.vtuber import screen_observation as so

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch, caption="x")
    _install_trigger_recorder(monkeypatch)
    monkeypatch.setattr(so, "_session_vision_capable", lambda _sid: False)

    _run(save_and_maybe_trigger(session_id="s2", image_bytes=b"F", mime_type="image/jpeg"))
    assert get_recent_frame_attachment("s2") is None


def test_prompt_bias_varies_by_talkativeness() -> None:
    from datetime import datetime, timezone
    from service.vtuber.screen_observation import _compose_prompt

    now = datetime.now(timezone.utc)
    chatty = _compose_prompt(caption="c", observation_id="o", captured_at=now, talkativeness="chatty")
    calm = _compose_prompt(caption="c", observation_id="o", captured_at=now, talkativeness="calm")
    assert "기본적으로 *반응해라*" in chatty       # chatty pushes to speak
    assert "조용히 있어도 된다" in calm            # calm is reserved
    # Both keep the [SILENT] escape + sensitive guard.
    for p in (chatty, calm):
        assert "[SILENT]" in p and "민감" in p


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
    from service.vtuber.screen_observation import save_and_maybe_trigger, is_screen_active

    _install_session_storage(monkeypatch, storage_root=tmp_path)
    _install_caption(monkeypatch)
    _install_trigger_recorder(monkeypatch)

    assert is_screen_active("sess-1") is False
    _run(save_and_maybe_trigger(
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
