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
    MemoryArtifactTool,
    MemoryDistillTool,
    MemoryEventTool,
    MemoryStatusTool,
    MemoryWithTool,
    _resolve_counterpart_id,
    _sanitize_counterpart_for_filename,
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


# ─────────────────────────────────────────────────────────────────
# memory_artifact — L3
# ─────────────────────────────────────────────────────────────────


def _run_artifact(tool: MemoryArtifactTool, **kw) -> Dict[str, Any]:
    out = tool.run(session_id=kw.pop("session_id", "vtuber-1"), **kw)
    return json.loads(out)


@pytest.fixture
def artifact_world(world, tmp_path):
    """Wire the seeded `EVT-RUN-1` event to a real working_dir on
    disk so the tool can read the artifact body."""
    workspace = tmp_path / "sub-1-ws"
    workspace.mkdir()
    (workspace / "notes.md").write_text("hello world\n", encoding="utf-8")

    # Point the sub-worker fake at the real workspace.
    world["sub"]._working_dir = str(workspace)
    return {**world, "workspace": workspace}


def test_artifact_reads_listed_file(artifact_world) -> None:
    out = _run_artifact(
        MemoryArtifactTool(),
        event_id="EVT-RUN-1",
        path="notes.md",
    )
    assert out["path"] == "notes.md"
    assert out["content"] == "hello world\n"
    assert out["truncated"] is False
    assert out["size_bytes"] == len("hello world\n")


def test_artifact_rejects_path_not_in_files_written(artifact_world) -> None:
    """Hard guardrail — the path must appear in the event's
    payload.files_written. Otherwise this becomes a generic file
    reader, defeating the principle that this tool only exposes
    artifacts the persona can already discover via memory_event."""
    (artifact_world["workspace"] / "secret.txt").write_text("nope", encoding="utf-8")
    out = _run_artifact(
        MemoryArtifactTool(),
        event_id="EVT-RUN-1",
        path="secret.txt",
    )
    assert "error" in out


def test_artifact_rejects_absolute_path(artifact_world) -> None:
    out = _run_artifact(
        MemoryArtifactTool(),
        event_id="EVT-RUN-1",
        path="/etc/passwd",
    )
    assert "error" in out


def test_artifact_rejects_traversal(artifact_world) -> None:
    """A `..` segment is rejected even when the candidate would have
    resolved into the workspace. The check is conservative on
    purpose."""
    out = _run_artifact(
        MemoryArtifactTool(),
        event_id="EVT-RUN-1",
        path="../sub-1-ws/notes.md",
    )
    assert "error" in out


def test_artifact_rejects_path_resolving_outside_workspace(
    artifact_world, tmp_path
) -> None:
    """Even when files_written contains a "tricky" path that escapes
    the workspace via symlink-free resolution, the relative_to()
    check must still reject it."""
    # Manually inject a malicious files_written entry so we can
    # exercise the workspace-bound check (the categoriser would never
    # produce such a path; this is defence in depth).
    sub_entries = artifact_world["vtuber"]._memory_manager._stm._entries
    sub_entries[2]["metadata"]["payload"]["files_written"] = ["../../etc/passwd"]
    out = _run_artifact(
        MemoryArtifactTool(),
        event_id="EVT-RUN-1",
        path="../../etc/passwd",
    )
    assert "error" in out


def test_artifact_truncates_when_file_exceeds_cap(artifact_world) -> None:
    big = "x" * 4096
    (artifact_world["workspace"] / "big.md").write_text(big, encoding="utf-8")
    sub_entries = artifact_world["vtuber"]._memory_manager._stm._entries
    sub_entries[2]["metadata"]["payload"]["files_written"] = [
        "notes.md", "big.md",
    ]
    out = _run_artifact(
        MemoryArtifactTool(),
        event_id="EVT-RUN-1",
        path="big.md",
        max_bytes=128,
    )
    assert out["truncated"] is True
    assert len(out["content"]) <= 128
    assert out["size_bytes"] == 4096


def test_artifact_unknown_event_returns_error(artifact_world) -> None:
    out = _run_artifact(
        MemoryArtifactTool(), event_id="EVT-NOPE", path="x",
    )
    assert "error" in out


def test_artifact_missing_file_returns_error(artifact_world) -> None:
    sub_entries = artifact_world["vtuber"]._memory_manager._stm._entries
    sub_entries[2]["metadata"]["payload"]["files_written"] = ["gone.md"]
    out = _run_artifact(
        MemoryArtifactTool(), event_id="EVT-RUN-1", path="gone.md",
    )
    assert "error" in out


