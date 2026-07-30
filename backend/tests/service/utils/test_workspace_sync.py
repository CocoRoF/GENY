"""Workspace sync index — effect-proving tests.

Doctrine: each test asserts the MEASURED property the sync protocol
depends on (rehash counts, cursor convergence, tombstones), not merely
that code ran.
"""

from __future__ import annotations

import os
import time

import pytest

from service.utils import workspace_sync as wsync


@pytest.fixture(autouse=True)
def _no_throttle(monkeypatch):
    """Tests drive refresh_index directly — disable the 2s scan throttle."""
    monkeypatch.setattr(wsync, "_SCAN_THROTTLE_S", 0.0)
    yield


def _mk(tmp_path, rel: str, content: bytes = b"x"):
    p = tmp_path / "workspace" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)
    return p


def test_bootstrap_and_incremental_rehash_minimal(tmp_path):
    """EFFECT PROOF: first scan hashes everything; a second scan with ONE
    changed file rehashes exactly one file — (mtime_ns,size) shortcut."""
    for i in range(20):
        _mk(tmp_path, f"dir{i % 3}/f{i}.txt", f"내용 {i}".encode())

    s1 = wsync.refresh_index(str(tmp_path), force=True)
    assert s1["added"] == 20 + 3  # 20 files + 3 dirs
    assert s1["hashed"] == 20

    s2 = wsync.refresh_index(str(tmp_path), force=True)
    assert s2["hashed"] == 0 and s2["added"] == 0 and s2["updated"] == 0
    assert s2["latest_seq"] == s1["latest_seq"]

    target = tmp_path / "workspace" / "dir0/f0.txt"
    target.write_bytes(b"changed!")
    os.utime(target, ns=(time.time_ns(), time.time_ns()))
    s3 = wsync.refresh_index(str(tmp_path), force=True)
    assert s3["hashed"] == 1 and s3["updated"] == 1
    assert s3["latest_seq"] == s1["latest_seq"] + 1


def test_cursor_semantics_and_tombstones(tmp_path):
    """EFFECT PROOF: changes_since(cursor) returns exactly the delta, and
    deletions surface as tombstones so offline replicas converge."""
    _mk(tmp_path, "a.txt", b"A")
    _mk(tmp_path, "sub/b.txt", b"B")
    s1 = wsync.refresh_index(str(tmp_path), force=True)
    cursor = s1["latest_seq"]

    boot = wsync.changes_since(str(tmp_path), 0)
    assert {c["path"] for c in boot["changes"]} == {"a.txt", "sub", "sub/b.txt"}
    assert not any(c["deleted"] for c in boot["changes"])

    # no-op delta
    assert wsync.changes_since(str(tmp_path), cursor)["changes"] == []

    # delete a file + add a new one
    (tmp_path / "workspace" / "a.txt").unlink()
    _mk(tmp_path, "c.txt", b"C")
    wsync.refresh_index(str(tmp_path), force=True)

    delta = wsync.changes_since(str(tmp_path), cursor)
    by_path = {c["path"]: c for c in delta["changes"]}
    assert by_path["a.txt"]["deleted"] is True
    assert by_path["c.txt"]["deleted"] is False and by_path["c.txt"]["sha256"]
    assert set(by_path) == {"a.txt", "c.txt"}

    # bootstrap AFTER the delete: tombstone must NOT appear
    boot2 = wsync.changes_since(str(tmp_path), 0)
    assert "a.txt" not in {c["path"] for c in boot2["changes"]}


def test_ignores_heavy_dirs_and_sync_infra(tmp_path):
    """EFFECT PROOF: node_modules/.venv style trees and our own sync
    machinery never enter the index (no cross-replica library storms)."""
    _mk(tmp_path, "src/app.py", b"code")
    _mk(tmp_path, "node_modules/lodash/index.js", b"lib" * 1000)
    _mk(tmp_path, ".venv/lib/python3.12/site-packages/x.py", b"lib")
    _mk(tmp_path, "__pycache__/app.cpython-312.pyc", b"bin")
    _mk(tmp_path, ".canvas-preview/abc/1/page.svg", b"svg")
    _mk(tmp_path, "report.tmp", b"partial")
    _mk(tmp_path, "~$doc.docx", b"lock")

    wsync.refresh_index(str(tmp_path), force=True)
    paths = {c["path"] for c in wsync.changes_since(str(tmp_path), 0)["changes"]}
    assert "src/app.py" in paths and "src" in paths
    assert not any(p.startswith(("node_modules", ".venv", "__pycache__",
                                 ".canvas-preview")) for p in paths)
    assert "report.tmp" not in paths and "~$doc.docx" not in paths


def test_gitignore_respected(tmp_path):
    (tmp_path / ".gitignore").write_text("secret/\n*.log\n", encoding="utf-8")
    _mk(tmp_path, "secret/key.pem", b"k")
    _mk(tmp_path, "run.log", b"l")
    _mk(tmp_path, "keep.txt", b"k")
    wsync.refresh_index(str(tmp_path), force=True)
    paths = {c["path"] for c in wsync.changes_since(str(tmp_path), 0)["changes"]}
    assert "keep.txt" in paths
    assert "run.log" not in paths and not any(p.startswith("secret") for p in paths)


def test_symlinks_never_indexed(tmp_path):
    _mk(tmp_path, "real.txt", b"r")
    ws = tmp_path / "workspace"
    (ws / "link.txt").symlink_to(ws / "real.txt")
    (ws / "dirlink").symlink_to(ws)
    wsync.refresh_index(str(tmp_path), force=True)
    paths = {c["path"] for c in wsync.changes_since(str(tmp_path), 0)["changes"]}
    assert paths == {"real.txt"}


def test_empty_dirs_sync(tmp_path):
    """Empty folders are first-class (the explorer creates them; replicas
    must materialise them)."""
    (tmp_path / "workspace" / "empty" / "nested").mkdir(parents=True)
    wsync.refresh_index(str(tmp_path), force=True)
    boot = wsync.changes_since(str(tmp_path), 0)
    dirs = {c["path"] for c in boot["changes"] if c["is_dir"]}
    assert {"empty", "empty/nested"} <= dirs

    (tmp_path / "workspace" / "empty" / "nested").rmdir()
    wsync.refresh_index(str(tmp_path), force=True)
    latest = wsync.changes_since(str(tmp_path), 0)
    live_dirs = {c["path"] for c in latest["changes"] if c["is_dir"]}
    assert "empty/nested" not in live_dirs


def test_seq_monotonic_across_reopen(tmp_path):
    """seq survives process restarts (index is the durable journal)."""
    _mk(tmp_path, "one.txt", b"1")
    s1 = wsync.refresh_index(str(tmp_path), force=True)
    _mk(tmp_path, "two.txt", b"2")
    s2 = wsync.refresh_index(str(tmp_path), force=True)
    assert s2["latest_seq"] > s1["latest_seq"]
    assert wsync.latest_seq(str(tmp_path)) == s2["latest_seq"]


def test_throttle_collapses_scan_storms(tmp_path, monkeypatch):
    """EFFECT PROOF: rapid non-forced refreshes collapse into one scan."""
    monkeypatch.setattr(wsync, "_SCAN_THROTTLE_S", 60.0)
    _mk(tmp_path, "x.txt", b"x")
    first = wsync.refresh_index(str(tmp_path))
    assert first.get("throttled") != 1
    second = wsync.refresh_index(str(tmp_path))
    assert second.get("throttled") == 1
