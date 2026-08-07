"""Observation lifecycle v2 — used frames promote, silent turns stay inert,
the ambient buffer ages out wholesale.

Policy under test (2026-07 optimization):
  * a spoken turn's screen frame is promoted to ``memory/attachments/``
    (permanent) and embedded into the execution record;
  * a ``[SILENT]`` turn promotes nothing, its execution note is tagged
    ``silent`` (low importance, marked title), excluded from the graph,
    and swept with the same retention window as observations;
  * ``memory/observations/`` is a rolling 7-day buffer: past the window
    BOTH image files and observation notes are deleted (provider-routed),
    which also retires the legacy junk-caption backlog with zero
    one-off migration code.
"""

from __future__ import annotations

import base64
import time
from pathlib import Path

import pytest

import service.vtuber.screen_observation as so
from service.memory.note_utils import build_graph_from_index, is_silent_reply


# ── is_silent_reply ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        ("[SILENT]", True),
        ("  [silent]  ", True),
        ("[SILENT].", True),
        ("", False),
        (None, False),
        ("[SILENT] 그런데 한마디만", False),
        ("[calm:0.7] 응, 보여.", False),
        ("응 [SILENT] 아님", False),
    ],
)
def test_is_silent_reply(text, expected):
    assert is_silent_reply(text) is expected


# ── promote_used_frames ──────────────────────────────────────────────


def _frame(data: bytes = b"\xff\xd8fakejpeg") -> dict:
    return {
        "kind": "image",
        "mime_type": "image/jpeg",
        "data": base64.b64encode(data).decode("ascii"),
        "name": "screen.jpg",
        "source": "screen_observation",
    }


