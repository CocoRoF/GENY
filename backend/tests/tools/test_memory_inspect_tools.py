"""Cycle 20260430_2 Stage B — progressive memory inspection tools.

Pins the four invariants for the inspection layer:

1. data lives only in the caller's own STM — no cross-session reads
2. counterpart aliases (paired_subworker / user / self) resolve
   correctly to the caller's bound id
3. read-only — tools never mutate any STM / file / state
4. result schemas remain stable so progressive disclosure
   (status → with → event → artifact) chains by event_id without
   re-querying.

This file initially covers B1 (memory_status). Subsequent PRs (B2..B4)
add their own test classes against the same fixture surface.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

from tools.built_in import memory_inspect_tools
from tools.built_in.memory_inspect_tools import (
    MemoryEventTool,
    MemoryStatusTool,
    MemoryWithTool,
    _resolve_counterpart_id,
)


# ─────────────────────────────────────────────────────────────────
# Fakes — minimal stand-ins for AgentSession + ShortTermMemory
# ─────────────────────────────────────────────────────────────────


class _FakeShortTerm:
    """Returns entries in chronological order (oldest → newest)."""

    def __init__(self, entries: List[Dict[str, Any]]) -> None:
        self._entries = entries

    def load_all(self) -> List[Any]:
        out = []
        for e in self._entries:
            out.append(SimpleNamespace(
                content=e.get("content", ""),
                timestamp=e.get("timestamp"),
                metadata=e.get("metadata") or {},
            ))
        return out


class _FakeMemoryManager:
    def __init__(self, entries: Optional[List[Dict[str, Any]]] = None) -> None:
        self._stm = _FakeShortTerm(entries or [])

    @property
    def short_term(self):
        return self._stm


class _FakeAgent:
    def __init__(
        self,
        session_id: str,
        *,
        owner_username: Optional[str] = None,
        linked_session_id: Optional[str] = None,
        session_type: Optional[str] = None,
        entries: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        self.session_id = session_id
        self._owner_username = owner_username
        self._linked_session_id = linked_session_id
        self._session_type = session_type
        self._memory_manager = _FakeMemoryManager(entries)


class _FakeManager:
    def __init__(self, agents: Dict[str, _FakeAgent]) -> None:
        self._agents = agents

    def get_agent(self, sid: str) -> Optional[_FakeAgent]:
        return self._agents.get(sid)

    def resolve_session(self, sid: str) -> Optional[_FakeAgent]:
        return self._agents.get(sid)


@pytest.fixture
def world(monkeypatch):
    """Default world: VTuber with bound Sub-Worker + a few seeded
    InteractionEvents on the VTuber's STM."""
    vtuber = _FakeAgent(
        "vtuber-1",
        owner_username="alice",
        linked_session_id="sub-1",
        session_type="vtuber",
        entries=[
            {
                "content": "[user] hello, my friend.",
                "metadata": {
                    "event_id": "EVT-USER-1",
                    "kind": "user_chat",
                    "direction": "in",
                    "counterpart_id": "owner:alice",
                    "counterpart_role": "user",
                },
            },
            {
                "content": "[assistant_dm] [DM to Sub-Worker (internal)]: please write notes.md",
                "metadata": {
                    "event_id": "EVT-REQ-1",
                    "kind": "task_request",
                    "direction": "out",
                    "counterpart_id": "sub-1",
                    "counterpart_role": "paired_subworker",
                },
            },
            {
                "content": "[assistant_dm] [Sub-Worker run] 1/1 tool calls, wrote 1 file(s).",
                "metadata": {
                    "event_id": "EVT-RUN-1",
                    "kind": "tool_run_summary",
                    "direction": "in",
                    "counterpart_id": "sub-1",
                    "counterpart_role": "paired_subworker",
                    "linked_event_id": "EVT-REQ-1",
                    "payload": {
                        "status": "ok",
                        "tools_used": ["Write"],
                        "files_written": ["notes.md"],
                        "duration_ms": 120,
                    },
                },
            },
        ],
    )
    sub = _FakeAgent(
        "sub-1", linked_session_id="vtuber-1", session_type="sub",
    )
    manager = _FakeManager({"vtuber-1": vtuber, "sub-1": sub})

    monkeypatch.setattr(
        memory_inspect_tools, "_get_agent_manager", lambda: manager,
    )
    # is_executing import target — mock to default False
    monkeypatch.setattr(
        "service.execution.agent_executor.is_executing",
        lambda sid: False,
        raising=False,
    )

    return {"manager": manager, "vtuber": vtuber, "sub": sub}


