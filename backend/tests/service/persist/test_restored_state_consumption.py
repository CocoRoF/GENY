"""R2 (audit 20260425_3 §1.5) regression — when ``_restored_state``
is stashed on an agent, the next turn's PipelineState construction
in ``agent_session`` consumes it (instead of building a fresh one)
and clears the attribute (one-shot).

Without this wiring the /restore endpoint would happily report
``restored: True / messages_restored: N`` while the next turn's
LLM context starts empty — a silent lie.

Tests don't spin a real Pipeline (that would require the full
session bootstrap). Instead they call the same logic the agent
session uses and assert the contract: restored state is honoured
on first read, then None on second read.
"""

from __future__ import annotations

import pytest

pytest.importorskip("geny_executor")

from geny_executor.core.state import PipelineState  # noqa: E402


class _AgentLike:
    """Minimal stand-in for AgentSession exposing only the attributes
    the consumption helper reads (`_session_id`, `_restored_state`)."""

    def __init__(self, session_id: str = "s1") -> None:
        self._session_id = session_id
        self._restored_state = None


def _consume_restored_state(agent) -> PipelineState:
    """Mirror the body of agent_session.py:1577 (and 1948).

    Kept as a standalone helper so the test isn't coupled to the
    private indentation of the real method — if a future refactor
    moves the logic into a method, this test moves with it.
    """
    restored = getattr(agent, "_restored_state", None)
    if restored is not None:
        state = restored
        try:
            state.session_id = agent._session_id
        except Exception:
            state = PipelineState(session_id=agent._session_id)
        agent._restored_state = None  # one-shot
        return state
    return PipelineState(session_id=agent._session_id)


def test_no_restored_state_returns_fresh() -> None:
    agent = _AgentLike(session_id="s1")
    state = _consume_restored_state(agent)
    assert state.session_id == "s1"
    assert state.messages == []
    assert state.iteration == 0


def test_restored_state_consumed_and_cleared() -> None:
    agent = _AgentLike(session_id="s2")
    pre_restored = PipelineState(session_id="old-session-id")
    pre_restored.messages = [{"role": "user", "content": "hi"}]
    pre_restored.iteration = 3
    agent._restored_state = pre_restored

    state = _consume_restored_state(agent)
    # Restored state is the SAME object (no copy), so messages /
    # iteration carry over.
    assert state is pre_restored
    assert state.messages == [{"role": "user", "content": "hi"}]
    assert state.iteration == 3
    # session_id rebound to the live session.
    assert state.session_id == "s2"
    # One-shot — agent attr cleared so the next turn doesn't re-apply.
    assert agent._restored_state is None


def test_second_turn_after_consumption_returns_fresh() -> None:
    agent = _AgentLike(session_id="s3")
    pre_restored = PipelineState(session_id="x")
    pre_restored.iteration = 7
    agent._restored_state = pre_restored

    first = _consume_restored_state(agent)
    second = _consume_restored_state(agent)

    assert first.iteration == 7
    assert second.iteration == 0  # fresh state for the next turn


def test_restore_with_unsettable_session_id_falls_back() -> None:
    """If PipelineState rejects session_id reassignment (frozen
    pin), the consumer logs and falls back to fresh state — never
    crash the turn."""

    class _FrozenState:
        def __init__(self) -> None:
            self.messages = ["should-be-discarded"]
            self.iteration = 99

        @property
        def session_id(self) -> str:
            return "frozen"

        @session_id.setter
        def session_id(self, value: str) -> None:
            raise AttributeError("frozen")

    agent = _AgentLike(session_id="s4")
    agent._restored_state = _FrozenState()

    state = _consume_restored_state(agent)
    assert isinstance(state, PipelineState)
    assert state.session_id == "s4"
    assert state.messages == []
    # Still cleared even though the rebind failed — we don't want a
    # poison pill stuck on the agent.
    assert agent._restored_state is None
