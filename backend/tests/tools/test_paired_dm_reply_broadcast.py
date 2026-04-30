"""Cycle 20260430_1 P1-1 — Sub-Worker → VTuber DM reply broadcast.

Pins the new ``_maybe_save_paired_dm_reply`` helper that surfaces the
VTuber's paraphrased reply (generated inside ``_trigger_dm_response``)
to the user-visible chat room. Before this fix the reply died inside
the fire-and-forget task — it only appeared because the now-suppressed
auto fallback in ``_notify_linked_vtuber`` re-broadcast through
``_save_subworker_reply_to_chat_room``. Cycle 20260430_1 P0-1 removed
that crutch, so this helper is now the *only* surface.

The helper must:
  * fire only when sender is a paired Sub-Worker (``_session_type == "sub"``)
    and target is its bound VTuber (``_session_type == "vtuber"`` AND
    ``sender._linked_session_id == target_session_id``);
  * skip silently for other DM topologies (peer→peer external DMs,
    sub→unrelated VTuber, vtuber→sub direction, etc.);
  * never raise — failures inside the helper must not break tool
    execution.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from tools.built_in import geny_tools
from tools.built_in.geny_tools import _maybe_save_paired_dm_reply


class _FakeAgent:
    def __init__(
        self,
        session_id: str,
        *,
        session_type: Optional[str],
        linked_session_id: Optional[str] = None,
    ) -> None:
        self.session_id = session_id
        self._session_type = session_type
        self._linked_session_id = linked_session_id


class _FakeAgentManager:
    def __init__(self, agents: Dict[str, _FakeAgent]) -> None:
        self._agents = agents

    def get_agent(self, session_id: str) -> Optional[_FakeAgent]:
        return self._agents.get(session_id)


class _FakeResult:
    def __init__(self, *, success: bool = True, output: str = "ok"):
        self.success = success
        self.output = output


@pytest.fixture
def world(monkeypatch):
    """Install paired Sub-Worker / VTuber + an unrelated colleague,
    and capture broadcast calls to ``_save_subworker_reply_to_chat_room``."""
    vtuber = _FakeAgent("vtuber-1", session_type="vtuber", linked_session_id="sub-1")
    sub = _FakeAgent("sub-1", session_type="sub", linked_session_id="vtuber-1")
    other_vtuber = _FakeAgent(
        "vtuber-2", session_type="vtuber", linked_session_id="sub-2",
    )
    colleague = _FakeAgent("coll-1", session_type=None)

    manager = _FakeAgentManager({
        "vtuber-1": vtuber,
        "sub-1": sub,
        "vtuber-2": other_vtuber,
        "coll-1": colleague,
    })
    monkeypatch.setattr(geny_tools, "_get_agent_manager", lambda: manager)

    broadcast_calls: List[Dict[str, Any]] = []

    def _fake_save(session_id: str, result):
        broadcast_calls.append({"session_id": session_id, "result": result})

    monkeypatch.setattr(
        "service.execution.agent_executor._save_subworker_reply_to_chat_room",
        _fake_save,
        raising=False,
    )

    return {
        "manager": manager,
        "broadcast_calls": broadcast_calls,
        "vtuber": vtuber,
        "sub": sub,
        "other_vtuber": other_vtuber,
        "colleague": colleague,
    }


def test_paired_sub_to_vtuber_broadcasts(world) -> None:
    _maybe_save_paired_dm_reply(
        sender_session_id="sub-1",
        target_session_id="vtuber-1",
        result=_FakeResult(),
    )
    calls = world["broadcast_calls"]
    assert len(calls) == 1
    assert calls[0]["session_id"] == "vtuber-1"


def test_unpaired_sub_to_vtuber_does_not_broadcast(world) -> None:
    """Sub-Worker linked to a *different* VTuber must not leak its DM
    reply into a VTuber's room it doesn't belong to."""
    # Re-point the sub's linked id at a different VTuber than the one
    # it's currently DMing.
    world["sub"]._linked_session_id = "vtuber-2"
    _maybe_save_paired_dm_reply(
        sender_session_id="sub-1",
        target_session_id="vtuber-1",
        result=_FakeResult(),
    )
    assert world["broadcast_calls"] == []


def test_vtuber_to_sub_does_not_broadcast(world) -> None:
    """The reverse direction — VTuber DMing its Sub-Worker — must not
    surface inside the chat room (the user only ever sees the VTuber's
    voice, not the Worker's DM)."""
    _maybe_save_paired_dm_reply(
        sender_session_id="vtuber-1",
        target_session_id="sub-1",
        result=_FakeResult(),
    )
    assert world["broadcast_calls"] == []


def test_peer_dm_does_not_broadcast(world) -> None:
    """An unrelated colleague DMing the VTuber must not leak into the
    chat room either."""
    _maybe_save_paired_dm_reply(
        sender_session_id="coll-1",
        target_session_id="vtuber-1",
        result=_FakeResult(),
    )
    assert world["broadcast_calls"] == []


def test_missing_target_is_silent(world) -> None:
    _maybe_save_paired_dm_reply(
        sender_session_id="sub-1",
        target_session_id="ghost",
        result=_FakeResult(),
    )
    assert world["broadcast_calls"] == []


def test_helper_swallows_broadcast_errors(monkeypatch, world) -> None:
    def _boom(*_a, **_kw):
        raise RuntimeError("chat store down")

    monkeypatch.setattr(
        "service.execution.agent_executor._save_subworker_reply_to_chat_room",
        _boom,
        raising=False,
    )
    # Must not raise.
    _maybe_save_paired_dm_reply(
        sender_session_id="sub-1",
        target_session_id="vtuber-1",
        result=_FakeResult(),
    )