# ─────────────────────────────────────────────────────────────────
# _resolve_counterpart_id — alias resolution
# ─────────────────────────────────────────────────────────────────


def test_resolve_alias_paired_subworker(world) -> None:
    assert _resolve_counterpart_id(world["vtuber"], "paired_subworker") == "sub-1"
    assert _resolve_counterpart_id(world["vtuber"], "PAIRED_SUB") == "sub-1"


def test_resolve_alias_paired_vtuber_for_subworker_caller(world) -> None:
    """sub-worker side calls 'paired' to mean its bound vtuber."""
    assert _resolve_counterpart_id(world["sub"], "paired_vtuber") == "vtuber-1"
    assert _resolve_counterpart_id(world["sub"], "paired") == "vtuber-1"


def test_resolve_alias_user(world) -> None:
    assert _resolve_counterpart_id(world["vtuber"], "user") == "owner:alice"


def test_resolve_alias_self(world) -> None:
    assert _resolve_counterpart_id(world["vtuber"], "self") == "self"


def test_resolve_canonical_id_passthrough(world) -> None:
    assert _resolve_counterpart_id(world["vtuber"], "owner:bob") == "owner:bob"
    assert _resolve_counterpart_id(world["vtuber"], "session-xyz") == "session-xyz"


def test_resolve_returns_none_for_empty(world) -> None:
    assert _resolve_counterpart_id(world["vtuber"], None) is None
    assert _resolve_counterpart_id(world["vtuber"], "") is None


def test_resolve_paired_alias_when_unpaired_returns_none(world) -> None:
    """If the caller has no _linked_session_id, the alias collapses
    to None — caller surfaces this as paired=false rather than silently
    matching against an empty string."""
    world["vtuber"]._linked_session_id = ""
    assert _resolve_counterpart_id(world["vtuber"], "paired_subworker") is None


# ─────────────────────────────────────────────────────────────────
# memory_status — L0
# ─────────────────────────────────────────────────────────────────


def _run_status(tool: MemoryStatusTool, **kw) -> Dict[str, Any]:
    out = tool.run(session_id=kw.pop("session_id", "vtuber-1"), **kw)
    return json.loads(out)


def test_status_with_no_counterpart_returns_latest_event(world) -> None:
    out = _run_status(MemoryStatusTool())
    assert out["counterpart_id"] is None
    assert out["last_event"] is not None
    # Most recent event is the tool_run_summary (third in the seed)
    assert out["last_event"]["event_id"] == "EVT-RUN-1"
    assert out["last_event"]["kind"] == "tool_run_summary"


def test_status_filters_by_counterpart_paired_subworker(world) -> None:
    out = _run_status(MemoryStatusTool(), counterpart="paired_subworker")
    assert out["counterpart_id"] == "sub-1"
    assert out["paired"] is True
    # Latest event for sub-1 is the run; req is older.
    assert out["last_event"]["event_id"] == "EVT-RUN-1"
    assert out["last_event"]["status"] == "ok"
    assert out["last_event"]["files_written_count"] == 1


def test_status_filters_by_counterpart_user(world) -> None:
    out = _run_status(MemoryStatusTool(), counterpart="user")
    assert out["counterpart_id"] == "owner:alice"
    assert out["last_event"]["event_id"] == "EVT-USER-1"


def test_status_unpaired_alias_surfaces_paired_false(world) -> None:
    """Aliases that resolve to None (unpaired) surface as paired=false
    with last_event=None — the persona should not pretend a bond
    exists."""
    world["vtuber"]._linked_session_id = ""
    out = _run_status(MemoryStatusTool(), counterpart="paired_subworker")
    assert out["paired"] is False
    assert out["last_event"] is None


def test_status_is_executing_passes_through(world, monkeypatch) -> None:
    """When the resolved counterpart is a session id (not owner:/self),
    surface its in-flight state via the executor's is_executing()."""
    monkeypatch.setattr(
        "service.execution.agent_executor.is_executing",
        lambda sid: sid == "sub-1",
        raising=False,
    )
    out = _run_status(MemoryStatusTool(), counterpart="paired_subworker")
    assert out["is_executing"] is True


def test_status_is_executing_skipped_for_owner_id(world, monkeypatch) -> None:
    """User counterparts (owner:<name>) and self never execute — the
    helper must not consult the executor at all for them."""
    called: List[str] = []

    def _track(sid: str) -> bool:
        called.append(sid)
        return True

    monkeypatch.setattr(
        "service.execution.agent_executor.is_executing", _track, raising=False,
    )
    out = _run_status(MemoryStatusTool(), counterpart="user")
    assert out["is_executing"] is False
    assert called == []


