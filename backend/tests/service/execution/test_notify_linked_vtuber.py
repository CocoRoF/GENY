"""Regression tests for the Sub-Worker → VTuber auto-report chat broadcast.

Cycle 20260420_8 / plan/02 closes Bug 2a: when a Sub-Worker finishes a
delegated task, ``_notify_linked_vtuber`` fires a ``[SUB_WORKER_RESULT]``
trigger to the paired VTuber. Before this fix the VTuber generated a
conversational reply to that trigger (observable in the logs as
``output_len=164``) but the reply was never posted to the user's chat
room — it died inside the fire-and-forget task. These tests pin the
new ``_save_subworker_reply_to_chat_room`` helper and the one call
site that invokes it.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest

from service.execution import agent_executor
from service.execution.agent_executor import (
    AlreadyExecutingError,
    ExecutionResult,
    _compose_subworker_payload_from_tools,
    _save_subworker_reply_to_chat_room,
)


class _FakeAgent:
    """Stand-in AgentSession that exposes the handful of attributes
    the executor inspects during notify/broadcast."""

    def __init__(
        self,
        session_id: str,
        *,
        session_type: str = "sub",
        linked_id: Optional[str] = None,
        chat_room_id: Optional[str] = None,
        session_name: str = "Test",
        role: str = "vtuber",
    ) -> None:
        self.session_id = session_id
        self._session_type = session_type
        self.linked_session_id = linked_id
        self._chat_room_id = chat_room_id
        self._session_name = session_name
        self._role = role
        self.role = MagicMock(value=role)


class _FakeAgentManager:
    def __init__(self, agents: Dict[str, _FakeAgent]) -> None:
        self._agents = agents

    def get_agent(self, session_id: str) -> Optional[_FakeAgent]:
        return self._agents.get(session_id)


class _FakeChatStore:
    def __init__(self) -> None:
        self.messages: List[Dict[str, Any]] = []

    def add_message(self, room_id: str, msg: Dict[str, Any]) -> Dict[str, Any]:
        entry = {"id": f"msg-{len(self.messages)}", "room_id": room_id, **msg}
        self.messages.append(entry)
        return entry


@pytest.fixture
def patched_world(monkeypatch):
    """Install fakes for the agent manager, chat store, and
    ``_notify_room``; return references so tests can assert."""
    vtuber = _FakeAgent(
        "vtuber-1",
        session_type="vtuber",
        linked_id="sub-1",
        chat_room_id="room-1",
    )
    sub = _FakeAgent(
        "sub-1",
        session_type="sub",
        linked_id="vtuber-1",
        chat_room_id="room-1",
    )
    agents = {"vtuber-1": vtuber, "sub-1": sub}
    manager = _FakeAgentManager(agents)
    store = _FakeChatStore()
    notify_calls: List[str] = []

    monkeypatch.setattr(agent_executor, "_get_agent_manager", lambda: manager)

    # Stub the lazy imports that the helpers pull in.
    monkeypatch.setattr(
        "service.chat.conversation_store.get_chat_store",
        lambda: store,
        raising=False,
    )
    monkeypatch.setattr(
        "controller.chat_controller._notify_room",
        lambda rid: notify_calls.append(rid),
        raising=False,
    )

    return {
        "manager": manager,
        "store": store,
        "notify_calls": notify_calls,
        "vtuber": vtuber,
        "sub": sub,
    }


# ─────────────────────────────────────────────────────────────────
# Helper — _compose_subworker_payload_from_tools (cycle 20260430_1 P0-2)
# ─────────────────────────────────────────────────────────────────


def _result_with_tools(tool_calls):
    return ExecutionResult(
        success=True,
        session_id="sub-1",
        output="",
        duration_ms=10,
        tool_calls=tool_calls,
    )


def test_compose_payload_returns_none_when_no_tools() -> None:
    assert _compose_subworker_payload_from_tools(_result_with_tools([])) is None


def test_compose_payload_single_write_is_ok_with_artifact() -> None:
    payload = _compose_subworker_payload_from_tools(
        _result_with_tools([
            {
                "name": "Write",
                "input": {"file_path": "self_introduction.md"},
                "is_error": False,
                "duration_ms": 50,
            },
        ])
    )
    assert payload is not None
    assert payload.startswith("[SUB_WORKER_RESULT]")
    assert "status: ok" in payload
    assert "summary:" in payload
    assert "Tools used: Write" in payload
    assert "Total calls: 1 (1 ok, 0 failed)" in payload
    assert "artifacts:" in payload
    assert "- self_introduction.md" in payload


def test_compose_payload_partial_when_some_fail() -> None:
    payload = _compose_subworker_payload_from_tools(
        _result_with_tools([
            {"name": "Write", "input": {"file_path": "a.md"}, "is_error": False, "duration_ms": 5},
            {"name": "Bash", "input": {"command": "rm /etc/secret"}, "is_error": True, "duration_ms": 5},
        ])
    )
    assert payload is not None
    assert "status: partial" in payload
    assert "Tools used: Write, Bash" in payload
    assert "Total calls: 2 (1 ok, 1 failed)" in payload
    # Errored Bash must not show as an artifact
    assert "/etc/secret" not in payload


def test_compose_payload_failed_when_all_error() -> None:
    payload = _compose_subworker_payload_from_tools(
        _result_with_tools([
            {"name": "Write", "input": {"file_path": "x"}, "is_error": True, "duration_ms": 5},
            {"name": "Bash", "input": {}, "is_error": True, "duration_ms": 5},
        ])
    )
    assert payload is not None
    assert "status: failed" in payload
    assert "artifacts: []" in payload


def test_compose_payload_dedupes_artifacts() -> None:
    payload = _compose_subworker_payload_from_tools(
        _result_with_tools([
            {"name": "Write", "input": {"file_path": "a.md"}, "is_error": False, "duration_ms": 5},
            {"name": "Edit", "input": {"file_path": "a.md"}, "is_error": False, "duration_ms": 5},
        ])
    )
    assert payload is not None
    assert payload.count("- a.md") == 1


# ─────────────────────────────────────────────────────────────────
# Helper — _save_subworker_reply_to_chat_room
# ─────────────────────────────────────────────────────────────────


def test_successful_reply_posts_to_chat_room(patched_world) -> None:
    result = ExecutionResult(
        success=True,
        session_id="vtuber-1",
        output="와! Sub-Worker가 파일 만들었어!",
        duration_ms=1234,
        cost_usd=0.0042,
    )
    _save_subworker_reply_to_chat_room("vtuber-1", result)

    store = patched_world["store"]
    assert len(store.messages) == 1
    msg = store.messages[0]
    assert msg["room_id"] == "room-1"
    assert msg["type"] == "agent"
    assert msg["session_id"] == "vtuber-1"
    assert msg["content"] == "와! Sub-Worker가 파일 만들었어!"
    assert msg["source"] == "sub_worker_reply"
    assert msg["duration_ms"] == 1234
    assert msg["cost_usd"] == 0.0042

    # SSE notify fires once
    assert patched_world["notify_calls"] == ["room-1"]


def test_empty_output_skips_broadcast(patched_world) -> None:
    """Zero-length or whitespace-only outputs are not worth
    surfacing — the VTuber intentionally stayed silent."""
    result = ExecutionResult(
        success=True, session_id="vtuber-1", output="   \n  ", duration_ms=10,
    )
    _save_subworker_reply_to_chat_room("vtuber-1", result)

    assert patched_world["store"].messages == []
    assert patched_world["notify_calls"] == []


def test_failed_execution_skips_broadcast(patched_world) -> None:
    result = ExecutionResult(
        success=False,
        session_id="vtuber-1",
        output="would-be-output",
        error="boom",
        duration_ms=50,
    )
    _save_subworker_reply_to_chat_room("vtuber-1", result)

    assert patched_world["store"].messages == []


def test_vtuber_without_chat_room_is_noop(monkeypatch, patched_world) -> None:
    patched_world["vtuber"]._chat_room_id = None

    result = ExecutionResult(
        success=True, session_id="vtuber-1", output="hi", duration_ms=1,
    )
    _save_subworker_reply_to_chat_room("vtuber-1", result)

    assert patched_world["store"].messages == []
    assert patched_world["notify_calls"] == []


def test_unknown_vtuber_session_is_noop(patched_world) -> None:
    result = ExecutionResult(
        success=True, session_id="ghost", output="hi", duration_ms=1,
    )
    _save_subworker_reply_to_chat_room("ghost", result)

    assert patched_world["store"].messages == []


# ─────────────────────────────────────────────────────────────────
# _notify_linked_vtuber wiring — call site for the helper above
# ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_notify_linked_vtuber_broadcasts_reply(monkeypatch, patched_world):
    """End-to-end on the wiring: the Sub-Worker result triggers the
    VTuber, the VTuber's reply (returned by ``execute_command``) lands
    in the chat room, and SSE subscribers are notified."""
    reply = ExecutionResult(
        success=True,
        session_id="vtuber-1",
        output="와! 완료됐네!",
        duration_ms=200,
        cost_usd=0.002,
    )

    async def _fake_execute_command(target: str, content: str, **_kwargs):
        # The helper should hand us the VTuber session id + the
        # [SUB_WORKER_RESULT]-tagged prompt. Pretend the VTuber
        # produced its reply.
        assert target == "vtuber-1"
        assert content.startswith("[SUB_WORKER_RESULT]")
        return reply

    monkeypatch.setattr(agent_executor, "execute_command", _fake_execute_command)
    # _get_session_logger is used for the delegation.sent event; stub it.
    monkeypatch.setattr(
        agent_executor, "_get_session_logger", lambda *_a, **_kw: None
    )

    # The Sub-Worker finished with this result:
    sub_result = ExecutionResult(
        success=True,
        session_id="sub-1",
        output="test.txt created",
        duration_ms=500,
    )

    # _notify_linked_vtuber schedules a fire-and-forget task; we need
    # to await the *scheduled* coroutine, not the notify coroutine.
    # Capture the task and await it explicitly so the assertion runs
    # after the broadcast completes.
    created_tasks: List[asyncio.Task] = []
    original_create_task = asyncio.create_task

    def _capturing_create_task(coro, *args, **kwargs):
        task = original_create_task(coro, *args, **kwargs)
        created_tasks.append(task)
        return task

    monkeypatch.setattr(asyncio, "create_task", _capturing_create_task)

    await agent_executor._notify_linked_vtuber("sub-1", sub_result)

    # Drain the single scheduled trigger task.
    for task in created_tasks:
        await task

    store = patched_world["store"]
    assert len(store.messages) == 1, (
        "VTuber reply should be posted exactly once to the chat room"
    )
    assert store.messages[0]["content"] == "와! 완료됐네!"
    assert store.messages[0]["source"] == "sub_worker_reply"
    assert patched_world["notify_calls"] == ["room-1"]


@pytest.mark.asyncio
async def test_notify_linked_vtuber_synthesises_payload_from_tool_calls(
    monkeypatch, patched_world
):
    """Cycle 20260430_1 P0-2 — when the worker finishes a tool-only
    turn (no LLM final text) and did NOT send an explicit
    ``send_direct_message_internal`` payload, ``_notify_linked_vtuber``
    must build a worker.md-shaped payload from
    ``ExecutionResult.tool_calls`` instead of falling back to the
    canned "Task finished with no output." line."""
    captured: List[Dict[str, Any]] = []

    async def _capture_execute(target: str, content: str, **_kwargs):
        captured.append({"target": target, "content": content})
        return ExecutionResult(success=True, session_id=target, output="okay")

    monkeypatch.setattr(agent_executor, "execute_command", _capture_execute)
    monkeypatch.setattr(
        agent_executor, "_get_session_logger", lambda *_a, **_kw: None
    )

    created_tasks: List[asyncio.Task] = []
    original_create_task = asyncio.create_task

    def _capturing_create_task(coro, *args, **kwargs):
        task = original_create_task(coro, *args, **kwargs)
        created_tasks.append(task)
        return task

    monkeypatch.setattr(asyncio, "create_task", _capturing_create_task)

    sub_result = ExecutionResult(
        success=True,
        session_id="sub-1",
        output="",
        duration_ms=10,
        tool_calls=[
            {
                "name": "Write",
                "input": {"file_path": "self_introduction.md"},
                "is_error": False,
                "duration_ms": 50,
            },
        ],
    )
    await agent_executor._notify_linked_vtuber("sub-1", sub_result)

    for task in created_tasks:
        await task

    assert len(captured) == 1
    payload = captured[0]["content"]
    assert payload.startswith("[SUB_WORKER_RESULT]")
    assert "status: ok" in payload
    assert "Task finished with no output." not in payload
    assert "self_introduction.md" in payload


@pytest.mark.asyncio
async def test_notify_linked_vtuber_skips_when_explicit_report_sent(
    monkeypatch, patched_world
):
    """Cycle 20260430_1 P0-1 — when the Sub-Worker already delivered a
    structured ``[SUB_WORKER_RESULT]`` payload via
    ``send_direct_message_internal`` during this turn, the auto fallback
    must NOT fire a second notification. Otherwise the VTuber would see
    the canned "Task finished with no output." message right after it
    already processed the rich payload via Path A."""
    # Mark the sub session as having sent the explicit report this turn.
    patched_world["sub"]._explicit_subworker_report_sent = True

    execute_calls: List[Dict[str, Any]] = []

    async def _track_execute(target: str, content: str, **_kwargs):
        execute_calls.append({"target": target, "content": content})
        return ExecutionResult(success=True, session_id=target, output="hi")

    monkeypatch.setattr(agent_executor, "execute_command", _track_execute)

    # Capture session_logger calls so we can assert the suppression log.
    log_events: List[Dict[str, Any]] = []

    class _StubLogger:
        def log(self, **kwargs):
            log_events.append(kwargs)

        def log_delegation_event(self, *_a, **_kw):
            pass

    monkeypatch.setattr(
        agent_executor, "_get_session_logger", lambda *_a, **_kw: _StubLogger()
    )

    created_tasks: List[asyncio.Task] = []
    original_create_task = asyncio.create_task

    def _capturing_create_task(coro, *args, **kwargs):
        task = original_create_task(coro, *args, **kwargs)
        created_tasks.append(task)
        return task

    monkeypatch.setattr(asyncio, "create_task", _capturing_create_task)

    sub_result = ExecutionResult(
        success=True, session_id="sub-1", output="", duration_ms=10,
    )
    await agent_executor._notify_linked_vtuber("sub-1", sub_result)

    for task in created_tasks:
        await task

    assert execute_calls == [], (
        "_notify_linked_vtuber must not invoke the VTuber when the "
        "Sub-Worker already sent the structured payload via Path A"
    )
    assert patched_world["store"].messages == []
    # The suppression event was logged.
    assert any(
        evt.get("metadata", {}).get("event")
        == "delegation.suppressed_explicit_report"
        for evt in log_events
    ), f"Expected suppression log, got: {log_events}"


@pytest.mark.asyncio
async def test_notify_linked_vtuber_already_executing_falls_back_to_inbox(
    monkeypatch, patched_world
):
    """When the VTuber is busy, the existing inbox fallback still runs
    and the chat room is *not* posted to — the pending reply will be
    broadcast by the drain path when the busy turn completes."""
    inbox_calls: List[Dict[str, Any]] = []

    class _FakeInbox:
        def deliver(self, **kwargs):
            inbox_calls.append(kwargs)

        def send_to_dlq(self, **kwargs):
            raise AssertionError("DLQ should not fire in this path")

    async def _busy_execute(*_a, **_kw):
        raise AlreadyExecutingError("busy")

    monkeypatch.setattr(agent_executor, "execute_command", _busy_execute)
    monkeypatch.setattr(
        agent_executor, "_get_session_logger", lambda *_a, **_kw: None
    )
    monkeypatch.setattr(
        "service.chat.inbox.get_inbox_manager",
        lambda: _FakeInbox(),
        raising=False,
    )

    created_tasks: List[asyncio.Task] = []
    original_create_task = asyncio.create_task

    def _capturing_create_task(coro, *args, **kwargs):
        task = original_create_task(coro, *args, **kwargs)
        created_tasks.append(task)
        return task

    monkeypatch.setattr(asyncio, "create_task", _capturing_create_task)

    sub_result = ExecutionResult(
        success=True, session_id="sub-1", output="done", duration_ms=1,
    )
    await agent_executor._notify_linked_vtuber("sub-1", sub_result)

    for task in created_tasks:
        await task

    assert len(inbox_calls) == 1
    assert inbox_calls[0]["target_session_id"] == "vtuber-1"
    assert patched_world["store"].messages == [], (
        "Chat room must not receive a message when the VTuber was busy — "
        "the pending reply will surface via the inbox drain path"
    )
