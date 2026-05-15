"""Tests for the Opsidian bulk-delete endpoints.

Two endpoints sharing one UX (multi-select in the inbox + sidebar):

  * ``POST /api/opsidian/captures/batch-delete`` — drops N capture
    notes + their attachments + their ``_captures.jsonl`` entries in
    a single pass.
  * ``POST /api/opsidian/files/batch-delete`` — drops N notes from
    the user's vault.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Dict, List, Optional

import pytest


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── batch_delete_captures ────────────────────────────────────────────


class _CapturesMgr:
    """In-memory stand-in for ``UserOpsidianManager`` used by the
    capture-controller batch path."""

    def __init__(self, vault_root: Path) -> None:
        self.vault_root = str(vault_root)
        self.deleted_notes: List[str] = []
        self.deleted_attachments: List[str] = []
        self._note_delete_returns: Dict[str, bool] = {}
        self._attachment_delete_returns: Dict[str, bool] = {}

    def fail_note(self, filename: str) -> None:
        self._note_delete_returns[filename] = False

    def delete_note(self, filename: str) -> bool:
        self.deleted_notes.append(filename)
        return self._note_delete_returns.get(filename, True)

    def delete_attachment(self, path: str) -> bool:
        self.deleted_attachments.append(path)
        return self._attachment_delete_returns.get(path, True)


def _write_captures_log(vault: Path, rows: List[Dict[str, str]]) -> Path:
    path = vault / "_captures.jsonl"
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    return path


def test_batch_delete_captures_drops_requested_ids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from controller.whiteboard_controller import (
        BatchDeleteCapturesRequest, batch_delete_captures,
    )
    from controller import whiteboard_controller as wc

    mgr = _CapturesMgr(tmp_path)
    _write_captures_log(tmp_path, [
        {"capture_id": "a", "draft_note": "inbox/a.md",
         "attachment_path": "_attachments/a.webm"},
        {"capture_id": "b", "draft_note": "inbox/b.md",
         "attachment_path": "_attachments/b.webm"},
        {"capture_id": "c", "draft_note": "inbox/c.md",
         "attachment_path": "_attachments/c.webm"},
    ])
    monkeypatch.setattr(wc, "_get_manager", lambda _u: mgr)

    payload = BatchDeleteCapturesRequest(capture_ids=["a", "c"])
    out = _run(
        batch_delete_captures(payload, auth={"sub": "alice"})
    )

    assert out["requested"] == 2
    assert out["deleted"] == 2
    assert out["missing"] == []
    assert sorted(mgr.deleted_notes) == ["inbox/a.md", "inbox/c.md"]
    assert sorted(mgr.deleted_attachments) == [
        "_attachments/a.webm",
        "_attachments/c.webm",
    ]

    # Log was rewritten without the deleted entries; "b" survives.
    remaining = (tmp_path / "_captures.jsonl").read_text(encoding="utf-8")
    rows = [json.loads(r) for r in remaining.splitlines() if r.strip()]
    assert [r["capture_id"] for r in rows] == ["b"]


def test_batch_delete_captures_reports_missing_ids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from controller.whiteboard_controller import (
        BatchDeleteCapturesRequest, batch_delete_captures,
    )
    from controller import whiteboard_controller as wc

    mgr = _CapturesMgr(tmp_path)
    _write_captures_log(tmp_path, [
        {"capture_id": "a", "draft_note": "inbox/a.md",
         "attachment_path": "_attachments/a.webm"},
    ])
    monkeypatch.setattr(wc, "_get_manager", lambda _u: mgr)

    out = _run(
        batch_delete_captures(
            BatchDeleteCapturesRequest(capture_ids=["a", "ghost"]),
            auth={"sub": "alice"},
        )
    )

    assert out["requested"] == 2
    assert out["deleted"] == 1
    assert out["missing"] == ["ghost"]


def test_batch_delete_captures_empty_payload_is_noop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty selection still hits the endpoint (e.g. after a
    confirm dialog raced with another tab). Must succeed without
    deleting anything and not 4xx."""
    from controller.whiteboard_controller import (
        BatchDeleteCapturesRequest, batch_delete_captures,
    )
    from controller import whiteboard_controller as wc

    mgr = _CapturesMgr(tmp_path)
    monkeypatch.setattr(wc, "_get_manager", lambda _u: mgr)

    out = _run(
        batch_delete_captures(
            BatchDeleteCapturesRequest(capture_ids=[]),
            auth={"sub": "alice"},
        )
    )
    assert out == {"requested": 0, "deleted": 0, "missing": [], "outcomes": []}
    assert mgr.deleted_notes == []


def test_batch_delete_captures_returns_404ish_when_log_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from controller.whiteboard_controller import (
        BatchDeleteCapturesRequest, batch_delete_captures,
    )
    from controller import whiteboard_controller as wc

    # No _captures.jsonl exists in vault.
    mgr = _CapturesMgr(tmp_path)
    monkeypatch.setattr(wc, "_get_manager", lambda _u: mgr)

    out = _run(
        batch_delete_captures(
            BatchDeleteCapturesRequest(capture_ids=["a", "b"]),
            auth={"sub": "alice"},
        )
    )
    assert out["requested"] == 2
    assert out["deleted"] == 0
    assert sorted(out["missing"]) == ["a", "b"]