def test_status_skips_legacy_entries_without_event_id(world) -> None:
    """Pre-unification STM lines (no metadata.event_id) must not show
    up as last_event — they would have no addressable id for follow-up
    drill."""
    legacy_only = _FakeAgent(
        "vtuber-2",
        owner_username="bob",
        linked_session_id="",
        session_type="vtuber",
        entries=[
            {
                "content": "[user] legacy",
                "metadata": {"role": "user"},
            },
        ],
    )
    world["manager"]._agents["vtuber-2"] = legacy_only
    out = _run_status(MemoryStatusTool(), session_id="vtuber-2")
    assert out["last_event"] is None


def test_status_unknown_session_returns_error(world) -> None:
    out = _run_status(MemoryStatusTool(), session_id="ghost")
    assert "error" in out


def test_status_caller_without_memory_manager_returns_error(world) -> None:
    world["vtuber"]._memory_manager = None
    out = _run_status(MemoryStatusTool())
    assert "error" in out


# ─────────────────────────────────────────────────────────────────
# memory_with — L1
# ─────────────────────────────────────────────────────────────────


def _run_with(tool: MemoryWithTool, **kw) -> Dict[str, Any]:
    out = tool.run(session_id=kw.pop("session_id", "vtuber-1"), **kw)
    return json.loads(out)


def test_with_returns_paired_subworker_events_newest_first(world) -> None:
    out = _run_with(MemoryWithTool(), counterpart="paired_subworker")
    assert out["counterpart_id"] == "sub-1"
    ids = [e["event_id"] for e in out["events"]]
    # Seeded order: REQ-1 (older), RUN-1 (newer). Expect newest first.
    assert ids == ["EVT-RUN-1", "EVT-REQ-1"]


def test_with_filters_by_kind(world) -> None:
    out = _run_with(
        MemoryWithTool(),
        counterpart="paired_subworker",
        kinds=["tool_run_summary"],
    )
    assert [e["kind"] for e in out["events"]] == ["tool_run_summary"]


def test_with_filters_by_user(world) -> None:
    out = _run_with(MemoryWithTool(), counterpart="user")
    assert out["counterpart_id"] == "owner:alice"
    ids = [e["event_id"] for e in out["events"]]
    assert ids == ["EVT-USER-1"]


def test_with_returns_empty_for_unpaired_alias(world) -> None:
    world["vtuber"]._linked_session_id = ""
    out = _run_with(MemoryWithTool(), counterpart="paired_subworker")
    assert out["counterpart_id"] is None
    assert out["events"] == []


def test_with_clamps_limit(world) -> None:
    """Out-of-range limits clamp to [1, _MAX_WITH_LIMIT] without raising."""
    out = _run_with(MemoryWithTool(), counterpart="paired_subworker", limit=999)
    # We only seeded 2 events for sub-1; clamp doesn't add events out of thin air.
    assert len(out["events"]) == 2
    out2 = _run_with(MemoryWithTool(), counterpart="paired_subworker", limit=0)
    # 0 → clamps to 1
    assert len(out2["events"]) == 1


def test_with_since_event_id_excludes_anchor_and_older(world) -> None:
    """`since=<event_id>` returns only events strictly *after* that
    anchor's timestamp. Need timestamps for that — seed them."""
    from datetime import datetime, timezone, timedelta
    base = datetime(2026, 4, 30, 12, 0, 0, tzinfo=timezone.utc)
    sub_entries = world["vtuber"]._memory_manager._stm._entries
    sub_entries[0]["timestamp"] = base
    sub_entries[1]["timestamp"] = base + timedelta(seconds=10)
    sub_entries[2]["timestamp"] = base + timedelta(seconds=20)
    out = _run_with(
        MemoryWithTool(),
        counterpart="paired_subworker",
        since="EVT-REQ-1",
    )
    ids = [e["event_id"] for e in out["events"]]
    assert ids == ["EVT-RUN-1"]


def test_with_since_iso_timestamp_supported(world) -> None:
    from datetime import datetime, timezone, timedelta
    base = datetime(2026, 4, 30, 12, 0, 0, tzinfo=timezone.utc)
    sub_entries = world["vtuber"]._memory_manager._stm._entries
    sub_entries[0]["timestamp"] = base
    sub_entries[1]["timestamp"] = base + timedelta(seconds=10)
    sub_entries[2]["timestamp"] = base + timedelta(seconds=20)
    cutoff = (base + timedelta(seconds=15)).isoformat()
    out = _run_with(
        MemoryWithTool(),
        counterpart="paired_subworker",
        since=cutoff,
    )
    ids = [e["event_id"] for e in out["events"]]
    assert ids == ["EVT-RUN-1"]