def test_artifact_max_bytes_clamped_to_hard_cap(artifact_world) -> None:
    """User-supplied max_bytes above the hard cap silently clamps —
    no error, just clipped output."""
    big = "y" * 1_000_000
    (artifact_world["workspace"] / "huge.md").write_text(big, encoding="utf-8")
    sub_entries = artifact_world["vtuber"]._memory_manager._stm._entries
    sub_entries[2]["metadata"]["payload"]["files_written"] = ["huge.md"]
    out = _run_artifact(
        MemoryArtifactTool(),
        event_id="EVT-RUN-1",
        path="huge.md",
        max_bytes=10_000_000,  # way above cap
    )
    # Content capped to at most _MAX_ARTIFACT_BYTES (256 KB)
    assert len(out["content"]) <= 262_144
    assert out["truncated"] is True


# ─────────────────────────────────────────────────────────────────
# memory_distill — long-term recall
# ─────────────────────────────────────────────────────────────────


def _run_distill(tool: MemoryDistillTool, **kw) -> Dict[str, Any]:
    out = tool.run(session_id=kw.pop("session_id", "vtuber-1"), **kw)
    return json.loads(out)


def test_sanitize_counterpart_for_filename() -> None:
    assert _sanitize_counterpart_for_filename("owner:alice") == "owner_alice"
    assert _sanitize_counterpart_for_filename("sub-1") == "sub-1"
    assert _sanitize_counterpart_for_filename("self") == "self"
    assert _sanitize_counterpart_for_filename("") == "unknown"
    # Long ids are capped at 80 chars
    long_id = "x" * 200
    assert len(_sanitize_counterpart_for_filename(long_id)) == 80


def test_distill_paired_subworker_returns_stats(world) -> None:
    out = _run_distill(MemoryDistillTool(), counterpart="paired_subworker")
    assert out["counterpart_id"] == "sub-1"
    assert out["events_seen"] == 2  # task_request + tool_run_summary
    assert out["kind_counts"] == {"task_request": 1, "tool_run_summary": 1}
    assert out["files_written"] == ["notes.md"]
    assert out["counterpart_role"] == "paired_subworker"
    # First recent event is the most recent (tool_run_summary)
    assert out["recent"][0]["event_id"] == "EVT-RUN-1"
    # update_note was not requested
    assert out["note_written"] is None


def test_distill_user_returns_user_chat_stats(world) -> None:
    out = _run_distill(MemoryDistillTool(), counterpart="user")
    assert out["counterpart_id"] == "owner:alice"
    assert out["events_seen"] == 1
    assert out["kind_counts"] == {"user_chat": 1}


def test_distill_unpaired_alias_returns_empty(world) -> None:
    world["vtuber"]._linked_session_id = ""
    out = _run_distill(MemoryDistillTool(), counterpart="paired_subworker")
    assert out["counterpart_id"] is None
    assert out["events_seen"] == 0


def test_distill_max_events_clamps(world) -> None:
    """Out-of-range max_events clamps to [1, _MAX_DISTILL_EVENTS]."""
    out = _run_distill(
        MemoryDistillTool(),
        counterpart="paired_subworker",
        max_events=999_999,
    )
    # Only 2 sub-1 events seeded; clamp doesn't fabricate more.
    assert out["events_seen"] == 2
    out2 = _run_distill(
        MemoryDistillTool(),
        counterpart="paired_subworker",
        max_events=0,
    )
    # 0 → 1 (min clamp); only the most recent event seen.
    assert out2["events_seen"] == 1


def test_distill_update_note_writes_when_writer_available(world) -> None:
    """When the memory manager has a structured writer, update_note=true
    persists the distilled summary as insights/counterpart-<sanitized>.md.

    Memory v2 retired the entities/ category; counterpart distillations
    now land under insights/ with a ``counterpart-`` filename prefix.
    """
    captured = []

    # Sprint 3 step 5 — ``StructuredMemoryWriter`` retired from the
    # session manager; the inspect tool now calls ``mem.write_note(...)``
    # directly. Stub the public method instead of the legacy field.
    def _fake_write_note(**kwargs):
        captured.append(kwargs)
        return f"insights/{kwargs.get('filename_override','x').split('/')[-1]}"

    world["vtuber"]._memory_manager.write_note = _fake_write_note

    out = _run_distill(
        MemoryDistillTool(),
        counterpart="paired_subworker",
        update_note=True,
    )
    assert out["note_written"] is not None
    assert len(captured) == 1
    args = captured[0]
    assert args["category"] == "insights"
    assert args["source"] == "distillation"
    # filename uses sanitized counterpart id with the counterpart- prefix
    assert args["filename_override"] == "insights/counterpart-sub-1.md"
    # body mentions stats
    assert "Events observed" in args["content"]
    assert "notes.md" in args["content"]


