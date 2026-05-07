"""Cycle 20260430_1 P1-4 — sub_worker_working trigger cooldown.

Pins the per-VTuber rate-limit on
``[THINKING_TRIGGER:sub_worker_working]``: a long-running Sub-Worker
turn must not make the VTuber loop the same "still busy" line every
tick. After the first fire, subsequent ticks within the cooldown
window fall through to the regular roulette.

Cycle 20260507 — refactored for the categories-only schema:

  • Phases are gone; consec range is just a condition on each
    category. The cooldown lives on
    :pyattr:`TriggerCategory.cooldown_seconds` and per-session fire
    times under :pyattr:`ThinkingTriggerService._last_category_fire`.
  • The runtime is now a two-stage roulette (category → prompt). To
    make the test deterministic we monkey-patch ``random.random`` to
    a value that always picks the *first* eligible candidate at each
    stage; ``sub_worker_working`` carries the dominant
    ``weight=1000.0`` in the bundled defaults, so the first stage
    will pick it whenever its conditions hold and its cooldown is
    clear.
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


@pytest.fixture
def force_smallest_roll(monkeypatch):
    """Force the two-stage roulette to pick the *heaviest* item per stage.

    The cooldown semantics we want to pin are categorical ("when busy
    and cooldown clear, sub_worker_working dominates"; "while in
    cooldown, sub_worker_working is filtered out"). Probabilistic
    runtime makes a literal first-tick assertion brittle, so we
    monkey-patch :func:`_weighted_pick` to deterministically pick the
    highest-weight survivor — same intent, no flakes.
    """

    def heaviest(items):
        if not items:
            return None
        return max(items, key=lambda pair: pair[0])[1]

    monkeypatch.setattr(tt, "_weighted_pick", heaviest)


def _is_executing_busy(session_id: str) -> bool:
    return session_id == "sub-1"


def _is_executing_idle(_session_id: str) -> bool:
    return False


def test_first_fire_returns_sub_worker_working(
    with_busy_sub_worker, force_smallest_roll
) -> None:
    svc = ThinkingTriggerService()
    prompt = svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert prompt is not None
    assert "[THINKING_TRIGGER:sub_worker_working]" in prompt


def test_second_fire_within_cooldown_falls_through(
    with_busy_sub_worker, force_smallest_roll
) -> None:
    svc = ThinkingTriggerService()
    first = svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert first is not None
    assert "[THINKING_TRIGGER:sub_worker_working]" in first

    second = svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert second is not None
    assert "[THINKING_TRIGGER:sub_worker_working]" not in second


def test_after_cooldown_fires_again(
    with_busy_sub_worker, force_smallest_roll
) -> None:
    svc = ThinkingTriggerService()

    first = svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert first is not None
    assert "[THINKING_TRIGGER:sub_worker_working]" in first

    svc._last_category_fire["vtuber-1"]["sub_worker_working"] = (
        time.time() - _SUB_WORKER_WORKING_COOLDOWN_SECONDS - 1.0
    )

    second = svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert second is not None
    assert "[THINKING_TRIGGER:sub_worker_working]" in second


def test_unregister_clears_cooldown_state(
    with_busy_sub_worker, force_smallest_roll
) -> None:
    svc = ThinkingTriggerService()
    svc._build_trigger_prompt("vtuber-1", _is_executing_busy)
    assert "vtuber-1" in svc._last_category_fire
    svc.unregister("vtuber-1")
    assert "vtuber-1" not in svc._last_category_fire


def test_idle_sub_worker_does_not_arm_cooldown(
    with_busy_sub_worker, force_smallest_roll
) -> None:
    """If the Sub-Worker is idle the cooldown timer must not be touched
    — otherwise the next genuine busy moment would be silenced."""
    svc = ThinkingTriggerService()

    svc._build_trigger_prompt("vtuber-1", _is_executing_idle)
    fired = svc._last_category_fire.get("vtuber-1", {})
    assert "sub_worker_working" not in fired
