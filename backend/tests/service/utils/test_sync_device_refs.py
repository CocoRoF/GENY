"""Device refs + history — effect-proving tests.

A replica keeps the 3-way merge base locally. If that file is lost — a hard
power-off writes it without an fsync, a reinstall wipes it — the base is
unrecoverable from the replica's side, and it can no longer tell "the server
deleted this" from "I made this while away". Measured consequence on a
50-file workspace: every server-side deletion resurrected AND was pushed back
into the cloud.

The server holds the missing half: the last cursor it and a device agreed on.
Two properties have to hold for that to work, and both are pinned here:

  1. the ref advances monotonically and survives, and
  2. tombstones above a live device's cursor are NOT pruned — they are the
     only record that a deletion happened, so pruning them by age alone would
     resurrect the file on that device's next delta.
"""

from __future__ import annotations

import sqlite3
import time

import pytest

from service.utils import workspace_sync as ws


@pytest.fixture
def storage(tmp_path):
    root = tmp_path / "scope"
    (root / "workspace").mkdir(parents=True)
    return str(root)


# ── the ref itself ──────────────────────────────────────────────────

def test_unknown_device_has_no_ref(storage):
    assert ws.get_device_state(storage, "dev-1") is None


def test_ref_round_trips(storage):
    ws.set_device_state(storage, "dev-1", 42, "내-데스크톱")
    state = ws.get_device_state(storage, "dev-1")
    assert state["cursor"] == 42
    assert state["device_name"] == "내-데스크톱"
    assert state["acked_ts"] > 0, "recovery needs a timestamp to reason with"


def test_ref_never_moves_backwards(storage):
    """A replica holds its cursor back after a failed action; a stale retry
    must not rewind the agreement and widen the recovery window."""
    ws.set_device_state(storage, "dev-1", 100)
    ws.set_device_state(storage, "dev-1", 40)
    assert ws.get_device_state(storage, "dev-1")["cursor"] == 100


def test_devices_are_independent(storage):
    ws.set_device_state(storage, "dev-1", 10)
    ws.set_device_state(storage, "dev-2", 99)
    assert ws.get_device_state(storage, "dev-1")["cursor"] == 10
    assert ws.get_device_state(storage, "dev-2")["cursor"] == 99


# ── retention pinned by refs (the part that prevents resurrection) ───

def _tombstone(storage: str, path: str, seq: int, age_days: float) -> None:
    """Plant an aged tombstone directly — the TTL is 30 days, so producing
    one through the scan would mean waiting a month."""
    from datetime import datetime, timedelta, timezone

    old = (datetime.now(timezone.utc) - timedelta(days=age_days)).isoformat()
    conn = ws._connect(storage)
    try:
        conn.execute(
            "INSERT INTO entries(path, is_dir, size, mtime_ns, sha256, seq, "
            "deleted, updated_at) VALUES(?,0,0,0,'',?,1,?)",
            (path, seq, old),
        )
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('seq', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(seq + 100),),
        )
        conn.commit()
    finally:
        conn.close()


def _tombstones(storage: str) -> set:
    conn = ws._connect(storage)
    try:
        return {r[0] for r in conn.execute("SELECT path FROM entries WHERE deleted=1")}
    finally:
        conn.close()


def test_ancient_tombstone_is_pruned_when_no_device_needs_it(storage):
    _tombstone(storage, "old.txt", seq=10, age_days=60)
    ws.refresh_index(storage, "scope", force=True)
    assert "old.txt" not in _tombstones(storage)


def test_tombstone_above_a_live_device_cursor_survives_the_age_prune(storage):
    """THE property. dev-1 last agreed at seq 5; the deletion at seq 10 is
    the only record it will ever get, so age must not remove it."""
    _tombstone(storage, "deleted-while-away.txt", seq=10, age_days=60)
    ws.set_device_state(storage, "dev-1", 5)

    ws.refresh_index(storage, "scope", force=True)

    assert "deleted-while-away.txt" in _tombstones(storage), (
        "pruned a tombstone the replica has not seen — it will resurrect the file"
    )