def test_distill_update_note_silent_when_no_writer(world) -> None:
    """When the memory manager has no public write_note (minimal
    test setup, early init), update_note=true returns
    note_written=None instead of crashing."""
    # Sprint 3 step 5 — fake manager doesn't expose write_note here;
    # the inspect tool's getattr fallback returns None and the call
    # is skipped silently.
    out = _run_distill(
        MemoryDistillTool(),
        counterpart="paired_subworker",
        update_note=True,
    )
    assert out["note_written"] is None
    # Stats still returned
    assert out["events_seen"] == 2


def test_distill_unknown_session_returns_error(world) -> None:
    out = _run_distill(
        MemoryDistillTool(),
        session_id="ghost",
        counterpart="user",
    )
    assert "error" in out


# ─────────────────────────────────────────────────────────────────
# Cycle 20260430_3 F — narrative LLM option
# ─────────────────────────────────────────────────────────────────


def test_distill_narrative_default_off_matches_baseline(world) -> None:
    """Backwards-compat — without `narrative=true` the response shape
    extends with `narrative: null` but every existing field is the
    same value as cycle 20260430_2 produced."""
    out = _run_distill(MemoryDistillTool(), counterpart="paired_subworker")
    assert out["narrative"] is None
    assert out["narrative_error"] is None
    # Existing fields preserved
    assert out["events_seen"] == 2
    assert out["kind_counts"] == {"task_request": 1, "tool_run_summary": 1}


def test_distill_narrative_calls_llm_when_requested(monkeypatch, world) -> None:
    """narrative=true triggers `_run_distill_llm`; result threads into
    response and (when update_note=true) into the entity note body.

    Cycle 20260501_1 B — the helper now receives the caller_agent
    handle so we assert on it (rather than reach inside the helper)."""
    captured: list = []

    def _fake_run(*, caller_agent, **kwargs):
        captured.append({"caller_agent": caller_agent, **kwargs})
        return "이 워커와는 짧은 협업이지만 파일 작성에서 안정적인 모습을 보였다."

    monkeypatch.setattr(
        "tools.built_in.memory_inspect_tools._run_distill_llm",
        _fake_run,
    )

    # Sprint 3 step 5 — patch the public ``write_note`` instead of
    # the retired ``_structured_writer`` field.
    captured_calls: list = []

    def _capturing_write_note(**kw):
        captured_calls.append(kw)
        return f"insights/{kw['filename_override'].split('/')[-1]}"

    world["vtuber"]._memory_manager.write_note = _capturing_write_note

    out = _run_distill(
        MemoryDistillTool(),
        counterpart="paired_subworker",
        update_note=True,
        narrative=True,
    )
    assert out["narrative"] is not None
    assert "안정적인 모습" in out["narrative"]
    assert out["narrative_error"] is None
    # LLM was called once with the resolved counterpart_id AND the
    # caller agent handle (cycle 20260501_1 B — single client thread).
    assert len(captured) == 1
    assert captured[0]["counterpart_id"] == "sub-1"
    assert captured[0]["caller_agent"] is world["vtuber"]
    # Entity note body has narrative ABOVE stats
    body = captured_calls[0]["content"]
    narrative_idx = body.find("안정적인 모습")
    stats_idx = body.find("Stats")
    assert narrative_idx >= 0 and stats_idx >= 0 and narrative_idx < stats_idx


def test_distill_narrative_skipped_when_no_events(world) -> None:
    """Empty stream → don't call the LLM (no signal to summarise)."""
    world["vtuber"]._linked_session_id = ""  # paired alias resolves None
    out = _run_distill(
        MemoryDistillTool(),
        counterpart="paired_subworker",
        narrative=True,
    )
    # counterpart unresolved → events_seen=0 path; narrative untouched
    assert out["narrative"] is None


