"""Cycle 20260430_1 P1-4 — sub_worker_working trigger cooldown.

Pins the per-VTuber rate-limit on
``[THINKING_TRIGGER:sub_worker_working]``: a long-running Sub-Worker
turn must not make the VTuber loop the same "still busy" line every
tick. After the first fire, subsequent ticks within the cooldown
window fall through to the regular probability ladder.
"""

from __future__ import annotations

import time

import pytest

from service.vtuber import thinking_trigger as tt
from service.vtuber.thinking_trigger import (
    ThinkingTriggerService,
    _SUB_WORKER_WORKING_COOLDOWN_SECONDS,
)


class _FakeAgent:
    def __init__(self, linked_id: str) -> None:
        self.linked_session_id = linked_id


class _FakeAgentManager:
    def __init__(self, agent: _FakeAgent) -> None:
        self._agent = agent

    def get_agent(self, _session_id: str) -> _FakeAgent:
        return self._agent


@pytest.fixture
def with_busy_sub_worker(monkeypatch):
    """Install a paired VTuber session whose linked Sub-Worker is busy."""
    agent = _FakeAgent(linked_id="sub-1")
    manager = _FakeAgentManager(agent)
    monkeypatch.setattr(
        "service.executor.get_agent_session_manager",
        lambda: manager,
        raising=False,
    )
    return manager


def _is_executing_busy(session_id: str) -> bool:
    return session_id == "sub-1"


def _is_executing_idle(_session_id: str) -> bool:
    return False


def test_first_fire_returns_sub_worker_working(with_busy_sub_worker) -> None:
    svc = ThinkingTriggerService()
    prompt = svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert "[THINKING_TRIGGER:sub_worker_working]" in prompt


def test_second_fire_within_cooldown_falls_through(
    with_busy_sub_worker, monkeypatch
) -> None:
    svc = ThinkingTriggerService()
    # Force the random ladder to deterministically pick a different
    # category (idle fallback). 0.99 falls past activity / fun / time
    # probabilities and into idle-stage.
    monkeypatch.setattr(tt.random, "random", lambda: 0.99)

    first = svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert "[THINKING_TRIGGER:sub_worker_working]" in first

    # Within cooldown — must fall through to a non-sub_worker_working
    # category.
    second = svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert "[THINKING_TRIGGER:sub_worker_working]" not in second


def test_after_cooldown_fires_again(with_busy_sub_worker, monkeypatch) -> None:
    svc = ThinkingTriggerService()

    first = svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert "[THINKING_TRIGGER:sub_worker_working]" in first

    # Pretend the cooldown window already elapsed.
    svc._last_sub_worker_working_at["vtuber-1"] = (
        time.time() - _SUB_WORKER_WORKING_COOLDOWN_SECONDS - 1.0
    )

    second = svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert "[THINKING_TRIGGER:sub_worker_working]" in second


def test_unregister_clears_cooldown_state(with_busy_sub_worker) -> None:
    svc = ThinkingTriggerService()
    svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert "vtuber-1" in svc._last_sub_worker_working_at
    svc.unregister("vtuber-1")
    assert "vtuber-1" not in svc._last_sub_worker_working_at


def test_idle_sub_worker_does_not_arm_cooldown(
    with_busy_sub_worker, monkeypatch
) -> None:
    """If the Sub-Worker is idle the cooldown timer must not be touched
    — otherwise the next genuine busy moment would be silenced."""
    svc = ThinkingTriggerService()
    monkeypatch.setattr(tt.random, "random", lambda: 0.99)

    svc._build_trigger_prompt("vtuber-1", _is_executing_idle)
    assert "vtuber-1" not in svc._last_sub_worker_working_at
