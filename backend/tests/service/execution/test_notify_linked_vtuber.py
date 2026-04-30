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
    _categorize_tool_calls,
    _compose_subworker_payload_from_tools,
    _record_subworker_run_on_vtuber,
    _save_subworker_reply_to_chat_room,
    _strip_only_loop_signals,
)


class _FakeShortTerm:
    """STM stand-in capturing add_message-style records via record_message."""

    def __init__(self, recent: Optional[List[Dict[str, Any]]] = None) -> None:
        self._recent = list(recent or [])

    def get_recent(self, n: int = 20) -> List[Any]:
        from types import SimpleNamespace
        return [
            SimpleNamespace(
                content=f"[{r.get('role','?')}] {r.get('content','')}",
                metadata={"role": r.get("role", "?"), **(r.get("metadata") or {})},
            )
            for r in self._recent[-n:]
        ]


class _FakeMemoryManager:
    def __init__(self) -> None:
        self.records: List[Dict[str, Any]] = []
        self._stm = _FakeShortTerm()

    @property
    def short_term(self):
        return self._stm

    def record_message(
        self, role: str, content: str, metadata=None, **extra
    ) -> None:
        meta: Dict[str, Any] = dict(extra) if extra else {}
        if metadata:
            meta.update(metadata)
        self.records.append({"role": role, "content": content, "metadata": meta or None})

    def seed_recent(self, recent: List[Dict[str, Any]]) -> None:
        """Pre-populate the STM tail used by `_find_linked_task_request_event_id`."""
        self._stm = _FakeShortTerm(recent)


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
        memory: Optional[_FakeMemoryManager] = None,
    ) -> None:
        self.session_id = session_id
        self._session_type = session_type
        self.linked_session_id = linked_id
        self._chat_room_id = chat_room_id
        self._session_name = session_name
        self._role = role
        self.role = MagicMock(value=role)
        self._memory_manager = memory


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
# Helper — _strip_only_loop_signals (cycle 20260430_1 P1-3)
# ─────────────────────────────────────────────────────────────────


def test_strip_signals_returns_none_for_lone_task_complete() -> None:
    assert _strip_only_loop_signals("[TASK_COMPLETE]") is None
    assert _strip_only_loop_signals("  [TASK_COMPLETE]  ") is None


def test_strip_signals_returns_none_for_lone_blocked_or_continue() -> None:
    assert _strip_only_loop_signals("[BLOCKED: missing creds]") is None
    assert _strip_only_loop_signals("[CONTINUE: next step]") is None


def test_strip_signals_preserves_real_narration() -> None:
    text = "Wrote self_introduction.md.\n[TASK_COMPLETE]"
    assert _strip_only_loop_signals(text) == text


def test_strip_signals_passthrough_for_empty_or_none() -> None:
    assert _strip_only_loop_signals("") == ""
    assert _strip_only_loop_signals(None) is None


# ─────────────────────────────────────────────────────────────────
# Cycle 20260430_2 A4 — _categorize_tool_calls
# ─────────────────────────────────────────────────────────────────


def test_categorize_buckets_known_tool_families() -> None:
    cats = _categorize_tool_calls([
        {"name": "Write", "input": {"file_path": "a.md"}, "is_error": False, "duration_ms": 10},
        {"name": "Read", "input": {"file_path": "b.md"}, "is_error": False, "duration_ms": 5},
        {"name": "Bash", "input": {"command": "ls"}, "is_error": False, "duration_ms": 15},
        {"name": "web_search", "input": {"query": "OAuth2"}, "is_error": False, "duration_ms": 100},
        {"name": "Bash", "input": {"command": "rm /x"}, "is_error": True, "duration_ms": 20},
    ])
    assert cats["files_written"] == ["a.md"]
    assert cats["files_read"] == ["b.md"]
    assert len(cats["bash_commands"]) == 2
    assert cats["web_fetches"][0]["target"] == "OAuth2"
    assert len(cats["errors"]) == 1
    assert cats["errors"][0]["name"] == "Bash"
    assert cats["status"] == "partial"
    assert cats["total_calls"] == 5
    assert cats["ok_calls"] == 4
    assert cats["failed_calls"] == 1
    assert cats["tools_used"] == ["Write", "Read", "Bash", "web_search"]