def test_distill_narrative_swallows_llm_failure(monkeypatch, world) -> None:
    """LLM call failures must not break the tool — we surface
    `narrative_error` and still return the stats-only payload."""
    def _boom(*, caller_agent, **kwargs):
        raise RuntimeError("upstream timeout")

    monkeypatch.setattr(
        "tools.built_in.memory_inspect_tools._run_distill_llm",
        _boom,
    )

    out = _run_distill(
        MemoryDistillTool(),
        counterpart="paired_subworker",
        narrative=True,
    )
    assert out["narrative"] is None
    assert out["narrative_error"] is not None
    assert "timeout" in out["narrative_error"]
    # Stats unaffected
    assert out["events_seen"] == 2


def test_distill_llm_uses_caller_shared_client(monkeypatch) -> None:
    """Cycle 20260501_1 B2 — `_run_distill_llm` MUST consume the
    caller AgentSession's `llm_client` + `memory_model_cfg` rather
    than building its own ClientRegistry instance. Pin both:
      - returns None when caller has no client / cfg (silent fallback)
      - calls `client.create_message` once when both are present
      - threads `caller_agent.memory_model_cfg.model` through to the
        request so APIConfig.memory_model edits propagate."""
    from types import SimpleNamespace
    from tools.built_in.memory_inspect_tools import _run_distill_llm

    # Empty case — caller without llm_client / cfg returns None.
    bare_caller = SimpleNamespace()
    assert _run_distill_llm(
        caller_agent=bare_caller,
        counterpart_id="sub-1",
        counterpart_role="paired_subworker",
        stats={"events_seen": 1, "kind_counts": {}, "files_written": [],
               "bash_commands_total": 0, "web_fetches_total": 0,
               "errors_total": 0, "duration_ms_total": 0,
               "cost_usd_total": None, "recent": []},
    ) is None

    # Happy case — caller carries both handles. The shared client is
    # invoked exactly once with the caller's cfg.
    captured = {}

    class _FakeResponse:
        text = "이 워커와의 협업은 안정적이었다."

    class _FakeClient:
        async def create_message(self, **kwargs):
            captured["kwargs"] = kwargs
            return _FakeResponse()

    fake_cfg = SimpleNamespace(
        model="claude-haiku-4-5-20251001",
        max_tokens=2048, temperature=0.0, thinking_enabled=False,
    )
    caller = SimpleNamespace(llm_client=_FakeClient(), memory_model_cfg=fake_cfg)

    out = _run_distill_llm(
        caller_agent=caller,
        counterpart_id="sub-1",
        counterpart_role="paired_subworker",
        stats={"events_seen": 1, "kind_counts": {"task_request": 1},
               "files_written": ["a.md"], "bash_commands_total": 0,
               "web_fetches_total": 0, "errors_total": 0,
               "duration_ms_total": 100, "cost_usd_total": None,
               "recent": [{"ts": "...", "kind": "task_request",
                           "summary": "wrote a.md"}]},
    )
    assert out == "이 워커와의 협업은 안정적이었다."
    assert "kwargs" in captured
    # Model name from the caller's memory_cfg threads through
    assert captured["kwargs"]["model_config"].model == "claude-haiku-4-5-20251001"
    # Narrative-specific knobs (cycle 20260501_1 B's `_shadow_cfg`)
    assert captured["kwargs"]["model_config"].max_tokens == 512
    assert captured["kwargs"]["model_config"].temperature == 0.2


def test_distill_user_prompt_includes_recent_events(world) -> None:
    """The prompt builder feeds the LLM the actual stats payload —
    not a free-form summary. Pin the prompt structure so prompt
    drift is caught here, not in production behaviour."""
    from tools.built_in.memory_inspect_tools import _build_distill_user_prompt

    stats = {
        "events_seen": 3,
        "kind_counts": {"task_request": 2, "tool_run_summary": 1},
        "files_written": ["a.md", "b.md"],
        "bash_commands_total": 0,
        "web_fetches_total": 1,
        "errors_total": 0,
        "duration_ms_total": 1234,
        "recent": [
            {"ts": "2026-04-30T12:00:00", "kind": "tool_run_summary",
             "summary": "wrote a.md"},
        ],
    }
    prompt = _build_distill_user_prompt(
        counterpart_id="sub-1", counterpart_role="paired_subworker",
        stats=stats,
    )
    assert "sub-1" in prompt
    assert "paired_subworker" in prompt
    assert "tool_run_summary=1" in prompt
    assert "wrote a.md" in prompt
