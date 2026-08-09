"""A reconnecting client must be told a broadcast is over.

Silence is ambiguous over a stream: "still running, nothing new since your
last event" and "that broadcast died with the process" look identical. The
client keeps its spinner, and the user watches a chat entry count past 1,700
seconds with nothing behind it.

`_active_broadcasts` lives in memory and is the only source of truth, so no
entry means nothing is running. Saying so is the whole fix.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List

import pytest

from ws import chat_stream


@dataclass
class _State:
    broadcast_id: str = "b-1"
    finished: bool = False
    total: int = 1
    completed: int = 0
    responded: int = 0
    agent_states: Dict[str, Any] = field(default_factory=dict)


class _WS:
    def __init__(self) -> None:
        self.sent: List[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


def _types(ws: _WS) -> List[str]:
    return [m["type"] for m in ws.sent]


@pytest.mark.asyncio
async def test_no_active_broadcast_tells_the_client_to_clear():
    """THE property. The client's handler clears its spinner on this event."""
    ws = _WS()

    sent = await chat_stream._send_event(ws, "broadcast_done", {
        "broadcast_id": None, "reason": "no_active_broadcast",
    }, "room-1")

    assert sent is True
    assert _types(ws) == ["broadcast_done"]
    assert ws.sent[0]["data"]["reason"] == "no_active_broadcast"


def test_nothing_running_yields_a_clear_signal():
    """THE property, at the decision itself."""
    events = chat_stream.initial_broadcast_events(None, lambda a: a)

    assert [t for t, _ in events] == ["broadcast_done"]
    assert events[0][1]["reason"] == "no_active_broadcast"


def test_a_finished_broadcast_also_clears():
    """A broadcast that completed while the client was away is just as stale
    as one that never existed."""
    events = chat_stream.initial_broadcast_events(_State(finished=True), lambda a: a)

    assert [t for t, _ in events] == ["broadcast_done"]
    assert events[0][1]["broadcast_id"] == "b-1"


def test_a_live_broadcast_is_replayed_not_cleared():
    """The opposite failure: clearing a broadcast that IS running would drop
    the user's progress view mid-turn."""
    state = _State(total=3, completed=1, responded=1)
    events = chat_stream.initial_broadcast_events(state, lambda a: a)

    assert [t for t, _ in events] == ["broadcast_status"]
    assert events[0][1]["completed"] == 1
    assert events[0][1]["finished"] is False


def test_agent_progress_rides_along_when_there_is_any():
    state = _State(agent_states={"s1": "A", "s2": "B"})
    events = chat_stream.initial_broadcast_events(state, lambda a: f"<{a}>")

    assert [t for t, _ in events] == ["broadcast_status", "agent_progress"]
    assert events[1][1]["agents"] == ["<A>", "<B>"]


@pytest.mark.asyncio
async def test_a_dead_socket_does_not_raise():
    """The reconnect handshake runs before the main loop; a client that
    vanished mid-handshake must not take the handler down."""
    class _Dead:
        async def send_json(self, payload):
            raise RuntimeError("socket closed")

    assert await chat_stream._send_event(_Dead(), "broadcast_done", {}, "r") is False
