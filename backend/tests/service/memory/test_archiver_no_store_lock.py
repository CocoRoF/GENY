"""Reading the rollup must not take the notes store's lock.

The conversation archiver runs on a single-worker pool, inside a nested
event loop, and its whole job is best-effort. When it reached for the
rollup through ``NotesHandle.read`` it took the store's process-wide
``LoopAgnosticLock`` and — on a cold store — triggered the full-vault
scan first: every note read and frontmatter-parsed before the answer
came back. Meanwhile the main loop's own memory writes queued behind the
same lock.

Production 2026-08-29, at 4,108 notes: turns finished in 144s with
``memory side-effect exceeded 120s and was abandoned`` — the answer had
been ready for two minutes.

The directory listing next to it had already been moved off the store
for exactly this reason. This is the same move for the read: it is the
file this archiver wrote, in a directory it already addresses, parsed
with the same parser the store would have used.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from service.memory.frontmatter import render_frontmatter


class _ExplodingNotes:
    """Any call here means the archiver went back through the store."""

    def __init__(self):
        self.calls = []

    async def read(self, filename):
        self.calls.append(filename)
        raise AssertionError(
            "the archiver read the rollup through the notes store — that is "
            "the lock + full-vault scan this path was moved off"
        )

    async def list(self, **_kw):
        self.calls.append("list")
        raise AssertionError("the archiver listed through the notes store")


def _archiver(tmp_path: Path, notes):
    from service.memory.conversation_archiver import ConversationArchiver

    arch = object.__new__(ConversationArchiver)
    arch._memory_dir = tmp_path
    arch._session_id = "s-1"
    arch._cached_rel = {}
    arch._provider = type("P", (), {"notes": lambda _self: notes})()
    return arch


def _write_rollup(tmp_path: Path, rel: str, *, title: str, body: str) -> None:
    path = tmp_path / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        render_frontmatter(
            {"title": title, "tags": ["conversation"], "category": "conversations",
             "importance": "medium"},
            body,
        ),
        encoding="utf-8",
    )


def test_the_cached_rollup_is_read_from_disk(tmp_path):
    """The path that runs on every archived turn once the file exists."""
    notes = _ExplodingNotes()
    arch = _archiver(tmp_path, notes)
    rel = "conversations/s-1__user.md"
    _write_rollup(tmp_path, rel, title="대화", body="본문입니다\n")
    arch._cached_rel["user"] = rel

    out_rel, out_path, meta, body = arch._locate_or_initialise(
        bucket="user", base_slug="user", derived_title_seed="",
    )

    assert out_rel == rel
    assert meta.get("title") == "대화"
    assert "본문입니다" in body
    assert notes.calls == [], "the store was consulted after all"


def test_a_missing_rollup_is_empty_not_an_error(tmp_path):
    """A cached rel whose file was deleted must not take the turn down."""
    notes = _ExplodingNotes()
    arch = _archiver(tmp_path, notes)
    arch._cached_rel["user"] = "conversations/gone.md"

    _rel, _path, meta, body = arch._locate_or_initialise(
        bucket="user", base_slug="user", derived_title_seed="",
    )
    assert meta == {"category": "conversations"} or meta == {}
    assert body == ""
    assert notes.calls == []


def test_a_file_without_frontmatter_still_yields_its_body(tmp_path):
    """Hand-edited or legacy rollups have no frontmatter block."""
    notes = _ExplodingNotes()
    arch = _archiver(tmp_path, notes)
    rel = "conversations/s-1__user.md"
    (tmp_path / "conversations").mkdir(parents=True, exist_ok=True)
    (tmp_path / rel).write_text("프론트매터 없는 본문", encoding="utf-8")
    arch._cached_rel["user"] = rel

    _rel, _path, meta, body = arch._locate_or_initialise(
        bucket="user", base_slug="user", derived_title_seed="",
    )
    assert body.strip() == "프론트매터 없는 본문"
    assert meta.get("category") == "conversations"
    assert notes.calls == []
