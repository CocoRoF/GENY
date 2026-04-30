"""Regression tests for STM role-classified message recording.

History:

* Cycle 20260420_8 / plan/03 Bug 2b-α — added ``record_message``
  calls inside ``_invoke_pipeline`` / ``_astream_pipeline`` so the
  assistant reply landed in STM and ``_classify_input_role``
  routed triggers / DMs to non-``user`` roles.
* Cycle 20260501_1 C — moved the *actual record_message call*
  out of ``_invoke_pipeline`` and onto ``s18_memory`` via
  :class:`GenyDedupeStrategy`. ``_invoke_pipeline`` now resolves
  the InteractionEvent metadata for the upcoming user / assistant
  turn and stamps it on
  ``state.metadata['_pending_message_metadata']``; s18 reads the
  hint and records each message exactly once with full metadata.

These tests pin the post-cycle-20260501_1_C contract:

* ``_classify_input_role`` keeps the same role mapping (drives
  retrieval downstream).
* ``_invoke_pipeline`` / ``_astream_pipeline`` no longer call
  ``record_message`` directly — pinned by the absence of writes
  on the fake memory manager.
* The pending metadata dict is stamped on state.metadata with
  the right shape per case.

The actual STM record path is exercised in
``tests/service/memory/test_dedupe_strategy.py`` (s18 side).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Dict, List, Tuple
from unittest.mock import MagicMock

import pytest

from service.executor.agent_session import (
    AgentSession,
    _classify_input_role,
)


# ─────────────────────────────────────────────────────────────────
# _classify_input_role — pure function
# ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        # Plain user input
        ("hello world", "user"),
        ("  hi there", "user"),
        # Internal triggers — emitted by service/vtuber/thinking_trigger.py
        ("[THINKING_TRIGGER] user has been quiet", "internal_trigger"),
        ("[THINKING_TRIGGER:first_idle] check in", "internal_trigger"),
        ("[THINKING_TRIGGER:continued_idle]", "internal_trigger"),
        ("[ACTIVITY_TRIGGER] curiosity time", "internal_trigger"),
        ("[ACTIVITY_TRIGGER:user_return] hi", "internal_trigger"),
        # Sub-worker auto-reports — emitted by service/execution/agent_executor.py
        ("[SUB_WORKER_RESULT] Task done: file.txt created", "assistant_dm"),
        ("[SUB_WORKER_RESULT] Task failed: boom", "assistant_dm"),
        # Legacy alias still accepted by DelegationMessage.is_result_message
        ("[CLI_RESULT] legacy payload", "assistant_dm"),
        # Delegation protocol tags — service/vtuber/delegation.py
        ("[DELEGATION_REQUEST] please handle this task", "assistant_dm"),
        ("[DELEGATION_RESULT] task completed", "assistant_dm"),
        # DM prompt wrapper — tools/built_in/geny_tools.py _trigger_dm_response
        (
            "[SYSTEM] You received a direct message from alice (session: s-1). "
            "Read the message below...",
            "assistant_dm",
        ),
        # Forward-compat placeholders from plan/03 § 4-2
        ("[SUB_WORKER_PROGRESS] 50% done", "assistant_dm"),
        ("[FROM_COUNTERPART:sub-1] hey worker", "assistant_dm"),
        # Inbox drain wrappers — emitted by _drain_inbox in
        # service/execution/agent_executor.py when a queued DM is
        # picked up after the busy window closes. Covers the common
        # regression path where a [SUB_WORKER_RESULT] arrives while
        # the VTuber is still running its own turn and ends up being
        # replayed via drain (cycle 20260421_1).
        (
            "[INBOX from Sub-Worker]\n"
            "[SUB_WORKER_RESULT] Task completed successfully.\n\nfound a fact",
            "assistant_dm",
        ),
        ("[INBOX from Sub-Worker]\nplain body with no inner tag", "assistant_dm"),
        ("[INBOX from alice]\nhi there", "assistant_dm"),
        # Leading whitespace must not defeat the match
        ("   [SUB_WORKER_RESULT] leading ws stripped", "assistant_dm"),
        ("   [INBOX from Bob]\nhello", "assistant_dm"),
        # Ambiguous / embedded — must stay "user"
        ("fake [THINKING_TRIGGER] inside prose", "user"),
        ("[OTHER_TAG] not ours", "user"),
        ("fake [INBOX from foo] mid-sentence", "user"),
        # Unrelated [SYSTEM] prompts must not be swept up
        ("[SYSTEM] Something else entirely", "user"),
    ],
)
def test_classify_input_role(text: str, expected: str) -> None:
    assert _classify_input_role(text) == expected


# ─────────────────────────────────────────────────────────────────
# _invoke_pipeline / _astream_pipeline — record_message wiring
# ─────────────────────────────────────────────────────────────────


class _FakeMemoryManager:
    def __init__(self) -> None:
        self.messages: List[Tuple[str, str]] = []
        self.executions: List[Dict[str, Any]] = []

    def record_message(self, role: str, content: str, metadata=None, **extra) -> None:
        self.messages.append((role, content))

    async def record_execution(self, **kwargs: Any) -> None:
        self.executions.append(kwargs)


class _FakeEvent:
    def __init__(self, event_type: str, data: Dict[str, Any]) -> None:
        self.type = event_type
        self.data = data


class _FakePipeline:
    """Yields a scripted sequence of PipelineEvents from run_stream.

    Cycle 20260501_1 C — captures the PipelineState received by
    run_stream so tests can assert on `state.metadata` after the
    invoke completes (this is where pending_message_metadata
    lands; the real s18 stage would read it on terminal state)."""

    def __init__(self, events: List[_FakeEvent]) -> None:
        self._events = events
        self.last_state: Any = None

    async def run_stream(self, input_text: str, state: Any):
        self.last_state = state
        for evt in self._events:
            yield evt


def _make_session(events: List[_FakeEvent]) -> Tuple[AgentSession, _FakeMemoryManager]:
    """Construct an AgentSession with just enough wiring to exercise
    the pipeline-invocation helpers. Heavy construction is skipped —
    we only need the memory manager + a scripted pipeline."""
    session = AgentSession(session_id="s-test", session_name="T")
    mem = _FakeMemoryManager()
    session._memory_manager = mem  # type: ignore[assignment]
    session._pipeline = _FakePipeline(events)  # type: ignore[assignment]
    session._execution_count = 0
    return session, mem


def _success_events(output: str = "hello back") -> List[_FakeEvent]:
    return [
        _FakeEvent("text.delta", {"text": output}),
        _FakeEvent(
            "pipeline.complete",
            {"result": output, "total_cost_usd": 0.001, "iterations": 1},
        ),
    ]


# ─────────────────────────────────────────────────────────────────
# Invoke no longer writes STM directly — pending metadata only
# ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_invoke_does_not_call_record_message() -> None:
    """Cycle 20260501_1 C — `_invoke_pipeline` resolves metadata but
    does not record_message. STM write happens at s18 via
    GenyDedupeStrategy. The fake memory manager here observes zero
    record calls because nothing in this fake path drives s18."""
    session, mem = _make_session(_success_events("와! 안녕"))
    await session._invoke_pipeline("hi there", start_time=0.0, session_logger=None)
    assert mem.messages == [], (
        "_invoke_pipeline must not call record_message anymore; "
        "the dedupe strategy at s18 owns that single write site"
    )


@pytest.mark.asyncio
async def test_invoke_user_chat_stamps_pending_metadata_for_both_roles() -> None:
    """A plain user_chat input populates `_pending_message_metadata`
    with both `user` (USER_CHAT/IN) and `assistant` (USER_CHAT/OUT)
    so s18 can record either side with full metadata."""
    session, _mem = _make_session(_success_events("와! 안녕"))
    await session._invoke_pipeline("hi there", start_time=0.0, session_logger=None)

    state = session._pipeline.last_state  # type: ignore[attr-defined]
    pending = state.metadata.get("_pending_message_metadata")
    assert pending is not None
    assert "user" in pending and "assistant" in pending
    assert pending["user"]["kind"] == "user_chat"
    assert pending["user"]["direction"] == "in"
    assert pending["assistant"]["kind"] == "user_chat"
    assert pending["assistant"]["direction"] == "out"
    assert pending["user"]["counterpart_id"] == pending["assistant"]["counterpart_id"]


@pytest.mark.asyncio
async def test_invoke_thinking_trigger_skips_pending_metadata() -> None:
    """Internal triggers (`[THINKING_TRIGGER:*]`) are filled with
    explicit source_metadata by ThinkingTriggerService; without that
    explicit hint, the parser deliberately returns None and the
    invoke leaves `_pending_message_metadata` unset."""
    session, _mem = _make_session(_success_events("음 조용하네"))
    await session._invoke_pipeline(
        "[THINKING_TRIGGER:first_idle] user has been quiet",
        start_time=0.0,
        session_logger=None,
    )
    state = session._pipeline.last_state  # type: ignore[attr-defined]
    assert "_pending_message_metadata" not in state.metadata


@pytest.mark.asyncio
async def test_invoke_sub_worker_result_in_worker_session_stamps_user_meta_only() -> None:
    """For *Worker* / *Sub-Worker* sessions, `[SUB_WORKER_RESULT]`
    inputs leave the assistant slot empty: the response is a tool /
    task result, not user-facing chat. (Cycle 20260501_2 F2 narrows
    the auto-USER_CHAT/OUT default to VTuber sessions only.)"""
    session, _mem = _make_session(_success_events("완료됐네!"))
    # _make_session leaves self._role at its WORKER default — no override needed
    await session._invoke_pipeline(
        "[SUB_WORKER_RESULT] test.txt created",
        start_time=0.0,
        session_logger=None,
    )
    state = session._pipeline.last_state  # type: ignore[attr-defined]
    pending = state.metadata.get("_pending_message_metadata") or {}
    assert "assistant" not in pending, (
        "USER_CHAT/OUT metadata must not be invented for non-VTuber sessions"
    )


@pytest.mark.asyncio
async def test_invoke_vtuber_session_defaults_assistant_to_user_chat_for_subworker_input() -> None:
    """Cycle 20260501_2 F2 — for *VTuber* sessions, every assistant
    response is broadcast back to the chat room (or routed via
    `_save_subworker_reply_to_chat_room` after a SUB_WORKER_RESULT
    drain). So even when stm_role is `assistant_dm`, the assistant
    slot must default to USER_CHAT/OUT to the owner — without this,
    session.jsonl line 6 (a VTuber narrating after a SUB_WORKER_RESULT)
    records with metadata=None and disappears from the InteractionEvent
    stream / Memory tab."""
    from service.executor.agent_session import SessionRole

    session, _mem = _make_session(_success_events("워커가 끝냈대!"))
    session._role = SessionRole.VTUBER  # type: ignore[assignment]
    session._owner_username = "alice"  # type: ignore[assignment]

    await session._invoke_pipeline(
        "[SUB_WORKER_RESULT] test.txt created",
        start_time=0.0,
        session_logger=None,
    )
    state = session._pipeline.last_state  # type: ignore[attr-defined]
    pending = state.metadata.get("_pending_message_metadata") or {}
    assert "assistant" in pending, (
        "VTuber assistant turns must always carry pending USER_CHAT/OUT "
        "metadata regardless of what triggered the turn"
    )
    assert pending["assistant"]["kind"] == "user_chat"
    assert pending["assistant"]["direction"] == "out"
    assert pending["assistant"]["counterpart_role"] == "user"


@pytest.mark.asyncio
async def test_invoke_vtuber_session_defaults_assistant_to_user_chat_for_thinking_trigger() -> None:
    """Cycle 20260501_2 F2 — same VTuber default applies to
    `[THINKING_TRIGGER:*]` invocations: the VTuber's reflection-style
    narration is still broadcast as chat. The user slot may be empty
    (parser returns None without an explicit source_metadata) but
    the assistant slot must still default."""
    from service.executor.agent_session import SessionRole

    session, _mem = _make_session(_success_events("음 조용하구만"))
    session._role = SessionRole.VTUBER  # type: ignore[assignment]
    session._owner_username = "alice"  # type: ignore[assignment]

    await session._invoke_pipeline(
        "[THINKING_TRIGGER:first_idle] user has been quiet",
        start_time=0.0,
        session_logger=None,
    )
    state = session._pipeline.last_state  # type: ignore[attr-defined]
    pending = state.metadata.get("_pending_message_metadata") or {}
    assert "assistant" in pending
    assert pending["assistant"]["kind"] == "user_chat"
    assert pending["assistant"]["direction"] == "out"


@pytest.mark.asyncio
async def test_invoke_explicit_source_metadata_threads_through() -> None:
    """When a caller (e.g. `_trigger_dm_response`) passes explicit
    `source_metadata=...`, the invoke uses that verbatim for the
    user side and skips the parser fallback."""
    session, _mem = _make_session(_success_events("ok"))
    explicit = {
        "event_id": "EVT-EXPLICIT",
        "kind": "task_result",
        "direction": "in",
        "counterpart_id": "sub-1",
        "counterpart_role": "paired_subworker",
    }
    await session._invoke_pipeline(
        "irrelevant prompt body",
        start_time=0.0,
        session_logger=None,
        source_metadata=explicit,
    )
    state = session._pipeline.last_state  # type: ignore[attr-defined]
    pending = state.metadata.get("_pending_message_metadata") or {}
    assert pending.get("user") == explicit


@pytest.mark.asyncio
async def test_invoke_metadata_resolution_failure_does_not_break_invoke() -> None:
    """Exceptions during metadata resolution must be swallowed —
    the invoke must continue without a pending hint so s18 records
    legacy-style (metadata=None)."""
    session, _mem = _make_session(_success_events("ok"))

    # Make _classify_input_role raise via monkeypatch on the import target
    import service.executor.agent_session as mod

    def _boom(_text: str) -> str:
        raise RuntimeError("classifier exploded")

    original = mod._classify_input_role
    mod._classify_input_role = _boom  # type: ignore[assignment]
    try:
        result = await session._invoke_pipeline(
            "hi", start_time=0.0, session_logger=None,
        )
    finally:
        mod._classify_input_role = original

    assert result["output"] == "ok"
    state = session._pipeline.last_state  # type: ignore[attr-defined]
    assert "_pending_message_metadata" not in state.metadata


# ─────────────────────────────────────────────────────────────────
# _astream_pipeline mirrors the same contract
# ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stream_does_not_call_record_message() -> None:
    session, mem = _make_session(_success_events("yup"))
    async for _ in session._astream_pipeline(
        "hello",
        start_time=0.0,
        session_logger=None,
    ):
        pass
    assert mem.messages == [], (
        "_astream_pipeline must not call record_message anymore"
    )


@pytest.mark.asyncio
async def test_stream_user_chat_stamps_pending_metadata() -> None:
    session, _mem = _make_session(_success_events("yup"))
    async for _ in session._astream_pipeline(
        "hello",
        start_time=0.0,
        session_logger=None,
    ):
        pass
    state = session._pipeline.last_state  # type: ignore[attr-defined]
    pending = state.metadata.get("_pending_message_metadata")
    assert pending is not None
    assert pending["user"]["direction"] == "in"
    assert pending["assistant"]["direction"] == "out"


@pytest.mark.asyncio
async def test_stream_vtuber_session_defaults_assistant_to_user_chat_for_subworker_input() -> None:
    """Cycle 20260501_2 F2 mirror — `_astream_pipeline` applies the
    same VTuber-only USER_CHAT/OUT default."""
    from service.executor.agent_session import SessionRole

    session, _mem = _make_session(_success_events("워커가 끝냈대!"))
    session._role = SessionRole.VTUBER  # type: ignore[assignment]
    session._owner_username = "alice"  # type: ignore[assignment]

    async for _ in session._astream_pipeline(
        "[SUB_WORKER_RESULT] test.txt created",
        start_time=0.0,
        session_logger=None,
    ):
        pass
    state = session._pipeline.last_state  # type: ignore[attr-defined]
    pending = state.metadata.get("_pending_message_metadata") or {}
    assert "assistant" in pending
    assert pending["assistant"]["kind"] == "user_chat"
    assert pending["assistant"]["direction"] == "out"
