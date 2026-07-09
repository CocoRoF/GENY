"""Long-idle session eviction — reclaim RAM without losing the session.

Marking a session IDLE keeps its whole AgentSession (pipeline, MemoryProvider,
embedding client) resident, and ``_local_agents`` is unbounded, so idle
sessions accumulate in memory until explicit delete / restart. The idle
monitor now evicts a session inactive past ``_idle_evict_seconds``: it tears
down resources but preserves the store record + on-disk memory, so the next
access rehydrates it transparently.

These tests pin the gating (only IDLE, non-always-on, not mid-turn, past the
threshold) and the teardown (removed from the registry, ``cleanup(flush=False)``,
STOPPED persisted), plus the safety re-check under the rehydrate lock.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from service.executor.agent_session_manager import AgentSessionManager
from service.sessions.models import SessionStatus


class _FakeAgent:
    def __init__(
        self,
        session_id: str,
        *,
        status: SessionStatus = SessionStatus.IDLE,
        idle_seconds: float = 10_000.0,
        always_on: bool = False,
        executing: bool = False,
    ) -> None:
        self._session_id = session_id
        self._status = status
        self._is_always_on = always_on
        self._is_executing = executing
        self._execution_start_time = datetime.now() - timedelta(seconds=idle_seconds)
        self._created_at = self._execution_start_time
        self.cleanup_calls: list[bool] = []  # records flush= per call

    @property
    def status(self) -> SessionStatus:
        return self._status

    def mark_idle(self) -> bool:
        if self._status == SessionStatus.RUNNING and not self._is_executing and not self._is_always_on:
            self._status = SessionStatus.IDLE
            return True
        return False

    async def cleanup(self, *, flush: bool = True) -> None:
        self.cleanup_calls.append(flush)
        self._status = SessionStatus.STOPPED

    def get_session_info(self):
        return _FakeInfo({"session_id": self._session_id, "status": self._status.value})


class _FakeInfo:
    """Mimics SessionInfo's ``.model_dump(mode=...)`` surface."""

    def __init__(self, data: dict) -> None:
        self._data = data

    def model_dump(self, mode: str = "json") -> dict:
        return self._data


class _FakeStore:
    def __init__(self) -> None:
        self.registered: dict = {}

    def register(self, sid, data) -> None:
        self.registered[sid] = data


class _FakeBus:
    def __init__(self) -> None:
        self.events: list = []

    async def emit(self, event, sid, **kw) -> None:
        self.events.append((event, sid, kw))


def _skeleton(evict_seconds: float = 1800.0) -> AgentSessionManager:
    mgr = object.__new__(AgentSessionManager)
    mgr._local_agents = {}
    mgr._rehydrate_locks = {}
    mgr._store = _FakeStore()
    mgr._lifecycle_bus = _FakeBus()
    mgr._idle_evict_seconds = evict_seconds
    return mgr


# ── candidate gating ─────────────────────────────────────────────────

def test_long_idle_session_is_a_candidate():
    mgr = _skeleton()
    agent = _FakeAgent("s1", idle_seconds=2000)
    assert mgr._is_evict_candidate(agent, datetime.now()) is True


def test_fresh_idle_session_is_not_a_candidate():
    mgr = _skeleton()
    agent = _FakeAgent("s1", idle_seconds=60)  # only 1 min idle
    assert mgr._is_evict_candidate(agent, datetime.now()) is False


def test_always_on_session_is_never_a_candidate():
    mgr = _skeleton()
    agent = _FakeAgent("s1", idle_seconds=99_999, always_on=True)
    assert mgr._is_evict_candidate(agent, datetime.now()) is False


def test_busy_session_is_not_a_candidate():
    mgr = _skeleton()
    agent = _FakeAgent("s1", idle_seconds=99_999, executing=True)
    assert mgr._is_evict_candidate(agent, datetime.now()) is False


def test_running_session_is_not_a_candidate():
    mgr = _skeleton()
    agent = _FakeAgent("s1", idle_seconds=99_999, status=SessionStatus.RUNNING)
    assert mgr._is_evict_candidate(agent, datetime.now()) is False


# ── eviction teardown ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_evict_releases_and_preserves_record():
    mgr = _skeleton()
    agent = _FakeAgent("s1", idle_seconds=2000)
    mgr._local_agents["s1"] = agent

    ok = await mgr._evict_idle_session("s1", agent)

    assert ok is True
    assert "s1" not in mgr._local_agents          # removed from registry
    assert agent.cleanup_calls == [False]          # cleanup(flush=False) — fast teardown
    assert "s1" in mgr._store.registered           # store record preserved (STOPPED)
    assert mgr._store.registered["s1"]["status"] == SessionStatus.STOPPED.value
    assert mgr._rehydrate_locks.get("s1") is None  # lock cleaned up
    assert mgr._lifecycle_bus.events and mgr._lifecycle_bus.events[0][2].get("reason") == "evicted"


@pytest.mark.asyncio
async def test_evict_reverifies_under_lock_and_bails_if_agent_swapped():
    """A concurrent rebuild replaced the agent → the under-lock re-check must
    refuse to tear down the wrong (fresh) agent."""
    mgr = _skeleton()
    stale = _FakeAgent("s1", idle_seconds=2000)
    fresh = _FakeAgent("s1", idle_seconds=2000)
    mgr._local_agents["s1"] = fresh  # registry now holds a different instance

    ok = await mgr._evict_idle_session("s1", stale)

    assert ok is False
    assert mgr._local_agents["s1"] is fresh   # untouched
    assert stale.cleanup_calls == []
    assert fresh.cleanup_calls == []


@pytest.mark.asyncio
async def test_evict_bails_if_turn_started_before_lock():
    """Status flipped to RUNNING (a turn began) after the cheap pre-filter →
    the under-lock re-check refuses eviction."""
    mgr = _skeleton()
    agent = _FakeAgent("s1", idle_seconds=2000)
    mgr._local_agents["s1"] = agent
    agent._status = SessionStatus.RUNNING  # a turn started

    ok = await mgr._evict_idle_session("s1", agent)

    assert ok is False
    assert "s1" in mgr._local_agents
    assert agent.cleanup_calls == []


# ── scan integration ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_scan_evicts_only_the_long_idle_session():
    mgr = _skeleton()
    long_idle = _FakeAgent("old", idle_seconds=5000)
    fresh_idle = _FakeAgent("new", idle_seconds=30)
    # RUNNING with RECENT activity → transitions to IDLE this scan but is NOT
    # a (fresh) eviction candidate.
    running = _FakeAgent("run", idle_seconds=30, status=SessionStatus.RUNNING)
    mgr._local_agents.update({"old": long_idle, "new": fresh_idle, "run": running})

    await mgr._scan_for_idle_sessions()

    assert "old" not in mgr._local_agents      # evicted
    assert long_idle.cleanup_calls == [False]
    assert "new" in mgr._local_agents          # too fresh — kept
    assert "run" in mgr._local_agents          # RUNNING → IDLE, but fresh → kept
    assert running.status == SessionStatus.IDLE


@pytest.mark.asyncio
async def test_scan_never_evicts_when_disabled():
    mgr = _skeleton(evict_seconds=0.0)
    agent = _FakeAgent("s1", idle_seconds=99_999)
    mgr._local_agents["s1"] = agent

    await mgr._scan_for_idle_sessions()

    assert "s1" in mgr._local_agents           # eviction disabled
    assert agent.cleanup_calls == []