def test_categorize_all_ok_yields_status_ok() -> None:
    cats = _categorize_tool_calls([
        {"name": "Write", "input": {"file_path": "a.md"}, "is_error": False, "duration_ms": 1},
    ])
    assert cats["status"] == "ok"


def test_categorize_all_error_yields_status_failed() -> None:
    cats = _categorize_tool_calls([
        {"name": "Bash", "input": {"command": "x"}, "is_error": True, "duration_ms": 1},
    ])
    assert cats["status"] == "failed"


def test_categorize_empty_is_safe() -> None:
    cats = _categorize_tool_calls([])
    assert cats["files_written"] == []
    assert cats["bash_commands"] == []


# ─────────────────────────────────────────────────────────────────
# Cycle 20260430_2 A4 — _record_subworker_run_on_vtuber
# ─────────────────────────────────────────────────────────────────


def _make_vtuber_with_memory() -> _FakeAgent:
    return _FakeAgent(
        "vtuber-1",
        session_type="vtuber",
        linked_id="sub-1",
        chat_room_id="room-1",
        memory=_FakeMemoryManager(),
    )


def test_record_subworker_run_writes_tool_run_summary_metadata() -> None:
    vtuber = _make_vtuber_with_memory()
    result = ExecutionResult(
        success=True,
        session_id="sub-1",
        output="",
        duration_ms=120,
        tool_calls=[
            {"name": "Write", "input": {"file_path": "notes.md"}, "is_error": False, "duration_ms": 30},
        ],
    )
    _record_subworker_run_on_vtuber(
        vtuber_agent=vtuber,
        sub_session_id="sub-1",
        result=result,
    )

    mem = vtuber._memory_manager
    assert len(mem.records) == 1
    rec = mem.records[0]
    assert rec["role"] == "assistant_dm"
    assert "Sub-Worker run" in rec["content"]
    meta = rec["metadata"]
    assert meta is not None
    assert meta["kind"] == "tool_run_summary"
    assert meta["direction"] == "in"
    assert meta["counterpart_id"] == "sub-1"
    assert meta["counterpart_role"] == "paired_subworker"
    payload = meta["payload"]
    assert payload["files_written"] == ["notes.md"]
    assert payload["status"] == "ok"
    assert payload["duration_ms"] == 120


def test_record_subworker_run_links_back_to_recent_task_request() -> None:
    vtuber = _make_vtuber_with_memory()
    # Seed a prior task_request from this vtuber to sub-1
    vtuber._memory_manager.seed_recent([
        {
            "role": "assistant_dm",
            "content": "[DM to Sub-Worker (internal)]: please write notes.md",
            "metadata": {
                "event_id": "REQ-1",
                "kind": "task_request",
                "direction": "out",
                "counterpart_id": "sub-1",
                "counterpart_role": "paired_subworker",
            },
        }
    ])
    result = ExecutionResult(
        success=True, session_id="sub-1", output="", duration_ms=50,
        tool_calls=[
            {"name": "Write", "input": {"file_path": "notes.md"}, "is_error": False, "duration_ms": 30},
        ],
    )
    _record_subworker_run_on_vtuber(
        vtuber_agent=vtuber, sub_session_id="sub-1", result=result,
    )
    rec = vtuber._memory_manager.records[0]
    assert rec["metadata"]["linked_event_id"] == "REQ-1"


def test_record_subworker_run_skips_truly_empty_turn() -> None:
    """No tool calls + no narration + no error → nothing to remember."""
    vtuber = _make_vtuber_with_memory()
    result = ExecutionResult(
        success=True, session_id="sub-1", output="", duration_ms=10, tool_calls=[],
    )
    _record_subworker_run_on_vtuber(
        vtuber_agent=vtuber, sub_session_id="sub-1", result=result,
    )
    assert vtuber._memory_manager.records == []