def test_batch_delete_captures_dedupes_and_strips(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Duplicate ids + empty strings + whitespace shouldn't cause
    the log to be rewritten twice or count toward requested."""
    from controller.whiteboard_controller import (
        BatchDeleteCapturesRequest, batch_delete_captures,
    )
    from controller import whiteboard_controller as wc

    mgr = _CapturesMgr(tmp_path)
    _write_captures_log(tmp_path, [
        {"capture_id": "a", "draft_note": "inbox/a.md",
         "attachment_path": "_attachments/a.webm"},
    ])
    monkeypatch.setattr(wc, "_get_manager", lambda _u: mgr)

    out = _run(
        batch_delete_captures(
            BatchDeleteCapturesRequest(capture_ids=["a", "a", "  ", "", " a "]),
            auth={"sub": "alice"},
        )
    )

    assert out["requested"] == 1
    assert out["deleted"] == 1
    assert mgr.deleted_notes == ["inbox/a.md"]


# ── batch_delete_opsidian_files ──────────────────────────────────────


class _FilesMgr:
    def __init__(self) -> None:
        self.deleted: List[str] = []
        self._returns: Dict[str, bool] = {}

    def fail(self, filename: str) -> None:
        self._returns[filename] = False

    async def adelete_note(self, filename: str) -> bool:
        self.deleted.append(filename)
        return self._returns.get(filename, True)


def test_batch_delete_files_drops_all(monkeypatch: pytest.MonkeyPatch) -> None:
    from controller.user_opsidian_controller import (
        BatchDeleteFilesRequest, batch_delete_opsidian_files,
    )
    from controller import user_opsidian_controller as uoc

    mgr = _FilesMgr()
    monkeypatch.setattr(uoc, "_get_manager", lambda _u: mgr)

    out = _run(
        batch_delete_opsidian_files(
            BatchDeleteFilesRequest(filenames=[
                "inbox/a.md", "topics/b.md", "projects/c.md",
            ]),
            auth={"sub": "alice"},
        )
    )
    assert out["requested"] == 3
    assert out["deleted"] == 3
    assert mgr.deleted == ["inbox/a.md", "topics/b.md", "projects/c.md"]


def test_batch_delete_files_reports_partial_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from controller.user_opsidian_controller import (
        BatchDeleteFilesRequest, batch_delete_opsidian_files,
    )
    from controller import user_opsidian_controller as uoc

    mgr = _FilesMgr()
    mgr.fail("inbox/b.md")
    monkeypatch.setattr(uoc, "_get_manager", lambda _u: mgr)

    out = _run(
        batch_delete_opsidian_files(
            BatchDeleteFilesRequest(filenames=[
                "inbox/a.md", "inbox/b.md", "inbox/c.md",
            ]),
            auth={"sub": "alice"},
        )
    )
    assert out["requested"] == 3
    assert out["deleted"] == 2
    statuses = {o["filename"]: o["deleted"] for o in out["outcomes"]}
    assert statuses == {
        "inbox/a.md": True,
        "inbox/b.md": False,
        "inbox/c.md": True,
    }


def test_batch_delete_files_dedupes_and_strips_empties(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from controller.user_opsidian_controller import (
        BatchDeleteFilesRequest, batch_delete_opsidian_files,
    )
    from controller import user_opsidian_controller as uoc

    mgr = _FilesMgr()
    monkeypatch.setattr(uoc, "_get_manager", lambda _u: mgr)

    out = _run(
        batch_delete_opsidian_files(
            BatchDeleteFilesRequest(filenames=[
                "inbox/a.md", "inbox/a.md", "", "   ", "topics/b.md",
            ]),
            auth={"sub": "alice"},
        )
    )
    assert out["requested"] == 2
    assert out["deleted"] == 2
    assert mgr.deleted == ["inbox/a.md", "topics/b.md"]


def test_batch_delete_files_tolerates_delete_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A raising ``adelete_note`` (vault gone, permission flap, etc.)
    must not abort the rest of the batch."""
    from controller.user_opsidian_controller import (
        BatchDeleteFilesRequest, batch_delete_opsidian_files,
    )
    from controller import user_opsidian_controller as uoc

    class _RaisingMgr(_FilesMgr):
        async def adelete_note(self, filename: str) -> bool:
            if filename == "boom.md":
                raise RuntimeError("disk gone")
            self.deleted.append(filename)
            return True

    mgr = _RaisingMgr()
    monkeypatch.setattr(uoc, "_get_manager", lambda _u: mgr)

    out = _run(
        batch_delete_opsidian_files(
            BatchDeleteFilesRequest(filenames=["a.md", "boom.md", "b.md"]),
            auth={"sub": "alice"},
        )
    )
    assert out["requested"] == 3
    assert out["deleted"] == 2  # a.md + b.md
    statuses = {o["filename"]: o["deleted"] for o in out["outcomes"]}
    assert statuses == {"a.md": True, "boom.md": False, "b.md": True}
