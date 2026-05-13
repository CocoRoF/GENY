"""Tests for the V1 inbox audio-backfill loop."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest


# ── Helpers ──────────────────────────────────────────────────────────


class _StubMgr:
    """Stand-in for :class:`UserOpsidianManager` that tracks update
    calls in-memory and serves canned attachment bytes / note bodies.
    """

    def __init__(
        self,
        vault_root: Path,
        *,
        notes: Optional[Dict[str, Dict[str, Any]]] = None,
        attachments: Optional[Dict[str, Optional[bytes]]] = None,
    ) -> None:
        self.vault_root = str(vault_root)
        self._notes: Dict[str, Dict[str, Any]] = dict(notes or {})
        self._attachments: Dict[str, Optional[bytes]] = dict(attachments or {})
        self.updates: List[tuple[str, str]] = []  # (filename, new body)

    def read_note(self, filename: str) -> Optional[Dict[str, Any]]:
        note = self._notes.get(filename)
        if note is None:
            return None
        return dict(note)

    def read_attachment(self, relative_path: str) -> Optional[bytes]:
        return self._attachments.get(relative_path)

    def update_note(self, filename: str, *, body: str) -> bool:
        if filename not in self._notes:
            return False
        self._notes[filename]["body"] = body
        self.updates.append((filename, body))
        return True


def _write_capture_log(
    vault_root: Path, rows: List[Dict[str, Any]],
) -> Path:
    log_path = vault_root / "_captures.jsonl"
    with log_path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    return log_path


def _install_stubs(
    monkeypatch: pytest.MonkeyPatch,
    *,
    mgr: _StubMgr,
    transcription: Optional["TranscriptionResultLike"] = None,
) -> None:
    from service.memory import user_opsidian as user_opsidian_mod
    from service.stt import whisper_client as wc_mod
    from service.stt.whisper_client import TranscriptionResult

    monkeypatch.setattr(
        user_opsidian_mod,
        "get_user_opsidian_manager",
        lambda _user: mgr,
    )

    result_obj = transcription or TranscriptionResult(
        text="hello world",
        language="en",
        duration_seconds=1.2,
        source="whisper",
    )

    class _StubClient:
        async def atranscribe(
            self, audio_bytes: bytes, *, filename: str = "audio.webm",
            language: Optional[str] = None,
        ):
            return result_obj

    monkeypatch.setattr(wc_mod, "get_whisper_client", lambda: _StubClient())


TranscriptionResultLike = Any  # forward-only typing alias


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── Capture log iteration ────────────────────────────────────────────


def test_iter_audio_captures_filters_to_audio_with_attachments(tmp_path: Path) -> None:
    from service.whiteboard.audio_backfill import _iter_audio_captures

    log_path = _write_capture_log(
        tmp_path,
        [
            # Audio with attachment — included
            {
                "capture_id": "c1",
                "type": "audio",
                "draft_note": "inbox/audio-1.md",
                "attachment_path": "_attachments/v1.webm",
            },
            # Wrong type — excluded
            {
                "capture_id": "c2",
                "type": "image",
                "draft_note": "inbox/img-1.md",
                "attachment_path": "_attachments/img.png",
            },
            # Audio but missing attachment — excluded
            {
                "capture_id": "c3",
                "type": "audio",
                "draft_note": "inbox/audio-2.md",
                "attachment_path": "",
            },
            # Audio with non-audio extension — excluded
            {
                "capture_id": "c4",
                "type": "audio",
                "draft_note": "inbox/audio-3.md",
                "attachment_path": "_attachments/not-audio.txt",
            },
            # Malformed JSON line — skipped silently
            "not json garbage",  # type: ignore[list-item]
        ],
    )
    # Append a malformed line by hand (json.dumps would fail on a bare string)
    with log_path.open("a", encoding="utf-8") as f:
        f.write("not json garbage\n")
        f.write("\n")  # blank line — skipped

    out = list(_iter_audio_captures(log_path))
    assert [e.capture_id for e in out] == ["c1"]
    assert out[0].attachment_path == "_attachments/v1.webm"
    assert out[0].draft_note == "inbox/audio-1.md"


def test_iter_audio_captures_returns_empty_when_log_missing(
    tmp_path: Path,
) -> None:
    from service.whiteboard.audio_backfill import _iter_audio_captures
    assert list(_iter_audio_captures(tmp_path / "nope.jsonl")) == []


# ── Transcript guard ─────────────────────────────────────────────────


def test_body_has_transcript_recognises_block() -> None:
    from service.whiteboard.audio_backfill import _body_has_transcript

    assert _body_has_transcript(
        "> **Transcript (en):** hello world\n\noriginal body"
    )
    assert _body_has_transcript(
        "![[voice.webm]]\n\n> **Transcript (ko):** 안녕"
    )
    assert not _body_has_transcript("just plain text")
    assert not _body_has_transcript("")
    assert not _body_has_transcript("> some other quote")


# ── Per-user backfill ────────────────────────────────────────────────


def test_backfill_one_user_fills_missing_transcript(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.whiteboard.audio_backfill import backfill_one_user

    _write_capture_log(tmp_path, [{
        "capture_id": "cap-1",
        "type": "audio",
        "draft_note": "inbox/audio-1.md",
        "attachment_path": "_attachments/v1.webm",
    }])
    mgr = _StubMgr(
        tmp_path,
        notes={"inbox/audio-1.md": {"body": "![[v1.webm]]\n"}},
        attachments={"_attachments/v1.webm": b"FAKEWEBM"},
    )
    _install_stubs(monkeypatch, mgr=mgr)

    result = _run(backfill_one_user("alice", max_per_cycle=5))

    assert result.scanned == 1
    assert result.filled == 1
    assert len(mgr.updates) == 1
    filename, new_body = mgr.updates[0]
    assert filename == "inbox/audio-1.md"
    assert new_body.startswith("> **Transcript (en):** hello world\n\n")
    assert "![[v1.webm]]" in new_body


def test_backfill_skips_when_block_present(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.whiteboard.audio_backfill import backfill_one_user

    _write_capture_log(tmp_path, [{
        "capture_id": "cap-1",
        "type": "audio",
        "draft_note": "inbox/audio-1.md",
        "attachment_path": "_attachments/v1.webm",
    }])
    mgr = _StubMgr(
        tmp_path,
        notes={"inbox/audio-1.md": {
            "body": "> **Transcript (en):** already filled\n\nbody"
        }},
        attachments={"_attachments/v1.webm": b"FAKEWEBM"},
    )
    _install_stubs(monkeypatch, mgr=mgr)

    result = _run(backfill_one_user("alice", max_per_cycle=5))

    assert result.scanned == 1
    assert result.skipped == 1
    assert result.filled == 0
    assert mgr.updates == []


def test_backfill_records_unavailable_when_service_down(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.stt.whisper_client import TranscriptionResult
    from service.whiteboard.audio_backfill import backfill_one_user

    _write_capture_log(tmp_path, [{
        "capture_id": "cap-1",
        "type": "audio",
        "draft_note": "inbox/audio-1.md",
        "attachment_path": "_attachments/v1.webm",
    }])
    mgr = _StubMgr(
        tmp_path,
        notes={"inbox/audio-1.md": {"body": "![[v1.webm]]\n"}},
        attachments={"_attachments/v1.webm": b"FAKEWEBM"},
    )
    _install_stubs(
        monkeypatch,
        mgr=mgr,
        transcription=TranscriptionResult(
            text="",
            source="unavailable",
            error="connect refused",
        ),
    )

    result = _run(backfill_one_user("alice", max_per_cycle=5))

    assert result.scanned == 1
    assert result.unavailable == 1
    assert result.filled == 0
    assert mgr.updates == []  # body unchanged


def test_backfill_records_missing_when_attachment_lost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.whiteboard.audio_backfill import backfill_one_user

    _write_capture_log(tmp_path, [{
        "capture_id": "cap-1",
        "type": "audio",
        "draft_note": "inbox/audio-1.md",
        "attachment_path": "_attachments/gone.webm",
    }])
    mgr = _StubMgr(
        tmp_path,
        notes={"inbox/audio-1.md": {"body": "![[gone.webm]]\n"}},
        attachments={"_attachments/gone.webm": None},
    )
    _install_stubs(monkeypatch, mgr=mgr)

    result = _run(backfill_one_user("alice", max_per_cycle=5))

    assert result.scanned == 1
    assert result.missing == 1
    assert mgr.updates == []


def test_backfill_records_missing_when_note_deleted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.whiteboard.audio_backfill import backfill_one_user

    _write_capture_log(tmp_path, [{
        "capture_id": "cap-1",
        "type": "audio",
        "draft_note": "inbox/deleted.md",
        "attachment_path": "_attachments/v1.webm",
    }])
    mgr = _StubMgr(
        tmp_path,
        notes={},  # note was deleted by the user
        attachments={"_attachments/v1.webm": b"FAKEWEBM"},
    )
    _install_stubs(monkeypatch, mgr=mgr)

    result = _run(backfill_one_user("alice", max_per_cycle=5))

    assert result.scanned == 1
    assert result.missing == 1


def test_backfill_max_per_cycle_caps_productive_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.whiteboard.audio_backfill import backfill_one_user

    _write_capture_log(tmp_path, [
        {
            "capture_id": f"cap-{i}",
            "type": "audio",
            "draft_note": f"inbox/audio-{i}.md",
            "attachment_path": f"_attachments/v{i}.webm",
        }
        for i in range(5)
    ])
    notes = {f"inbox/audio-{i}.md": {"body": ""} for i in range(5)}
    attachments = {f"_attachments/v{i}.webm": b"FAKEWEBM" for i in range(5)}
    mgr = _StubMgr(tmp_path, notes=notes, attachments=attachments)
    _install_stubs(monkeypatch, mgr=mgr)

    result = _run(backfill_one_user("alice", max_per_cycle=2))

    # Cap = 2 → only the first two captures get filled this cycle.
    assert result.filled == 2
    assert result.scanned == 2  # iteration stops early
    assert len(mgr.updates) == 2


def test_backfill_skipped_does_not_count_toward_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Skipped notes don't burn GPU, so they don't take a slot in the
    per-cycle budget — the loop should keep iterating until it finds
    ``max_per_cycle`` productive ones (or runs out of candidates).
    """
    from service.whiteboard.audio_backfill import backfill_one_user

    _write_capture_log(tmp_path, [
        {
            "capture_id": "skip-1",
            "type": "audio",
            "draft_note": "inbox/skip-1.md",
            "attachment_path": "_attachments/s1.webm",
        },
        {
            "capture_id": "skip-2",
            "type": "audio",
            "draft_note": "inbox/skip-2.md",
            "attachment_path": "_attachments/s2.webm",
        },
        {
            "capture_id": "fill-1",
            "type": "audio",
            "draft_note": "inbox/fill-1.md",
            "attachment_path": "_attachments/f1.webm",
        },
    ])
    notes = {
        "inbox/skip-1.md": {"body": "> **Transcript (en):** existing\n"},
        "inbox/skip-2.md": {"body": "> **Transcript (ko):** 있음\n"},
        "inbox/fill-1.md": {"body": ""},
    }
    attachments = {
        "_attachments/s1.webm": b"FAKEWEBM",
        "_attachments/s2.webm": b"FAKEWEBM",
        "_attachments/f1.webm": b"FAKEWEBM",
    }
    mgr = _StubMgr(tmp_path, notes=notes, attachments=attachments)
    _install_stubs(monkeypatch, mgr=mgr)

    result = _run(backfill_one_user("alice", max_per_cycle=1))

    assert result.skipped == 2
    assert result.filled == 1
    assert result.scanned == 3