def _install_storage(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    monkeypatch.setattr(so, "_resolve_session_storage", lambda _sid: root)


def test_spoken_turn_promotes_frame(tmp_path: Path, monkeypatch):
    _install_storage(monkeypatch, tmp_path)
    names = so.promote_used_frames("s1", [_frame()], "[calm:0.7] 응, 보여.")
    assert len(names) == 1
    stored = list((tmp_path / "memory" / "attachments").rglob("*.jpg"))
    assert len(stored) == 1
    assert stored[0].name == names[0]
    assert stored[0].read_bytes().startswith(b"\xff\xd8")


def test_same_frame_promotes_once(tmp_path: Path, monkeypatch):
    _install_storage(monkeypatch, tmp_path)
    a = so.promote_used_frames("s1", [_frame()], "reply one")
    b = so.promote_used_frames("s1", [_frame()], "reply two")
    assert a == b  # content-hash id → idempotent
    assert len(list((tmp_path / "memory" / "attachments").rglob("*.jpg"))) == 1


def test_silent_turn_promotes_nothing(tmp_path: Path, monkeypatch):
    _install_storage(monkeypatch, tmp_path)
    assert so.promote_used_frames("s1", [_frame()], "[SILENT]") == []
    assert not (tmp_path / "memory" / "attachments").exists()


def test_non_screen_attachments_ignored(tmp_path: Path, monkeypatch):
    _install_storage(monkeypatch, tmp_path)
    upload = {"kind": "image", "data": "QUJD", "source": "user_upload"}
    assert so.promote_used_frames("s1", [upload], "spoke") == []


# ── execution entry embeds media ─────────────────────────────────────


def test_execution_entry_embeds_screen_frames():
    from service.memory.manager import SessionMemoryManager

    entry = SessionMemoryManager._build_execution_entry(
        input_text="내 화면 보여?",
        result_state={"final_answer": "응, 보여."},
        duration_ms=10_100,
        execution_number=2,
        success=True,
        media=["abc123def456.jpg"],
    )
    assert "**Screen:**" in entry
    assert "![[abc123def456.jpg]]" in entry


def test_execution_entry_without_media_unchanged():
    from service.memory.manager import SessionMemoryManager

    entry = SessionMemoryManager._build_execution_entry(
        input_text="hello",
        result_state={"final_answer": "world"},
        duration_ms=100,
        execution_number=1,
        success=True,
    )
    assert "**Screen:**" not in entry


# ── graph projection hides silent notes ──────────────────────────────


def test_graph_excludes_silent_nodes_and_edges():
    idx = {
        "files": {
            "a.md": {"title": "A", "tags": ["execution"], "links_to": ["b.md"]},
            "b.md": {"title": "B (silent)", "tags": ["execution", "silent"],
                     "links_to": ["a.md"]},
            "c.md": {"title": "C", "tags": [], "links_to": ["b.md"]},
        },
    }
    graph = build_graph_from_index(idx)
    ids = {n["id"] for n in graph["nodes"]}
    assert ids == {"a.md", "c.md"}
    for e in graph["edges"]:
        assert "b.md" not in (e["source"], e["target"])


# ── retention sweep v2 ───────────────────────────────────────────────


class _FakeIndex:
    def __init__(self, summaries):
        self._summaries = summaries

    async def list_notes(self, *, tag=None, limit=100, offset=0):
        assert tag == "silent"
        return self._summaries


class _FakeProvider:
    def __init__(self, summaries):
        self._index = _FakeIndex(summaries)

    def index(self):
        return self._index


class _FakeManager:
    def __init__(self):
        self.deleted: list[str] = []

    async def adelete_note(self, filename: str) -> bool:
        self.deleted.append(filename)
        return True


class _Summary:
    def __init__(self, filename, modified):
        self.filename = filename
        self.modified = modified


def _age(path: Path, days: float) -> None:
    stamp = time.time() - days * 86400
    import os

    os.utime(path, (stamp, stamp))


@pytest.mark.asyncio
async def test_sweep_removes_stale_images_notes_and_silents(
    tmp_path: Path, monkeypatch,
):
    so.reset_cooldown_state_for_tests()
    obs = tmp_path / "memory" / "observations"
    bucket = obs / "2026-06-20"
    bucket.mkdir(parents=True)
    old_img = bucket / "old.jpg"
    old_img.write_bytes(b"x")
    _age(old_img, 10)
    fresh_img = bucket / "fresh.jpg"
    fresh_img.write_bytes(b"y")

    old_note = obs / "20260620-000000-old.md"
    old_note.write_text("junk caption", encoding="utf-8")
    _age(old_note, 10)
    fresh_note = obs / "20260706-000000-new.md"
    fresh_note.write_text("real caption", encoding="utf-8")

    # Promoted frames must never be touched.
    kept = tmp_path / "memory" / "attachments" / "2026-06-20"
    kept.mkdir(parents=True)
    promoted = kept / "promoted.jpg"
    promoted.write_bytes(b"keep")
    _age(promoted, 30)

    # Timestamps RELATIVE to now. The retention window is measured against
    # the wall clock, so the fixed 2026-07-06 that stood in for "recent" when
    # this was written aged past the 7-day window and the fresh note started
    # being swept — a test that only passed during the month it was authored.
    from datetime import datetime, timedelta, timezone

    _now = datetime.now(timezone.utc)
    _stale_iso = (_now - timedelta(days=30)).isoformat()
    _fresh_iso = (_now - timedelta(days=1)).isoformat()

    mm = _FakeManager()
    provider = _FakeProvider(
        [
            _Summary("20260620-old-silent.md", _stale_iso),
            _Summary("20260706-new-silent.md", _fresh_iso),
        ]
    )

    class _Agent:
        memory_manager = mm
        memory_provider = provider

    monkeypatch.setattr(so, "_resolve_agent", lambda _sid: _Agent())

    await so._prune_old_observations("s1", tmp_path)

    assert not old_img.exists()
    assert fresh_img.exists()
    assert promoted.exists()  # permanent bucket untouched
    assert "20260620-000000-old.md" in mm.deleted
    assert "20260706-000000-new.md" not in mm.deleted
    assert "20260620-old-silent.md" in mm.deleted
    assert "20260706-new-silent.md" not in mm.deleted


@pytest.mark.asyncio
async def test_sweep_skips_notes_without_live_manager(tmp_path: Path, monkeypatch):
    so.reset_cooldown_state_for_tests()
    obs = tmp_path / "memory" / "observations"
    obs.mkdir(parents=True)
    old_note = obs / "20260601-000000-x.md"
    old_note.write_text("junk", encoding="utf-8")
    _age(old_note, 30)

    monkeypatch.setattr(so, "_resolve_agent", lambda _sid: None)
    await so._prune_old_observations("s1", tmp_path)
    # Never raw-unlink a provider-indexed note — stays until a manager is live.
    assert old_note.exists()


@pytest.mark.asyncio
async def test_first_sweep_runs_on_a_freshly_booted_process(tmp_path: Path, monkeypatch):
    """The throttle must not swallow the FIRST sweep.

    `time.monotonic()` counts from an arbitrary origin — on Linux roughly
    boot — so comparing it against a 0.0 "never pruned" default made
    `now - 0.0 < 3600` true on any machine up for less than an hour. Every
    container skipped pruning for its first hour after a restart, and the
    only place it reproduced was a fresh CI runner.
    """
    obs = tmp_path / "memory" / "observations" / "2026-06-20"
    obs.mkdir(parents=True)
    stale = obs / "old.jpg"
    stale.write_bytes(b"x")
    _age(stale, 30)

    monkeypatch.setattr(so.time, "monotonic", lambda: 12.0)  # 12s since boot
    so.reset_cooldown_state_for_tests()

    await so._prune_old_observations("s-fresh", tmp_path)

    assert not stale.exists(), "the first sweep after boot was throttled away"
