"""P4 hardening — chunked/resumable upload, quota, watch, scale.

Effect-proving: every test asserts the measured behaviour the connector
depends on (resume points, 507 payloads, notify latency, rescan cost).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time

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
    def __init__(self, body: bytes, headers: dict | None = None):
        self._body = body
        self.headers = headers or {"content-length": str(len(body))}

    async def stream(self):
        for i in range(0, len(self._body), 7):
            yield self._body[i:i + 7]
        if not self._body:
            yield b""


# ── chunked upload ────────────────────────────────────────────────────


def _start(path: str, data: bytes):
    return asyncio.run(ac.chunk_upload_start(
        session_id="s", path=path, size=len(data),
        sha256=hashlib.sha256(data).hexdigest(), auth={}))


def test_chunk_flow_and_resume(tmp_path):
    """EFFECT PROOF: parts land sequentially, the resume endpoint reports
    the exact byte offset after an interruption, and commit materialises
    the file atomically at the target path."""
    data = ("긴 파일 내용 " * 500).encode()
    st = _start("workspace/big/데이터.bin", data)
    uid = st["upload_id"]

    half = len(data) // 2
    r1 = asyncio.run(ac.chunk_upload_part(
        _Req(data[:half]), session_id="s", upload_id=uid, offset=0, auth={}))
    assert r1["received"] == half

    # "connection dropped" — replica asks where to resume
    state = asyncio.run(ac.chunk_upload_state(session_id="s", upload_id=uid, auth={}))
    assert state["received"] == half

    r2 = asyncio.run(ac.chunk_upload_part(
        _Req(data[half:]), session_id="s", upload_id=uid, offset=half, auth={}))
    assert r2["received"] == len(data)

    res = asyncio.run(ac.chunk_upload_commit(
        session_id="s", upload_id=uid, base_sha="", auth={}))
    assert res["ok"] and res["sha256"] == hashlib.sha256(data).hexdigest()
    assert (tmp_path / "workspace" / "big" / "데이터.bin").read_bytes() == data
    # staging cleaned
    assert not list((tmp_path / ".geny-sync-tmp" / "chunks").glob("*"))


def test_chunk_out_of_order_rejected_with_resume_point(tmp_path):
    data = b"0123456789"
    uid = _start("workspace/x.bin", data)["upload_id"]
    asyncio.run(ac.chunk_upload_part(_Req(data[:4]), session_id="s", upload_id=uid, offset=0, auth={}))
    with pytest.raises(HTTPException) as e:
        asyncio.run(ac.chunk_upload_part(_Req(data[6:]), session_id="s", upload_id=uid, offset=6, auth={}))
    assert e.value.status_code == 409 and e.value.detail["received"] == 4


def test_chunk_commit_verifies_hash_and_conflict(tmp_path):
    data = b"real content"
    # hash mismatch → 422 + staging dropped
    st = asyncio.run(ac.chunk_upload_start(
        session_id="s", path="workspace/y.bin", size=len(data),
        sha256="0" * 64, auth={}))
    asyncio.run(ac.chunk_upload_part(_Req(data), session_id="s", upload_id=st["upload_id"], offset=0, auth={}))
    with pytest.raises(HTTPException) as e:
        asyncio.run(ac.chunk_upload_commit(session_id="s", upload_id=st["upload_id"], base_sha="", auth={}))
    assert e.value.status_code == 422

    # conflict: target changed while uploading → 409 with current sha
    (tmp_path / "workspace" / "z.bin").write_bytes(b"someone else won")
    st2 = _start("workspace/z.bin", data)
    asyncio.run(ac.chunk_upload_part(_Req(data), session_id="s", upload_id=st2["upload_id"], offset=0, auth={}))
    with pytest.raises(HTTPException) as e2:
        asyncio.run(ac.chunk_upload_commit(session_id="s", upload_id=st2["upload_id"], base_sha="stale", auth={}))
    assert e2.value.status_code == 409
    assert e2.value.detail["current_sha"] == hashlib.sha256(b"someone else won").hexdigest()


def test_chunk_guard_and_id_validation(tmp_path):
    with pytest.raises(HTTPException) as e:
        _start("memory/evil.bin", b"x")
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e2:
        asyncio.run(ac.chunk_upload_state(session_id="s", upload_id="../../etc/passwd", auth={}))
    assert e2.value.status_code == 400


# ── quota ─────────────────────────────────────────────────────────────


def test_quota_507_on_put_and_chunk_start(tmp_path, monkeypatch):
    """EFFECT PROOF: writes that would push the workspace past the quota
    are refused with 507 + the numbers the UI needs."""
    monkeypatch.setenv("GENY_WORKSPACE_QUOTA_MB", "1")  # 1 MiB quota
    big = b"x" * (700 * 1024)
    r = asyncio.run(ac.put_workspace_file(
        _Req(big), session_id="s", path="workspace/a.bin", base_sha="", device="", auth={}))
    assert r["ok"]

    with pytest.raises(HTTPException) as e:
        asyncio.run(ac.put_workspace_file(
            _Req(big), session_id="s", path="workspace/b.bin", base_sha="", device="", auth={}))
    assert e.value.status_code == 507
    assert e.value.detail["used_bytes"] >= len(big)
    assert e.value.detail["quota_bytes"] == 1024 * 1024

    with pytest.raises(HTTPException) as e2:
        _start("workspace/c.bin", big)
    assert e2.value.status_code == 507

    # changes response carries the quota numbers
    res = asyncio.run(ac.storage_changes(session_id="s", since=0, auth={}))
    assert res["quota_bytes"] == 1024 * 1024 and res["used_bytes"] >= len(big)


def test_quota_zero_disables(tmp_path, monkeypatch):
    monkeypatch.setenv("GENY_WORKSPACE_QUOTA_MB", "0")
    r = asyncio.run(ac.put_workspace_file(
        _Req(b"y" * 2048), session_id="s", path="workspace/free.bin",
        base_sha="", device="", auth={}))
    assert r["ok"]


# ── inotify watch (watchfiles) ────────────────────────────────────────


@pytest.mark.asyncio
async def test_watch_detects_agent_write_and_notifies(tmp_path):
    """EFFECT PROOF: a direct disk write (agent-style, no endpoint) fires
    the hub event via the watchfiles loop within a couple of seconds."""
    pytest.importorskip("watchfiles")
    from ws.workspace_stream import WorkspaceHub, _Device

    hub = WorkspaceHub()
    dev = _Device(ws=None, device_id="t", device_name="t", user="t")  # type: ignore[arg-type]
    hub.add("sess", dev, str(tmp_path))
    assert hub.watch_active("sess")
    event = hub.event_for("sess")
    try:
        await asyncio.sleep(0.3)  # let the watcher arm
        (tmp_path / "workspace" / "에이전트파일.txt").write_text("agent wrote this")
        await asyncio.wait_for(event.wait(), timeout=5.0)
        assert (hub.latest("sess") or 0) > 0
    finally:
        hub.remove("sess", dev)
        assert not hub.watch_active("sess")


# ── scale ─────────────────────────────────────────────────────────────


def test_10k_files_incremental_rescan_fast(tmp_path):
    """EFFECT PROOF (perf gate): 10,000 files — the no-change rescan
    (the steady-state cost every poll pays) stays under 1s and hashes 0."""
    ws = tmp_path / "workspace"
    for d in range(100):
        sub = ws / f"d{d:03d}"
        sub.mkdir(parents=True)
        for f in range(100):
            (sub / f"f{f:03d}.txt").write_bytes(b"c" * 64)

    t0 = time.monotonic()
    first = wsync.refresh_index(str(tmp_path), force=True)
    first_s = time.monotonic() - t0
    assert first["hashed"] == 10_000

    t1 = time.monotonic()
    second = wsync.refresh_index(str(tmp_path), force=True)
    steady_s = time.monotonic() - t1
    assert second["hashed"] == 0
    assert steady_s < 1.0, f"steady-state rescan too slow: {steady_s:.2f}s"
    print(f"\n10k files: first scan {first_s:.2f}s, steady-state {steady_s*1000:.0f}ms")


# ── streaming-race + self-heal (multi-PC audit) ───────────────────────


def test_put_race_during_stream_rejected(tmp_path):
    """EFFECT PROOF: the target changes WHILE a PUT is streaming (another
    PC won the race). The pre-check passed, but the final locked
    re-verify must 409 — never a silent last-writer-wins."""
    target = tmp_path / "workspace" / "raced.txt"
    target.write_bytes(b"v1")
    v1_sha = hashlib.sha256(b"v1").hexdigest()

    class _RacingReq:
        headers = {"content-length": "20"}

        async def stream(self):
            yield b"replica-A-part1 "
            # replica B lands its write mid-stream
            target.write_bytes(b"replica-B-won")
            yield b"tail"

    with pytest.raises(HTTPException) as e:
        asyncio.run(ac.put_workspace_file(
            _RacingReq(), session_id="s", path="workspace/raced.txt",
            base_sha=v1_sha, device="", auth={}))
    assert e.value.status_code == 409
    assert e.value.detail["current_sha"] == hashlib.sha256(b"replica-B-won").hexdigest()
    # B's content intact, A's partial upload not applied, no temp leak
    assert target.read_bytes() == b"replica-B-won"
    assert not list((tmp_path / ".geny-sync-tmp").glob("put-*"))


def test_index_corruption_self_heals(tmp_path):
    """EFFECT PROOF: a corrupt index db is dropped and rebuilt — the
    protocol keeps working (derived state, tombstones sacrificed)."""
    (tmp_path / "workspace" / "keep.txt").write_bytes(b"k")
    wsync.refresh_index(str(tmp_path), force=True)
    db = tmp_path / ".geny-sync" / "index.db"
    db.write_bytes(b"THIS IS NOT SQLITE" * 100)
    for suffix in ("-wal", "-shm"):
        (tmp_path / ".geny-sync" / f"index.db{suffix}").unlink(missing_ok=True)

    stats = wsync.refresh_index(str(tmp_path), force=True)
    assert stats["latest_seq"] > 0
    paths = {c["path"] for c in wsync.changes_since(str(tmp_path), 0)["changes"]}
    assert "keep.txt" in paths