def test_backfill_deduplicates_capture_ids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The capture log can contain duplicates (e.g. after a manual
    edit or restore). We must only attempt each capture_id once per
    scan."""
    from service.whiteboard.audio_backfill import backfill_one_user

    _write_capture_log(tmp_path, [
        {
            "capture_id": "cap-1",
            "type": "audio",
            "draft_note": "inbox/audio-1.md",
            "attachment_path": "_attachments/v1.webm",
        },
        {
            "capture_id": "cap-1",
            "type": "audio",
            "draft_note": "inbox/audio-1.md",
            "attachment_path": "_attachments/v1.webm",
        },
    ])
    mgr = _StubMgr(
        tmp_path,
        notes={"inbox/audio-1.md": {"body": ""}},
        attachments={"_attachments/v1.webm": b"FAKEWEBM"},
    )
    _install_stubs(monkeypatch, mgr=mgr)

    result = _run(backfill_one_user("alice", max_per_cycle=5))

    assert result.scanned == 1
    assert result.filled == 1


# ── Multi-user round robin ───────────────────────────────────────────


def test_backfill_all_users_round_robins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.whiteboard import audio_backfill as ab

    alice_root = tmp_path / "alice"
    bob_root = tmp_path / "bob"
    alice_root.mkdir()
    bob_root.mkdir()

    _write_capture_log(alice_root, [{
        "capture_id": "alice-1",
        "type": "audio",
        "draft_note": "inbox/audio-1.md",
        "attachment_path": "_attachments/a1.webm",
    }])
    _write_capture_log(bob_root, [{
        "capture_id": "bob-1",
        "type": "audio",
        "draft_note": "inbox/audio-1.md",
        "attachment_path": "_attachments/b1.webm",
    }])

    alice_mgr = _StubMgr(
        alice_root,
        notes={"inbox/audio-1.md": {"body": ""}},
        attachments={"_attachments/a1.webm": b"AAA"},
    )
    bob_mgr = _StubMgr(
        bob_root,
        notes={"inbox/audio-1.md": {"body": ""}},
        attachments={"_attachments/b1.webm": b"BBB"},
    )

    def _resolve(username: str) -> _StubMgr:
        return {"alice": alice_mgr, "bob": bob_mgr}[username]

    from service.memory import user_opsidian as user_opsidian_mod
    from service.stt import whisper_client as wc_mod
    from service.stt.whisper_client import TranscriptionResult

    monkeypatch.setattr(
        user_opsidian_mod, "get_user_opsidian_manager", _resolve
    )

    class _StubClient:
        async def atranscribe(
            self, audio_bytes: bytes, *, filename: str = "audio.webm",
            language: Optional[str] = None,
        ):
            return TranscriptionResult(text="ok", language="en", source="whisper")

    monkeypatch.setattr(wc_mod, "get_whisper_client", lambda: _StubClient())
    monkeypatch.setattr(ab, "_list_usernames", lambda: ["alice", "bob"])

    summary = _run(ab.backfill_all_users(max_per_cycle=1))

    # Each user got one fill (round-robin gives each user the full
    # budget independently — by design, see the docstring).
    assert summary.filled == 2
    assert len(alice_mgr.updates) == 1
    assert len(bob_mgr.updates) == 1


# ── Loop cancellation ────────────────────────────────────────────────


def test_audio_backfill_loop_propagates_cancel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cancelling the loop's Task must surface a clean
    :class:`asyncio.CancelledError` — the shutdown branch in
    ``main.py`` awaits the task and the test ensures that await
    completes without raising anything weird.
    """
    from service.whiteboard import audio_backfill as ab

    # No users → loop will hit the empty branch fast, sleep, then
    # we cancel before the next iteration.
    monkeypatch.setattr(ab, "_list_usernames", lambda: [])

    async def _runner():
        task = asyncio.create_task(ab.audio_backfill_loop())
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    _run(_runner())
