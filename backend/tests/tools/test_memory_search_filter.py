"""Cycle 20260430_2 B5 — memory_search filter extension.

The existing `memory_search` tool stays usable in its old shape;
this PR adds optional `counterpart` and `kinds` filters that
narrow InteractionEvent hits without affecting non-event hits
(LTM notes, curated knowledge, etc.).
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

from tools.built_in import memory_tools
from tools.built_in.memory_tools import MemorySearchTool


# ─────────────────────────────────────────────────────────────────
# Fakes — minimal shapes for SearchResult + MemoryEntry surface
# ─────────────────────────────────────────────────────────────────


class _FakeEntry:
    """Mirrors MemoryEntry's read surface that MemorySearchTool consumes."""

    def __init__(
        self,
        *,
        filename: str = "x",
        source: str = "short_term",
        metadata: Optional[Dict[str, Any]] = None,
        title: Optional[str] = None,
        category: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> None:
        self.filename = filename
        # MemorySearchTool checks `hasattr(entry.source, "value")`,
        # so use a plain string for a stable comparison in tests.
        self.source = source
        self.metadata = metadata or {}
        self.title = title
        self.category = category
        self.tags = tags


class _FakeResult:
    def __init__(self, entry: _FakeEntry, *, snippet: str = "...", score: float = 1.0) -> None:
        self.entry = entry
        self.snippet = snippet
        self.score = score


class _FakeMemoryManager:
    def __init__(self, results: List[_FakeResult]) -> None:
        self._results = results

    def search(self, query: str, max_results: int = 10) -> List[_FakeResult]:
        return self._results[:max_results]


class _FakeAgent:
    def __init__(
        self,
        session_id: str,
        *,
        owner_username: Optional[str] = None,
        linked_session_id: Optional[str] = None,
    ) -> None:
        self.session_id = session_id
        self._owner_username = owner_username
        self._linked_session_id = linked_session_id


@pytest.fixture
def search_world(monkeypatch):
    """Seed a search result mix: two InteractionEvent hits (one for
    sub-1, one for owner:alice) plus one non-event LTM note that
    should never be filtered out."""
    results = [
        _FakeResult(_FakeEntry(
            filename="topics/notes-md.md",
            source="long_term",
            # No metadata.event_id → non-event memory
            metadata={"role": "note"},
            title="notes",
            category="topics",
            tags=["docs"],
        ), snippet="durable knowledge note", score=0.95),
        _FakeResult(_FakeEntry(
            filename="transcripts/session.jsonl",
            metadata={
                "event_id": "EVT-USER-1",
                "kind": "user_chat",
                "direction": "in",
                "counterpart_id": "owner:alice",
                "counterpart_role": "user",
            },
        ), snippet="hello, my friend.", score=0.8),
        _FakeResult(_FakeEntry(
            filename="transcripts/session.jsonl",
            metadata={
                "event_id": "EVT-RUN-1",
                "kind": "tool_run_summary",
                "direction": "in",
                "counterpart_id": "sub-1",
                "counterpart_role": "paired_subworker",
                "payload": {"status": "ok", "files_written": ["notes.md"]},
            },
        ), snippet="Sub-Worker run] 1/1 tool calls", score=0.7),
    ]

    vtuber = _FakeAgent(
        "vtuber-1", owner_username="alice", linked_session_id="sub-1",
    )
    sub = _FakeAgent("sub-1", linked_session_id="vtuber-1")
    agents = {"vtuber-1": vtuber, "sub-1": sub}

    class _AgentManager:
        def get_agent(self, sid: str): return agents.get(sid)
        def resolve_session(self, sid: str): return agents.get(sid)

    # MemorySearchTool's internal helper looks up the memory manager
    # via the executor's get_agent_session_manager().
    monkeypatch.setattr(
        memory_tools, "_get_memory_manager",
        lambda sid: _FakeMemoryManager(results),
    )

    # The InteractionEvent filter helpers reach into memory_inspect_tools
    # for caller resolution; mock that path.
    from tools.built_in import memory_inspect_tools
    monkeypatch.setattr(
        memory_inspect_tools, "_get_agent_manager", lambda: _AgentManager(),
    )

    return {"vtuber": vtuber, "sub": sub, "results": results}


def _run_search(**kw) -> Dict[str, Any]:
    out = MemorySearchTool().run(
        session_id=kw.pop("session_id", "vtuber-1"),
        query=kw.pop("query", "anything"),
        **kw,
    )
    return json.loads(out)


# ─────────────────────────────────────────────────────────────────
# Backwards-compat — old call shape
# ─────────────────────────────────────────────────────────────────


def test_search_without_filters_returns_all_results(search_world) -> None:
    out = _run_search()
    assert out["total"] == 3
    # InteractionEvent hits expose their event_id
    eids = [r.get("event_id") for r in out["results"]]
    assert "EVT-USER-1" in eids and "EVT-RUN-1" in eids


# ─────────────────────────────────────────────────────────────────
# counterpart filter
# ─────────────────────────────────────────────────────────────────


def test_search_counterpart_paired_subworker_keeps_lt_notes(search_world) -> None:
    """The paired_subworker filter narrows event-tagged hits to
    sub-1 but keeps non-event memories (LTM notes) regardless."""
    out = _run_search(counterpart="paired_subworker")
    eids = {r.get("event_id") for r in out["results"]}
    # sub-1 event present, alice event absent
    assert "EVT-RUN-1" in eids
    assert "EVT-USER-1" not in eids
    # LTM note still present (no event_id)
    note_hits = [r for r in out["results"] if r.get("event_id") is None]
    assert len(note_hits) == 1
    assert note_hits[0]["category"] == "topics"


def test_search_counterpart_user_filters_correctly(search_world) -> None:
    out = _run_search(counterpart="user")
    eids = {r.get("event_id") for r in out["results"]}
    assert "EVT-USER-1" in eids
    assert "EVT-RUN-1" not in eids


def test_search_counterpart_unpaired_drops_event_hits(search_world) -> None:
    """Counterpart alias that resolves to None (unpaired session)
    means *no* event-tagged hit can satisfy the filter — but LTM
    notes still pass through."""
    search_world["vtuber"]._linked_session_id = ""
    out = _run_search(counterpart="paired_subworker")
    eids = {r.get("event_id") for r in out["results"] if r.get("event_id")}
    assert eids == set()
    # non-event note is still present
    assert any(r.get("event_id") is None for r in out["results"])


# ─────────────────────────────────────────────────────────────────
# kinds filter
# ─────────────────────────────────────────────────────────────────


def test_search_kind_filter_narrows_events(search_world) -> None:
    out = _run_search(kinds=["tool_run_summary"])
    event_results = [r for r in out["results"] if r.get("event_id")]
    assert len(event_results) == 1
    assert event_results[0]["event_id"] == "EVT-RUN-1"
    # LTM note still passes
    assert any(r.get("event_id") is None for r in out["results"])


def test_search_combined_filters(search_world) -> None:
    out = _run_search(
        counterpart="paired_subworker", kinds=["tool_run_summary"],
    )
    event_results = [r for r in out["results"] if r.get("event_id")]
    assert [r["event_id"] for r in event_results] == ["EVT-RUN-1"]


def test_search_filters_block_returns_filter_descriptor(search_world) -> None:
    """Result envelope echoes the filter args back so the LLM (and
    tests) can confirm what was applied."""
    out = _run_search(counterpart="user", kinds=["user_chat"])
    f = out["filters"]
    assert f["counterpart"] == "user"
    assert f["counterpart_resolved"] == "owner:alice"
    assert sorted(f["kinds"]) == ["user_chat"]


def test_search_unknown_session_returns_error(search_world, monkeypatch) -> None:
    monkeypatch.setattr(memory_tools, "_get_memory_manager", lambda sid: None)
    out = _run_search()
    assert "error" in out