def test_record_subworker_run_records_failure_with_error_message() -> None:
    vtuber = _make_vtuber_with_memory()
    result = ExecutionResult(
        success=False, session_id="sub-1", error="Timeout after 60s",
        duration_ms=60_000, tool_calls=[],
    )
    _record_subworker_run_on_vtuber(
        vtuber_agent=vtuber, sub_session_id="sub-1", result=result,
    )
    rec = vtuber._memory_manager.records[0]
    assert "failed" in rec["content"]
    assert rec["metadata"]["payload"]["status"] == "failed"


def test_record_subworker_run_no_memory_manager_is_silent() -> None:
    """A vtuber without a memory manager (early-init / test) must not
    crash the recorder — best-effort path."""
    vtuber = _FakeAgent("vtuber-1", session_type="vtuber", linked_id="sub-1")
    result = ExecutionResult(
        success=True, session_id="sub-1", output="ok",
        tool_calls=[{"name": "Write", "input": {"file_path": "x"}, "is_error": False, "duration_ms": 1}],
    )
    # Should not raise.
    _record_subworker_run_on_vtuber(
        vtuber_agent=vtuber, sub_session_id="sub-1", result=result,
    )


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
async def test_notify_linked_vtuber_skips_when_nothing_happened(
    monkeypatch, patched_world
):
    """Cycle 20260430_1 P0-3 — a turn that produced no LLM text,
    no tool calls, and no explicit report has nothing meaningful to
    forward. The notify path must skip dispatch entirely (and log the
    decision) instead of leaking the canned "Task finished with no
    output." line into the chat room."""
    execute_calls: List[Dict[str, Any]] = []

    async def _track_execute(target: str, content: str, **_kwargs):
        execute_calls.append({"target": target, "content": content})
        return ExecutionResult(success=True, session_id=target, output="hi")

    monkeypatch.setattr(agent_executor, "execute_command", _track_execute)

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
        success=True,
        session_id="sub-1",
        output="",
        duration_ms=10,
        tool_calls=[],
    )
    await agent_executor._notify_linked_vtuber("sub-1", sub_result)

    for task in created_tasks:
        await task

    assert execute_calls == [], (
        "_notify_linked_vtuber must NOT dispatch a notification when "
        "the Sub-Worker turn produced no text, no tools, and no "
        "explicit report"
    )
    assert any(
        evt.get("metadata", {}).get("event")
        == "delegation.suppressed_empty_turn"
        for evt in log_events
    ), f"Expected empty-turn suppress log, got: {log_events}"


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
async def test_notify_linked_vtuber_synthesises_when_output_is_only_loop_signal(
    monkeypatch, patched_world
):
    """Cycle 20260430_1 P1-3 — when the worker's only output is
    ``[TASK_COMPLETE]`` (or another bare loop signal), the synthesis
    path must still run instead of wrapping the bare marker as a
    user-facing summary."""
    captured: List[Dict[str, Any]] = []

    async def _capture_execute(target: str, content: str, **_kwargs):
        captured.append({"content": content})
        return ExecutionResult(success=True, session_id=target, output="ok")

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
        output="[TASK_COMPLETE]",
        duration_ms=10,
        tool_calls=[
            {
                "name": "Write",
                "input": {"file_path": "notes.md"},
                "is_error": False,
                "duration_ms": 5,
            },
        ],
    )
    await agent_executor._notify_linked_vtuber("sub-1", sub_result)
    for task in created_tasks:
        await task

    assert len(captured) == 1
    payload = captured[0]["content"]
    # Synthesised payload, not the wrapped bare marker.
    assert "Task completed successfully." not in payload
    assert "[TASK_COMPLETE]" not in payload
    assert "status: ok" in payload
    assert "notes.md" in payload


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
