"""Regression tests for outgoing-DM STM recording.

Cycle 20260421_1 Bug B: ``send_direct_message_internal`` and
``send_direct_message_external`` delivered the DM body to the
recipient's inbox and fired ``_trigger_dm_response`` on them, but
the sender's own short-term memory saw nothing — the DM content
survived only inside the tool event log, so next turn's retrieval
(L0 recent turns / session summary / keyword / vector) had no
record of what the sender just asked. Combined with Bug A (inbox
drain wrapper misclassification) this silently erased the entire
VTuber↔Sub-Worker exchange from memory.

These tests pin the new ``_record_dm_on_sender_stm`` helper and the
two tool call sites wired to it.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Dict, List, Tuple

import pytest

from tools.built_in import geny_tools
from tools.built_in.geny_tools import (
    SendDirectMessageExternalTool,
    SendDirectMessageInternalTool,
    _record_dm_on_sender_stm,
)


# ─────────────────────────────────────────────────────────────────
# Fake infrastructure
# ─────────────────────────────────────────────────────────────────


class _FakeMemoryManager:
    def __init__(self) -> None:
        self.messages: List[Tuple[str, str]] = []
        self.metadata_log: List[Any] = []

    def record_message(
        self, role: str, content: str, metadata=None, **extra
    ) -> None:
        meta: Dict[str, Any] = dict(extra) if extra else {}
        if metadata:
            meta.update(metadata)
        self.messages.append((role, content))
        self.metadata_log.append(meta or None)


class _ExplodingMemoryManager:
    def record_message(
        self, role: str, content: str, metadata=None, **extra
    ) -> None:
        raise RuntimeError("stm down")


class _FakeAgent:
    def __init__(
        self,
        session_id: str,
        *,
        session_name: str = "Agent",
        linked_session_id: str = "",
        session_type: str = "",
        memory: Any = None,
    ) -> None:
        self.session_id = session_id
        self.session_name = session_name
        self._linked_session_id = linked_session_id
        self._session_type = session_type
        self._memory_manager = memory


class _FakeAgentManager:
    def __init__(self, agents: Dict[str, _FakeAgent]) -> None:
        self._agents = agents

    def get_agent(self, session_id: str) -> Any:
        return self._agents.get(session_id)

    def resolve_session(self, name_or_id: str) -> Any:
        a = self._agents.get(name_or_id)
        if a is not None:
            return a
        for agent in self._agents.values():
            if agent.session_name == name_or_id:
                return agent
        return None


class _FakeInbox:
    def __init__(self) -> None:
        self.delivered: List[Dict[str, Any]] = []
        self.fail = False

    def deliver(
        self,
        target_session_id: str,
        content: str,
        sender_session_id: str,
        sender_name: str,
    ) -> Dict[str, Any]:
        if self.fail:
            raise RuntimeError("inbox down")
        entry = {
            "id": f"msg-{len(self.delivered)}",
            "target_session_id": target_session_id,
            "content": content,
            "sender_session_id": sender_session_id,
            "sender_name": sender_name,
            "timestamp": "2026-04-21T10:20:00Z",
        }
        self.delivered.append(entry)
        return entry


@pytest.fixture
def patched_world(monkeypatch):
    """Install fakes for the agent manager, inbox, and trigger so DM
    tools can run in isolation. Returns refs for assertions."""
    vtuber_mem = _FakeMemoryManager()
    sub_mem = _FakeMemoryManager()
    vtuber = _FakeAgent(
        "vtuber-1",
        session_name="testsa",
        linked_session_id="sub-1",
        session_type="vtuber",
        memory=vtuber_mem,
    )
    sub = _FakeAgent(
        "sub-1",
        session_name="Sub-Worker",
        linked_session_id="vtuber-1",
        session_type="sub",
        memory=sub_mem,
    )
    colleague = _FakeAgent(
        "coll-1",
        session_name="Colleague",
        memory=_FakeMemoryManager(),
    )
    manager = _FakeAgentManager({
        "vtuber-1": vtuber,
        "sub-1": sub,
        "coll-1": colleague,
    })
    inbox = _FakeInbox()
    trigger_calls: List[Dict[str, Any]] = []

    monkeypatch.setattr(geny_tools, "_get_agent_manager", lambda: manager)
    monkeypatch.setattr(geny_tools, "_get_inbox_manager", lambda: inbox)

    def _fake_trigger(**kwargs):
        trigger_calls.append(kwargs)

    monkeypatch.setattr(geny_tools, "_trigger_dm_response", _fake_trigger)

    # _resolve_session uses the manager directly; nothing to patch.

    return {
        "vtuber": vtuber,
        "sub": sub,
        "colleague": colleague,
        "vtuber_mem": vtuber_mem,
        "sub_mem": sub_mem,
        "inbox": inbox,
        "trigger_calls": trigger_calls,
    }


# ─────────────────────────────────────────────────────────────────
# _record_dm_on_sender_stm — pure helper
# ─────────────────────────────────────────────────────────────────


def test_record_helper_writes_assistant_dm(patched_world) -> None:
    _record_dm_on_sender_stm(
        session_id="vtuber-1",
        content="find something fun",
        target_label="Sub-Worker",
        channel="internal",
    )
    assert patched_world["vtuber_mem"].messages == [
        ("assistant_dm", "[DM to Sub-Worker (internal)]: find something fun"),
    ]


def test_record_helper_noop_when_session_missing(patched_world) -> None:
    _record_dm_on_sender_stm(
        session_id="unknown",
        content="x",
        target_label="Sub-Worker",
        channel="internal",
    )
    # No agent with that id → no record on any known agent
    assert patched_world["vtuber_mem"].messages == []
    assert patched_world["sub_mem"].messages == []


def test_record_helper_noop_when_no_memory_manager(
    patched_world, monkeypatch
) -> None:
    """Early-session or stubbed agents may not have a memory manager
    yet — the helper must quietly skip, never crash."""
    patched_world["vtuber"]._memory_manager = None
    _record_dm_on_sender_stm(
        session_id="vtuber-1",
        content="x",
        target_label="Sub-Worker",
        channel="internal",
    )
    # No crash; nothing written anywhere else
    assert patched_world["sub_mem"].messages == []


def test_record_helper_swallows_exception(patched_world) -> None:
    patched_world["vtuber"]._memory_manager = _ExplodingMemoryManager()
    # Must not raise
    _record_dm_on_sender_stm(
        session_id="vtuber-1",
        content="boom",
        target_label="Sub-Worker",
        channel="internal",
    )


def test_record_helper_caps_body_length(patched_world) -> None:
    huge = "x" * 20_000
    _record_dm_on_sender_stm(
        session_id="vtuber-1",
        content=huge,
        target_label="Sub-Worker",
        channel="internal",
    )
    recorded = patched_world["vtuber_mem"].messages[0][1]
    assert len(recorded) <= 10_000


# ─────────────────────────────────────────────────────────────────
# SendDirectMessageInternalTool.run
# ─────────────────────────────────────────────────────────────────


def test_internal_tool_records_outgoing_dm(patched_world) -> None:
    tool = SendDirectMessageInternalTool()
    out = tool.run(session_id="vtuber-1", content="find something fun")

    # Inbox write happened + recipient trigger fired
    assert len(patched_world["inbox"].delivered) == 1
    assert len(patched_world["trigger_calls"]) == 1

    # Sender STM now carries the outgoing DM as assistant_dm
    msgs = patched_world["vtuber_mem"].messages
    assert msgs == [
        ("assistant_dm", "[DM to Sub-Worker (internal)]: find something fun"),
    ]

    # Recipient STM untouched by this tool (recipient records its own
    # side via _trigger_dm_response → classifier on the other end)
    assert patched_world["sub_mem"].messages == []

    # Return JSON is unchanged
    assert '"success": true' in out


def test_internal_tool_no_record_when_no_counterpart(patched_world) -> None:
    """If the caller has no linked counterpart the tool short-circuits
    with an error and must not write anything to STM."""
    patched_world["vtuber"]._linked_session_id = ""
    tool = SendDirectMessageInternalTool()
    out = tool.run(session_id="vtuber-1", content="hi")

    assert '"error"' in out
    assert patched_world["vtuber_mem"].messages == []
    assert patched_world["inbox"].delivered == []


def test_internal_tool_empty_content_rejected(patched_world) -> None:
    tool = SendDirectMessageInternalTool()
    out = tool.run(session_id="vtuber-1", content="   ")
    assert '"error"' in out
    assert patched_world["vtuber_mem"].messages == []


# ─────────────────────────────────────────────────────────────────
# SendDirectMessageExternalTool.run
# ─────────────────────────────────────────────────────────────────


def test_external_tool_records_outgoing_dm(patched_world) -> None:
    tool = SendDirectMessageExternalTool()
    out = tool.run(
        target_session_id="coll-1",
        content="quick question",
        sender_session_id="vtuber-1",
        sender_name="testsa",
    )

    assert len(patched_world["inbox"].delivered) == 1
    msgs = patched_world["vtuber_mem"].messages
    assert msgs == [
        ("assistant_dm", "[DM to Colleague (external)]: quick question"),
    ]
    assert '"success": true' in out


def test_external_tool_no_sender_id_skips_record(patched_world) -> None:
    """Tool kept working for ad-hoc calls without a sender id; in that
    case there's no session to write to, and the helper must not try
    a blind lookup."""
    tool = SendDirectMessageExternalTool()
    tool.run(
        target_session_id="coll-1",
        content="hi",
        sender_session_id="",
        sender_name="",
    )
    # No STM mutation on any known agent
    assert patched_world["vtuber_mem"].messages == []
    assert patched_world["sub_mem"].messages == []
    assert patched_world["colleague"]._memory_manager.messages == []


def test_external_tool_unknown_target_no_record(patched_world) -> None:
    tool = SendDirectMessageExternalTool()
    out = tool.run(
        target_session_id="ghost",
        content="hi",
        sender_session_id="vtuber-1",
        sender_name="testsa",
    )
    assert '"error"' in out
    assert patched_world["vtuber_mem"].messages == []
    assert patched_world["inbox"].delivered == []


# ─────────────────────────────────────────────────────────────────
# Cycle 20260430_2 A2 — InteractionEvent metadata on outgoing DM
# ─────────────────────────────────────────────────────────────────


def _meta_at(mem: _FakeMemoryManager, idx: int) -> Dict[str, Any]:
    """Convenience accessor — metadata recorded for the *idx*-th
    record_message call."""
    assert idx < len(mem.metadata_log), (
        f"no record at idx {idx} (recorded={len(mem.metadata_log)})"
    )
    meta = mem.metadata_log[idx]
    assert isinstance(meta, dict), (
        "Cycle 20260430_2 invariant — outgoing DM metadata must always be "
        f"populated, got {meta!r}"
    )
    return meta


def test_internal_tool_metadata_paired_vtuber_to_sub_is_task_request(
    patched_world,
) -> None:
    """VTuber → bound Sub-Worker counterpart-DM with a plain task body
    must record ``kind=task_request`` + ``counterpart_role=paired_subworker``
    so retrieval / progressive memory tools can slice the stream."""
    tool = SendDirectMessageInternalTool()
    tool.run(session_id="vtuber-1", content="please write notes.md")

    meta = _meta_at(patched_world["vtuber_mem"], 0)
    assert meta["kind"] == "task_request"
    assert meta["direction"] == "out"
    assert meta["counterpart_id"] == "sub-1"
    assert meta["counterpart_role"] == "paired_subworker"
    assert isinstance(meta["event_id"], str) and meta["event_id"]


def test_internal_tool_metadata_paired_sub_to_vtuber_subworker_result_is_task_result(
    patched_world,
) -> None:
    """Sub-Worker → bound VTuber with ``[SUB_WORKER_RESULT]`` body
    flips to ``kind=task_result`` + ``counterpart_role=paired_vtuber``."""
    tool = SendDirectMessageInternalTool()
    tool.run(
        session_id="sub-1",
        content="[SUB_WORKER_RESULT]\nstatus: ok\nsummary: wrote notes.md",
    )

    meta = _meta_at(patched_world["sub_mem"], 0)
    assert meta["kind"] == "task_result"
    assert meta["direction"] == "out"
    assert meta["counterpart_id"] == "vtuber-1"
    assert meta["counterpart_role"] == "paired_vtuber"


def test_internal_tool_metadata_paired_sub_to_vtuber_plain_is_dm(
    patched_world,
) -> None:
    """Sub-Worker → bound VTuber with a plain (non-SUB_WORKER_RESULT)
    body stays as ``kind=dm`` but keeps ``counterpart_role=paired_vtuber``
    so the relationship dimension is preserved."""
    tool = SendDirectMessageInternalTool()
    tool.run(session_id="sub-1", content="hello — quick question")

    meta = _meta_at(patched_world["sub_mem"], 0)
    assert meta["kind"] == "dm"
    assert meta["counterpart_role"] == "paired_vtuber"


def test_external_tool_metadata_unrelated_target_is_peer_dm(
    patched_world,
) -> None:
    """Addressed DM to an unrelated session collapses to
    ``kind=dm`` + ``counterpart_role=peer`` regardless of session type."""
    tool = SendDirectMessageExternalTool()
    tool.run(
        target_session_id="coll-1",
        content="quick question",
        sender_session_id="vtuber-1",
        sender_name="testsa",
    )

    meta = _meta_at(patched_world["vtuber_mem"], 0)
    assert meta["kind"] == "dm"
    assert meta["direction"] == "out"
    assert meta["counterpart_id"] == "coll-1"
    assert meta["counterpart_role"] == "peer"


def test_record_helper_legacy_signature_keeps_working(patched_world) -> None:
    """Backwards-compat — callers that don't pass ``target_session_id``
    still record the body as before, just without InteractionEvent
    metadata. This protects unit tests / scripts that called the
    helper with the pre-cycle signature."""
    from tools.built_in.geny_tools import _record_dm_on_sender_stm

    _record_dm_on_sender_stm(
        session_id="vtuber-1",
        content="legacy",
        target_label="Sub-Worker",
        channel="internal",
        # NOTE: no target_session_id
    )
    assert patched_world["vtuber_mem"].messages == [
        ("assistant_dm", "[DM to Sub-Worker (internal)]: legacy"),
    ]
    # Metadata must be None (legacy fallback path) — this is the only
    # branch where invariant 2 (metadata always populated) is relaxed,
    # and only for legacy-shape callers. Production call sites all
    # pass target_session_id.
    assert patched_world["vtuber_mem"].metadata_log == [None]
