"""Sync endpoints — optimistic concurrency, guards, cursor wiring.

Handlers are exercised directly (project convention) with the storage
root monkeypatched to a tmp dir and auth/ownership stubbed.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

import controller.agent_controller as ac
from service.utils import workspace_sync as wsync


@pytest.fixture(autouse=True)
def _wire(tmp_path, monkeypatch):
    monkeypatch.setattr(wsync, "_SCAN_THROTTLE_S", 0.0)
    monkeypatch.setattr(ac, "_storage_root_live_or_dormant", lambda sid: str(tmp_path))
    monkeypatch.setattr(ac, "_enforce_session_owner", lambda sid, auth: None)
    (tmp_path / "workspace").mkdir(parents=True, exist_ok=True)
    yield


class _Req:
    """Minimal Request stand-in: .stream() yields the given chunks."""

    def __init__(self, body: bytes, chunk: int = 4):
        self._body = body
        self._chunk = chunk
        self.headers = {"content-length": str(len(body))}

    async def stream(self):
        for i in range(0, len(self._body), self._chunk):
            yield self._body[i:i + self._chunk]
        if not self._body:
            yield b""


def _put(path: str, body: bytes, base_sha: str = ""):
    return asyncio.run(ac.put_workspace_file(
        _Req(body), session_id="s", path=path, base_sha=base_sha,
        device="test", auth={}))


def test_put_creates_exact_path_and_reports_sha(tmp_path):
    res = _put("workspace/proj/한글 파일.md", "본문입니다".encode())
    target = tmp_path / "workspace" / "proj" / "한글 파일.md"
    assert target.read_text(encoding="utf-8") == "본문입니다"
    assert res["path"] == "workspace/proj/한글 파일.md"
    assert res["latest_seq"] > 0
    import hashlib
    assert res["sha256"] == hashlib.sha256("본문입니다".encode()).hexdigest()


def test_put_optimistic_concurrency(tmp_path):
    """EFFECT PROOF: the 409 dance that stops two PCs clobbering each
    other — stale base_sha rejected WITH the server's current sha; the
    correct base_sha is accepted."""
    first = _put("workspace/doc.txt", b"v1")

    # Replica B thinks the file is new → 409 (it exists)
    with pytest.raises(HTTPException) as e1:
        _put("workspace/doc.txt", b"other", base_sha="")
    assert e1.value.status_code == 409
    assert e1.value.detail["current_sha"] == first["sha256"]

    # Replica B retries with a stale sha → 409 again
    with pytest.raises(HTTPException) as e2:
        _put("workspace/doc.txt", b"other", base_sha="deadbeef")
    assert e2.value.status_code == 409

    # Correct base → accepted
    res = _put("workspace/doc.txt", b"v2", base_sha=first["sha256"])
    assert (tmp_path / "workspace" / "doc.txt").read_bytes() == b"v2"
    assert res["sha256"] != first["sha256"]


def test_put_edit_wins_over_delete(tmp_path):
    """Edit-vs-delete: replica updates a file the server already deleted
    → the write is accepted (resurrect), never data loss."""
    first = _put("workspace/keep.txt", b"v1")
    (tmp_path / "workspace" / "keep.txt").unlink()
    res = _put("workspace/keep.txt", b"v2-edited-offline", base_sha=first["sha256"])
    assert res["ok"] and (tmp_path / "workspace" / "keep.txt").exists()


def test_put_guard_403_outside_workspace(tmp_path):
    for evil in ("memory/note.md", "workspace/../transcripts/x", "synapse.db"):
        with pytest.raises(HTTPException) as e:
            _put(evil, b"evil")
        assert e.value.status_code == 403


def test_put_cap_413(monkeypatch, tmp_path):
    monkeypatch.setenv("GENY_WORKSPACE_MAX_FILE_MB", "0")  # 0 MiB cap
    with pytest.raises(HTTPException) as e:
        _put("workspace/big.bin", b"anything")
    assert e.value.status_code == 413
    # temp dir left clean
    tmp_dir = tmp_path / ".geny-sync-tmp"
    assert not any(tmp_dir.iterdir()) if tmp_dir.exists() else True


def test_delete_base_sha_guard(tmp_path):
    first = _put("workspace/d.txt", b"v1")
    with pytest.raises(HTTPException) as e:
        asyncio.run(ac.storage_delete(
            session_id="s", path="workspace/d.txt", base_sha="stale", auth={}))
    assert e.value.status_code == 409
    res = asyncio.run(ac.storage_delete(
        session_id="s", path="workspace/d.txt", base_sha=first["sha256"], auth={}))
    assert res["ok"] and not (tmp_path / "workspace" / "d.txt").exists()


def test_changes_endpoint_cursor_roundtrip(tmp_path):
    """EFFECT PROOF: PUT → changes(sinceBefore) surfaces exactly that
    file with the sha the PUT reported; agent-style direct writes are
    also picked up (endpoint runs a rescan)."""
    boot = asyncio.run(ac.storage_changes(session_id="s", since=0, auth={}))
    cursor = boot["latest_seq"]
    assert boot["max_file_bytes"] > 0

    put = _put("workspace/sync.txt", b"payload")

    # agent writes directly to disk (no endpoint):
    (tmp_path / "workspace" / "agent.txt").write_bytes(b"by-agent")

    delta = asyncio.run(ac.storage_changes(session_id="s", since=cursor, auth={}))
    by_path = {c["path"]: c for c in delta["changes"]}
    assert by_path["sync.txt"]["sha256"] == put["sha256"]
    assert "agent.txt" in by_path
    assert delta["latest_seq"] >= put["latest_seq"]