def test_with_skips_legacy_entries(world) -> None:
    """Pre-cycle STM lines (no event_id) must not show up — we have
    nothing to drill into."""
    sub_entries = world["vtuber"]._memory_manager._stm._entries
    sub_entries.append({
        "content": "[user] legacy",
        "metadata": {"role": "user"},  # no event_id
    })
    out = _run_with(MemoryWithTool(), counterpart="user")
    ids = [e["event_id"] for e in out["events"]]
    assert "EVT-USER-1" in ids
    # legacy entry has no event_id so it doesn't appear
    assert all(eid for eid in ids)


def test_with_unknown_session_returns_error(world) -> None:
    out = _run_with(MemoryWithTool(), session_id="ghost", counterpart="user")
    assert "error" in out


# ─────────────────────────────────────────────────────────────────
# memory_event — L2
# ─────────────────────────────────────────────────────────────────


def _run_event(tool: MemoryEventTool, **kw) -> Dict[str, Any]:
    out = tool.run(session_id=kw.pop("session_id", "vtuber-1"), **kw)
    return json.loads(out)


def test_event_returns_full_payload_and_parent_link(world) -> None:
    out = _run_event(MemoryEventTool(), event_id="EVT-RUN-1")
    ev = out["event"]
    assert ev["event_id"] == "EVT-RUN-1"
    assert ev["kind"] == "tool_run_summary"
    assert ev["direction"] == "in"
    assert ev["counterpart_id"] == "sub-1"
    assert ev["payload"]["files_written"] == ["notes.md"]
    assert ev["payload"]["status"] == "ok"
    assert ev["linked_event_id"] == "EVT-REQ-1"

    parent = out["linked"]["parent"]
    assert parent["event_id"] == "EVT-REQ-1"
    assert parent["kind"] == "task_request"


def test_event_returns_event_without_parent_when_no_linked(world) -> None:
    out = _run_event(MemoryEventTool(), event_id="EVT-USER-1")
    assert out["event"]["event_id"] == "EVT-USER-1"
    assert out["linked"] == {}


def test_event_marks_parent_missing_when_linked_id_absent_from_stm(world) -> None:
    """If a linked_event_id was recorded but its event isn't on this
    STM (rare — e.g. trimmed beyond MAX_TRANSCRIPT_ENTRIES), surface
    `missing: true` rather than a confusing empty linked block."""
    sub_entries = world["vtuber"]._memory_manager._stm._entries
    sub_entries.append({
        "content": "[assistant_dm] [Sub-Worker run]",
        "metadata": {
            "event_id": "EVT-RUN-2",
            "kind": "tool_run_summary",
            "direction": "in",
            "counterpart_id": "sub-1",
            "counterpart_role": "paired_subworker",
            "linked_event_id": "EVT-MISSING",
            "payload": {"status": "ok"},
        },
    })
    out = _run_event(MemoryEventTool(), event_id="EVT-RUN-2")
    assert out["linked"]["parent"] == {"event_id": "EVT-MISSING", "missing": True}


def test_event_unknown_event_id_returns_error(world) -> None:
    out = _run_event(MemoryEventTool(), event_id="EVT-NOPE")
    assert "error" in out


def test_event_empty_event_id_returns_error(world) -> None:
    out = _run_event(MemoryEventTool(), event_id="")
    assert "error" in out


def test_event_unknown_session_returns_error(world) -> None:
    out = _run_event(MemoryEventTool(), session_id="ghost", event_id="EVT-USER-1")
    assert "error" in out


def test_event_caller_only_sees_own_stm(world) -> None:
    """An event_id that lives on a *different* session's STM must not
    leak — invariant 3 (caller's own memory only). The fake manager
    only ever returns the caller's own STM, so the lookup must miss."""
    sub_entries = world["sub"]._memory_manager._stm._entries
    sub_entries.append({
        "content": "[assistant] private",
        "metadata": {
            "event_id": "EVT-SECRET",
            "kind": "user_chat",
            "direction": "out",
            "counterpart_id": "owner:bob",
            "counterpart_role": "user",
        },
    })
    # Caller is vtuber-1; should NOT find sub-1's event
    out = _run_event(MemoryEventTool(), event_id="EVT-SECRET")
    assert "error" in out
