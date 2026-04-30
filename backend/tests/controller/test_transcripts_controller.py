"""Cycle 20260430_3 Stage A — transcripts controller tests.

Pins the contract of the operator-facing read API over the
InteractionEvent stream:

  - list endpoint walks newest-first, applies filters, paginates
    via cursor over event_id;
  - detail endpoint returns full payload + linked parent;
  - counterparts endpoint aggregates by counterpart_id with
    last_ts and most-recent role.

The controller renders events via its *own* `_summarise_event_dict`
mirroring memory_inspect_tools so the operator UI and the LLM
tools share schema. A wire-shape test pins the overlap.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from controller import transcripts_controller as tc
from controller.transcripts_controller import router


# ─────────────────────────────────────────────────────────────────
# Fakes
# ─────────────────────────────────────────────────────────────────


class _FakeShortTerm:
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
    def __init__(self, session_id: str, entries=None) -> None:
        self.session_id = session_id
        self._memory_manager = _FakeMemoryManager(entries)


class _FakeAgentManager:
    def __init__(self, agents: Dict[str, _FakeAgent]) -> None:
        self._agents = agents

    def get_agent(self, sid: str) -> Optional[_FakeAgent]:
        return self._agents.get(sid)


# ─────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────


def _make_app(monkeypatch, agents: Dict[str, _FakeAgent]) -> TestClient:
    monkeypatch.setattr(
        tc, "get_agent_session_manager", lambda: _FakeAgentManager(agents),
    )
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _seed_events() -> List[Dict[str, Any]]:
    base = datetime(2026, 4, 30, 12, 0, 0, tzinfo=timezone.utc)
    return [
        {
            "content": "[user] hi",
            "timestamp": base,
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
            "timestamp": base + timedelta(seconds=10),
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
            "timestamp": base + timedelta(seconds=20),
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
        {
            "content": "[internal_trigger] [THINKING_TRIGGER:first_idle]",
            "timestamp": base + timedelta(seconds=30),
            "metadata": {
                "event_id": "EVT-REF-1",
                "kind": "reflection",
                "direction": "internal",
                "counterpart_id": "self",
                "counterpart_role": "self",
                "payload": {"trigger_category": "first_idle"},
            },
        },
        # legacy line — must be ignored
        {
            "content": "[user] legacy hi",
            "timestamp": base + timedelta(seconds=40),
            "metadata": {"role": "user"},
        },
    ]


# ─────────────────────────────────────────────────────────────────
# list_transcripts
# ─────────────────────────────────────────────────────────────────


def test_list_returns_events_newest_first(monkeypatch):
    client = _make_app(monkeypatch, {"vtuber-1": _FakeAgent("vtuber-1", _seed_events())})
    res = client.get("/api/agents/vtuber-1/transcripts")
    assert res.status_code == 200
    data = res.json()
    ids = [e["event_id"] for e in data["events"]]
    # legacy line excluded; reflection most recent
    assert ids == ["EVT-REF-1", "EVT-RUN-1", "EVT-REQ-1", "EVT-USER-1"]
    assert data["total_estimate"] == 4
    assert data["has_more"] is False
    assert data["next_cursor"] is None


def test_list_paginates_via_cursor(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    page1 = client.get("/api/agents/v/transcripts?limit=2").json()
    assert len(page1["events"]) == 2
    assert page1["has_more"] is True
    cursor = page1["next_cursor"]
    assert cursor is not None

    page2 = client.get(f"/api/agents/v/transcripts?limit=2&cursor={cursor}").json()
    page1_ids = [e["event_id"] for e in page1["events"]]
    page2_ids = [e["event_id"] for e in page2["events"]]
    assert set(page1_ids).isdisjoint(set(page2_ids))
    # All four events visible across two pages
    assert len(page1_ids) + len(page2_ids) == 4


def test_list_filters_by_counterpart(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    data = client.get("/api/agents/v/transcripts?counterpart=sub-1").json()
    ids = [e["event_id"] for e in data["events"]]
    assert ids == ["EVT-RUN-1", "EVT-REQ-1"]
    assert data["total_estimate"] == 2


def test_list_filters_by_kinds_csv(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    data = client.get(
        "/api/agents/v/transcripts?kinds=tool_run_summary,task_result",
    ).json()
    ids = [e["event_id"] for e in data["events"]]
    assert ids == ["EVT-RUN-1"]


def test_list_filters_by_direction(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    data = client.get("/api/agents/v/transcripts?direction=internal").json()
    ids = [e["event_id"] for e in data["events"]]
    assert ids == ["EVT-REF-1"]


def test_list_filters_by_since_event_id(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    data = client.get("/api/agents/v/transcripts?since=EVT-REQ-1").json()
    ids = [e["event_id"] for e in data["events"]]
    # strictly after EVT-REQ-1's timestamp → REF-1, RUN-1
    assert ids == ["EVT-REF-1", "EVT-RUN-1"]


def test_list_filters_combine(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    data = client.get(
        "/api/agents/v/transcripts?counterpart=sub-1&kinds=tool_run_summary",
    ).json()
    ids = [e["event_id"] for e in data["events"]]
    assert ids == ["EVT-RUN-1"]


def test_list_clamps_limit(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    res = client.get("/api/agents/v/transcripts?limit=999")
    # FastAPI Query(le=200) enforces 422 on over-cap
    assert res.status_code == 422


def test_list_unknown_session_returns_404(monkeypatch):
    client = _make_app(monkeypatch, {})
    res = client.get("/api/agents/ghost/transcripts")
    assert res.status_code == 404


def test_list_excludes_legacy_lines(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    data = client.get("/api/agents/v/transcripts").json()
    # legacy entry has metadata={"role":"user"} only — must not appear
    assert all(e.get("event_id") for e in data["events"])
    assert data["total_estimate"] == 4  # 5 entries minus 1 legacy


# ─────────────────────────────────────────────────────────────────
# get_transcript_event (detail)
# ─────────────────────────────────────────────────────────────────


def test_detail_returns_full_payload_and_parent(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    data = client.get("/api/agents/v/transcripts/EVT-RUN-1").json()
    assert data["event"]["event_id"] == "EVT-RUN-1"
    assert data["event"]["payload"]["files_written"] == ["notes.md"]
    parent = data["linked"]["parent"]
    assert parent["event_id"] == "EVT-REQ-1"
    assert parent["kind"] == "task_request"


def test_detail_unknown_event_returns_404(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    res = client.get("/api/agents/v/transcripts/EVT-NOPE")
    assert res.status_code == 404


def test_detail_event_without_parent(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    data = client.get("/api/agents/v/transcripts/EVT-USER-1").json()
    assert data["linked"] == {}


def test_detail_marks_missing_parent(monkeypatch):
    seed = _seed_events()
    seed[2]["metadata"]["linked_event_id"] = "EVT-MISSING"
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", seed)})
    data = client.get("/api/agents/v/transcripts/EVT-RUN-1").json()
    assert data["linked"]["parent"] == {"event_id": "EVT-MISSING", "missing": True}


# ─────────────────────────────────────────────────────────────────
# list_counterparts
# ─────────────────────────────────────────────────────────────────


def test_counterparts_aggregates_by_id(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    data = client.get("/api/agents/v/transcripts/counterparts").json()
    ids = {c["id"]: c for c in data["counterparts"]}
    assert ids["sub-1"]["events"] == 2
    assert ids["sub-1"]["role"] == "paired_subworker"
    assert ids["owner:alice"]["events"] == 1
    assert ids["owner:alice"]["role"] == "user"
    assert ids["self"]["events"] == 1


def test_counterparts_sorted_by_last_ts_desc(monkeypatch):
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", _seed_events())})
    data = client.get("/api/agents/v/transcripts/counterparts").json()
    ids = [c["id"] for c in data["counterparts"]]
    # Most recent: REF (self) → RUN (sub-1) → USER (owner:alice)
    assert ids == ["self", "sub-1", "owner:alice"]


def test_counterparts_empty_for_legacy_only_session(monkeypatch):
    seed = [{
        "content": "[user] legacy",
        "timestamp": datetime.now(timezone.utc),
        "metadata": {"role": "user"},
    }]
    client = _make_app(monkeypatch, {"v": _FakeAgent("v", seed)})
    data = client.get("/api/agents/v/transcripts/counterparts").json()
    assert data["counterparts"] == []


def test_counterparts_unknown_session_404(monkeypatch):
    client = _make_app(monkeypatch, {})
    assert client.get("/api/agents/ghost/transcripts/counterparts").status_code == 404


# ─────────────────────────────────────────────────────────────────
# wire-shape parity with memory_inspect_tools._summarise_event
# ─────────────────────────────────────────────────────────────────


def test_summary_schema_matches_memory_inspect_tools(monkeypatch):
    """Both surfaces must render the same summary fields so the
    operator UI and the VTuber's own tools agree on event shape."""
    from tools.built_in.memory_inspect_tools import _summarise_event

    seed_entry = SimpleNamespace(
        content="[assistant_dm] sample",
        timestamp=datetime(2026, 4, 30, 12, 0, 0, tzinfo=timezone.utc),
        metadata={
            "event_id": "X",
            "kind": "tool_run_summary",
            "direction": "in",
            "counterpart_id": "sub-1",
            "counterpart_role": "paired_subworker",
            "linked_event_id": "P",
            "payload": {
                "status": "ok",
                "tools_used": ["Write"],
                "files_written": ["a.md"],
            },
        },
    )
    backend = tc._summarise_event_dict(seed_entry, seed_entry.metadata)
    tool = _summarise_event(seed_entry, seed_entry.metadata)
    assert set(backend.keys()) == set(tool.keys())
    # And the values match for these stable fields
    for k in ("event_id", "kind", "direction", "counterpart_id",
              "counterpart_role", "linked_event_id", "status",
              "files_written_count", "tools_used_count"):
        assert backend.get(k) == tool.get(k), k