def test_tombstone_below_every_device_cursor_is_still_pruned(storage):
    """Retention is pinned, not disabled: once every device has applied it,
    the tombstone is dead weight."""
    _tombstone(storage, "everyone-saw-it.txt", seq=10, age_days=60)
    ws.set_device_state(storage, "dev-1", 50)

    ws.refresh_index(storage, "scope", force=True)
    assert "everyone-saw-it.txt" not in _tombstones(storage)


def test_a_device_gone_past_the_pin_ttl_stops_holding_the_journal(storage):
    """Otherwise one machine that never comes back keeps every tombstone
    forever. Past the TTL it re-bootstraps instead — correct, just slower."""
    _tombstone(storage, "old.txt", seq=10, age_days=60)
    ws.set_device_state(storage, "ghost", 5)
    conn = ws._connect(storage)
    try:
        conn.execute(
            "UPDATE devices SET acked_ts=? WHERE device_id='ghost'",
            (int(time.time()) - ws._DEVICE_PIN_TTL_S - 86400,),
        )
        conn.commit()
    finally:
        conn.close()

    ws.refresh_index(storage, "scope", force=True)
    assert "old.txt" not in _tombstones(storage)


# ── history ─────────────────────────────────────────────────────────

def test_events_read_back_newest_first(storage):
    for i in range(3):
        ws.record_event(storage, actor_kind="web", actor="hr", action="added",
                        path=f"f{i}.txt", size=i)
    events = ws.list_events(storage)["events"]
    assert [e["path"] for e in events] == ["f2.txt", "f1.txt", "f0.txt"]
    assert events[0]["actor_kind"] == "web" and events[0]["actor"] == "hr"


def test_history_is_paginated(storage):
    for i in range(5):
        ws.record_event(storage, actor_kind="agent", actor="", action="added", path=f"f{i}")
    first = ws.list_events(storage, limit=2)
    assert len(first["events"]) == 2 and first["has_more"] is True
    second = ws.list_events(storage, limit=2, before_id=first["events"][-1]["id"])
    assert [e["path"] for e in second["events"]] == ["f2", "f1"]


def test_history_is_capped(storage):
    for i in range(ws._EVENT_CAP + 50):
        ws.record_event(storage, actor_kind="agent", actor="", action="added", path=f"f{i}")
    conn = ws._connect(storage)
    try:
        count = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    finally:
        conn.close()
    assert count <= ws._EVENT_CAP + 1, f"history grew unbounded ({count})"


def test_the_scan_does_not_duplicate_an_already_attributed_change(storage):
    """A web upload records itself (only it knows the actor); the scan then
    finds the same bytes on disk and must not file a second, wrong row."""
    (ws.Path(storage) / "workspace" / "up.txt").write_text("hello", encoding="utf-8")
    ws.record_event(storage, actor_kind="web", actor="hr", action="added", path="up.txt")

    ws.refresh_index(storage, "scope", force=True)

    rows = [e for e in ws.list_events(storage)["events"] if e["path"] == "up.txt"]
    assert len(rows) == 1, f"duplicate history rows: {rows}"
    assert rows[0]["actor_kind"] == "web", "attribution was overwritten by the scan"


def test_the_scan_attributes_unclaimed_changes_to_the_agent(storage):
    (ws.Path(storage) / "workspace" / "agent-made.txt").write_text("x", encoding="utf-8")
    ws.refresh_index(storage, "scope", force=True)
    rows = [e for e in ws.list_events(storage)["events"] if e["path"] == "agent-made.txt"]
    assert len(rows) == 1 and rows[0]["actor_kind"] == "agent"


def test_recording_never_raises_into_its_caller(storage, monkeypatch):
    """History runs AFTER the operation it describes has succeeded; a failure
    here must not turn finished work into an error."""
    def _boom(*_a, **_k):
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(ws, "_connect", _boom)
    ws.record_event(storage, actor_kind="web", actor="x", action="added", path="p")
