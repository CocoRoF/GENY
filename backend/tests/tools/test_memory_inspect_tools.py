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
    MemoryStatusTool,
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
