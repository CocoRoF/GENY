"""Cycle 20260430_1 P1-2 — inbox metadata + drain dedupe.

Pins two contracts:

1. ``InboxManager.deliver`` accepts a ``metadata`` kwarg and persists it
   on the message so downstream consumers can identify the routing tag
   without parsing the body.
2. ``_drain_inbox`` deduplicates messages with the same
   ``(sender_session_id, metadata.tag)`` pair within a single drain
   pass — so a paired Sub-Worker that auto-fires multiple
   ``[SUB_WORKER_RESULT]`` notifications during a busy VTuber turn
   does not feed the same noise to the VTuber on drain.

We mock ``execute_command`` and ``InboxManager.pull_unread`` so the
drain runs in isolation.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List

import pytest

from service.chat.inbox import InboxManager
from service.execution import agent_executor
from service.execution.agent_executor import ExecutionResult, _drain_inbox


# ─────────────────────────────────────────────────────────────────
# 1. InboxManager.deliver carries metadata through round-trip
# ─────────────────────────────────────────────────────────────────


def test_deliver_persists_metadata(tmp_path) -> None:
    inbox = InboxManager(inbox_dir=tmp_path / "inbox", dlq_dir=tmp_path / "dlq")
    inbox.deliver(
        target_session_id="vtuber-1",
        content="[SUB_WORKER_RESULT] …",
        sender_session_id="sub-1",
        sender_name="Sub",
        metadata={"tag": "[SUB_WORKER_RESULT]", "task_id": "t-1"},
    )

    pulled = inbox.pull_unread("vtuber-1")
    assert len(pulled) == 1
    assert pulled[0]["metadata"] == {
        "tag": "[SUB_WORKER_RESULT]", "task_id": "t-1",
    }


def test_deliver_without_metadata_is_empty_dict(tmp_path) -> None:
    inbox = InboxManager(inbox_dir=tmp_path / "inbox", dlq_dir=tmp_path / "dlq")
    inbox.deliver(
        target_session_id="vtuber-1",
        content="hello",
        sender_session_id="x",
        sender_name="X",
    )
    pulled = inbox.pull_unread("vtuber-1")
    assert pulled[0]["metadata"] == {}


# ─────────────────────────────────────────────────────────────────
# 2. _drain_inbox dedupes by (sender, tag)
# ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_drain_dedupes_repeated_subworker_result(monkeypatch):
    """Two queued ``[SUB_WORKER_RESULT]`` from the same Sub-Worker are
    pulled in order — the second one must be skipped without invoking
    the VTuber."""
    pulls: List[Dict[str, Any]] = [
        {
            "id": "m1",
            "sender_session_id": "sub-1",
            "sender_name": "Sub",
            "content": "[SUB_WORKER_RESULT] first",
            "metadata": {"tag": "[SUB_WORKER_RESULT]"},
        },
        {
            "id": "m2",
            "sender_session_id": "sub-1",
            "sender_name": "Sub",
            "content": "[SUB_WORKER_RESULT] second",
            "metadata": {"tag": "[SUB_WORKER_RESULT]"},
        },
    ]

    class _StubInbox:
        def __init__(self, msgs):
            self._msgs = list(msgs)

        def pull_unread(self, session_id, limit=None):
            return [self._msgs.pop(0)] if self._msgs else []

    monkeypatch.setattr(
        "service.chat.inbox.get_inbox_manager",
        lambda: _StubInbox(pulls),
        raising=False,
    )

    execute_calls: List[Dict[str, Any]] = []

    async def _track_execute(target, prompt, **_kw):
        execute_calls.append({"target": target, "prompt": prompt})
        return ExecutionResult(success=True, session_id=target, output="ok")

    monkeypatch.setattr(agent_executor, "execute_command", _track_execute)
    monkeypatch.setattr(
        agent_executor, "_get_session_logger", lambda *_a, **_kw: None
    )

    # _drain_inbox uses a module-level `_draining_sessions` set; reset it.
    agent_executor._draining_sessions.discard("vtuber-1")
    await _drain_inbox("vtuber-1")

    assert len(execute_calls) == 1, (
        f"expected 1 execute (first message), got {len(execute_calls)}: "
        f"{execute_calls}"
    )
    assert "first" in execute_calls[0]["prompt"]


@pytest.mark.asyncio
async def test_drain_does_not_dedupe_different_senders(monkeypatch):
    """Two ``[SUB_WORKER_RESULT]`` from *different* senders must both
    pass — dedupe is keyed on (sender, tag), not tag alone."""
    pulls: List[Dict[str, Any]] = [
        {
            "id": "m1",
            "sender_session_id": "sub-A",
            "sender_name": "Sub A",
            "content": "[SUB_WORKER_RESULT] from A",
            "metadata": {"tag": "[SUB_WORKER_RESULT]"},
        },
        {
            "id": "m2",
            "sender_session_id": "sub-B",
            "sender_name": "Sub B",
            "content": "[SUB_WORKER_RESULT] from B",
            "metadata": {"tag": "[SUB_WORKER_RESULT]"},
        },
    ]

    class _StubInbox:
        def __init__(self, msgs):
            self._msgs = list(msgs)

        def pull_unread(self, session_id, limit=None):
            return [self._msgs.pop(0)] if self._msgs else []

    monkeypatch.setattr(
        "service.chat.inbox.get_inbox_manager",
        lambda: _StubInbox(pulls),
        raising=False,
    )

    execute_calls: List[Dict[str, Any]] = []

    async def _track_execute(target, prompt, **_kw):
        execute_calls.append({"target": target, "prompt": prompt})
        return ExecutionResult(success=True, session_id=target, output="ok")

    monkeypatch.setattr(agent_executor, "execute_command", _track_execute)
    monkeypatch.setattr(
        agent_executor, "_get_session_logger", lambda *_a, **_kw: None
    )

    agent_executor._draining_sessions.discard("vtuber-1")
    await _drain_inbox("vtuber-1")

    assert len(execute_calls) == 2


@pytest.mark.asyncio
async def test_drain_does_not_dedupe_messages_without_tag(monkeypatch):
    """Messages without a ``metadata.tag`` are ordinary user / DM
    content — they must not be deduped or the drain would silently
    drop legitimate traffic."""
    pulls: List[Dict[str, Any]] = [
        {
            "id": "m1",
            "sender_session_id": "user",
            "sender_name": "User",
            "content": "hi",
            "metadata": {},
        },
        {
            "id": "m2",
            "sender_session_id": "user",
            "sender_name": "User",
            "content": "hello again",
            "metadata": {},
        },
    ]

    class _StubInbox:
        def __init__(self, msgs):
            self._msgs = list(msgs)

        def pull_unread(self, session_id, limit=None):
            return [self._msgs.pop(0)] if self._msgs else []

    monkeypatch.setattr(
        "service.chat.inbox.get_inbox_manager",
        lambda: _StubInbox(pulls),
        raising=False,
    )

    execute_calls: List[Dict[str, Any]] = []

    async def _track_execute(target, prompt, **_kw):
        execute_calls.append({"target": target, "prompt": prompt})
        return ExecutionResult(success=True, session_id=target, output="ok")

    monkeypatch.setattr(agent_executor, "execute_command", _track_execute)
    monkeypatch.setattr(
        agent_executor, "_get_session_logger", lambda *_a, **_kw: None
    )

    agent_executor._draining_sessions.discard("vtuber-1")
    await _drain_inbox("vtuber-1")

    assert len(execute_calls) == 2
