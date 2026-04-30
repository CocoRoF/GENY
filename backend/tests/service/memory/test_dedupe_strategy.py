"""Cycle 20260501_1 C — GenyDedupeStrategy.

Pins the contract that there's exactly *one* STM write site for
every user / assistant turn (s18) and that
state.metadata['_pending_message_metadata'] threads through to the
record_message call so InteractionEvent metadata survives.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from service.memory.dedupe_strategy import GenyDedupeStrategy


# ─────────────────────────────────────────────────────────────────
# Fakes
# ─────────────────────────────────────────────────────────────────


class _FakeMemoryManager:
    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    def record_message(self, role, content, metadata=None, **extra):
        self.calls.append({"role": role, "content": content, "metadata": metadata})


class _FakeState:
    """Stand-in for PipelineState exposing the surface
    `_record_transcript` consumes."""

    def __init__(
        self,
        messages: List[Dict[str, Any]],
        metadata: Dict[str, Any] | None = None,
    ) -> None:
        self.messages = list(messages)
        self.metadata: Dict[str, Any] = dict(metadata or {})


def _make_strategy(mgr: _FakeMemoryManager) -> GenyDedupeStrategy:
    # No reflection — irrelevant to this PR's contract
    return GenyDedupeStrategy(
        mgr,
        enable_reflection=False,
        llm_reflect=None,
        curated_knowledge_manager=None,
        resolver=None,
    )


# ─────────────────────────────────────────────────────────────────
# Single-write contract
# ─────────────────────────────────────────────────────────────────


def test_records_each_message_exactly_once_with_pending_metadata() -> None:
    """user message and assistant message should each be recorded
    once, with the matching pending metadata applied."""
    mgr = _FakeMemoryManager()
    strategy = _make_strategy(mgr)

    user_meta = {"event_id": "evt-u", "kind": "user_chat",
                 "direction": "in", "counterpart_id": "owner:alice",
                 "counterpart_role": "user"}
    assistant_meta = {"event_id": "evt-a", "kind": "user_chat",
                      "direction": "out", "counterpart_id": "owner:alice",
                      "counterpart_role": "user"}

    state = _FakeState(
        messages=[
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi back"},
        ],
        metadata={
            "_pending_message_metadata": {
                "user": user_meta,
                "assistant": assistant_meta,
            },
        },
    )

    strategy._record_transcript(state)

    assert [c["role"] for c in mgr.calls] == ["user", "assistant"]
    assert mgr.calls[0]["content"] == "hello"
    assert mgr.calls[1]["content"] == "hi back"
    assert mgr.calls[0]["metadata"] == user_meta
    assert mgr.calls[1]["metadata"] == assistant_meta
    assert state.metadata["_stm_recorded_count"] == 2


def test_records_without_metadata_when_pending_absent() -> None:
    """No pending hint → record_message is called with
    metadata=None. This is the fallback path for invoke_pipeline
    paths where the metadata couldn't be resolved (legacy /
    unrecognised prompt shape)."""
    mgr = _FakeMemoryManager()
    strategy = _make_strategy(mgr)

    state = _FakeState(
        messages=[
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "yo"},
        ],
        metadata={},
    )
    strategy._record_transcript(state)

    assert all(c["metadata"] is None for c in mgr.calls)
    assert len(mgr.calls) == 2


def test_pending_metadata_threads_through_repeated_role() -> None:
    """Cycle 20260501_2 F1 — when state.messages carries multiple
    same-role messages in a single batch (e.g. a VTuber turn that
    emits two assistant texts), every same-role line is recorded
    with InteractionEvent metadata. The first reuses the pending
    hint verbatim; subsequent ones get a *fresh* event_id with the
    same kind / direction / counterpart_* / linked_event_id /
    payload — so downstream filters see the line as a same-stream
    sibling event, not as a metadata-less ghost."""
    mgr = _FakeMemoryManager()
    strategy = _make_strategy(mgr)

    assistant_meta = {
        "event_id": "evt-a-1",
        "kind": "user_chat",
        "direction": "out",
        "counterpart_id": "owner:alice",
        "counterpart_role": "user",
        "linked_event_id": "evt-u-1",
        "payload": {"trigger": "user"},
    }
    state = _FakeState(
        messages=[
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "first reply"},
            {"role": "assistant", "content": "second reply"},
        ],
        metadata={"_pending_message_metadata": {"assistant": assistant_meta}},
    )
    strategy._record_transcript(state)

    assistant_records = [c for c in mgr.calls if c["role"] == "assistant"]
    assert len(assistant_records) == 2

    first = assistant_records[0]["metadata"]
    second = assistant_records[1]["metadata"]
    assert first == assistant_meta  # pending hint reused verbatim
    assert second is not None
    # Same canonical 5 dimensions threaded from the template
    assert second["kind"] == "user_chat"
    assert second["direction"] == "out"
    assert second["counterpart_id"] == "owner:alice"
    assert second["counterpart_role"] == "user"
    assert second.get("linked_event_id") == "evt-u-1"
    assert second.get("payload") == {"trigger": "user"}
    # But event_id is fresh
    assert second["event_id"] != assistant_meta["event_id"]


def test_repeated_role_with_no_hint_records_plainly() -> None:
    """If no pending hint exists for a role, repeated messages of
    that role still record (no metadata invented). This preserves
    the legacy fallback for cycles where the metadata resolver
    couldn't classify the input."""
    mgr = _FakeMemoryManager()
    strategy = _make_strategy(mgr)

    state = _FakeState(
        messages=[
            {"role": "user", "content": "a"},
            {"role": "user", "content": "b"},
        ],
        metadata={},
    )
    strategy._record_transcript(state)

    assert all(c["metadata"] is None for c in mgr.calls)
    assert len(mgr.calls) == 2


def test_skips_already_recorded_prefix() -> None:
    """Repeated invocation in the same turn (state.metadata's
    `_stm_recorded_count` advances) walks only new messages."""
    mgr = _FakeMemoryManager()
    strategy = _make_strategy(mgr)

    state = _FakeState(
        messages=[
            {"role": "user", "content": "old user"},
            {"role": "assistant", "content": "old assistant"},
            {"role": "user", "content": "new user"},
        ],
        metadata={"_stm_recorded_count": 2},
    )
    strategy._record_transcript(state)

    assert [c["content"] for c in mgr.calls] == ["new user"]
    assert state.metadata["_stm_recorded_count"] == 3


def test_skips_non_text_message_blocks() -> None:
    """Multimodal content (list of blocks) — text parts are
    concatenated; tool_result blocks are dropped (parent class
    behaviour preserved)."""
    mgr = _FakeMemoryManager()
    strategy = _make_strategy(mgr)

    state = _FakeState(
        messages=[
            {"role": "user", "content": [
                {"type": "text", "text": "hello "},
                {"type": "image", "source": {}},
                {"type": "text", "text": "world"},
            ]},
        ],
        metadata={},
    )
    strategy._record_transcript(state)

    assert mgr.calls[0]["content"] == "hello \nworld"


def test_drops_tool_role_messages() -> None:
    """Only user / assistant lines reach STM — tool_result and
    other roles are filtered."""
    mgr = _FakeMemoryManager()
    strategy = _make_strategy(mgr)

    state = _FakeState(
        messages=[
            {"role": "user", "content": "do thing"},
            {"role": "tool", "content": "result"},
            {"role": "assistant", "content": "done"},
        ],
        metadata={},
    )
    strategy._record_transcript(state)

    roles = [c["role"] for c in mgr.calls]
    assert roles == ["user", "assistant"]


def test_handles_missing_memory_manager_gracefully() -> None:
    """No memory manager → noop. Used at session boot when the
    manager hasn't been wired yet."""
    strategy = GenyDedupeStrategy(
        memory_manager=None,
        enable_reflection=False,
    )
    state = _FakeState(messages=[{"role": "user", "content": "x"}])
    # Must not raise
    strategy._record_transcript(state)


def test_record_failure_swallowed() -> None:
    """A buggy record_message implementation must not break the
    pipeline (s18 runs at terminal state — failure here would lose
    the rest of the turn's persistence)."""
    class _ExplodingMgr:
        def record_message(self, *a, **kw):
            raise RuntimeError("upstream stm error")

    strategy = GenyDedupeStrategy(_ExplodingMgr(), enable_reflection=False)
    state = _FakeState(messages=[{"role": "user", "content": "hi"}])
    # Must not raise
    strategy._record_transcript(state)
    assert state.metadata["_stm_recorded_count"] == 1
