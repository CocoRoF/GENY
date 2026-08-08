"""/health and /health/ready — effect-proving tests.

Two independent defects lived in the old single endpoint, and each one is
pinned here:

  1. It reported ``"status": "healthy"`` as a hardcoded literal while its own
     database probe said "error" — so the response contradicted its own body.
  2. It called the SYNCHRONOUS ``db_manager.health_check()`` inline. On a slow
     or hung database that blocks the event loop for the whole probe, which
     makes the liveness check time out, which makes autoheal restart a backend
     whose only problem was a slow database. The probe caused the outage it
     existed to detect.
"""

from __future__ import annotations

import asyncio
import time

import pytest

import main


class _StubDBManager:
    def __init__(self, *, healthy=True, delay=0.0, raises=False):
        self._healthy = healthy
        self._delay = delay
        self._raises = raises

    def health_check(self):
        if self._delay:
            time.sleep(self._delay)      # deliberately SYNCHRONOUS
        if self._raises:
            raise RuntimeError("db down")
        return self._healthy


class _StubDB:
    def __init__(self, manager):
        self.db_manager = manager


@pytest.fixture
def _no_db(monkeypatch):
    monkeypatch.setattr(main.app.state, "app_db", None, raising=False)


def _set_db(monkeypatch, **kwargs):
    monkeypatch.setattr(
        main.app.state, "app_db", _StubDB(_StubDBManager(**kwargs)), raising=False
    )


# ── the response must not contradict itself ────────────────────────────────

@pytest.mark.asyncio
async def test_status_reports_degraded_when_database_is_unhealthy(monkeypatch):
    _set_db(monkeypatch, healthy=False)
    body = await main.health_check()
    assert body["database"] == "unhealthy"
    assert body["status"] == "degraded", "status must follow the probe it ran"


@pytest.mark.asyncio
async def test_status_reports_degraded_when_database_probe_raises(monkeypatch):
    _set_db(monkeypatch, raises=True)
    body = await main.health_check()
    assert body["database"] == "error"
    assert body["status"] == "degraded"


@pytest.mark.asyncio
async def test_status_is_healthy_when_database_is_fine(monkeypatch):
    _set_db(monkeypatch, healthy=True)
    body = await main.health_check()
    assert body["database"] == "healthy"
    assert body["status"] == "healthy"


@pytest.mark.asyncio
async def test_no_database_configured_is_not_degraded(_no_db):
    body = await main.health_check()
    assert body["database"] == "not_configured"
    assert body["status"] == "healthy"


# ── liveness must stay off the loop, and stay live ─────────────────────────

@pytest.mark.asyncio
async def test_slow_database_does_not_block_the_event_loop(monkeypatch):
    """The measured property: while /health waits on a slow DB probe, other
    coroutines still get scheduled. Inline (the old code) this counter would
    be frozen at 0 for the whole sleep."""
    _set_db(monkeypatch, healthy=True, delay=0.4)

    ticks = 0

    async def _ticker():
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0.01)

    ticker = asyncio.create_task(_ticker())
    try:
        await main.health_check()
    finally:
        ticker.cancel()

    assert ticks > 5, f"event loop was starved during the probe (ticks={ticks})"


@pytest.mark.asyncio
async def test_hung_database_is_bounded_and_reported_not_hung(monkeypatch):
    """A probe that never returns must not make liveness hang forever."""
    _set_db(monkeypatch, healthy=True, delay=30.0)

    started = time.monotonic()
    body = await asyncio.wait_for(main.health_check(), timeout=10.0)
    elapsed = time.monotonic() - started

    assert body["database"] == "timeout"
    assert elapsed < 6.0, f"probe was not bounded (took {elapsed:.1f}s)"


@pytest.mark.asyncio
async def test_liveness_stays_200_while_the_database_is_down(monkeypatch):
    """Liveness answers only what a restart can fix. Failing it on a database
    outage would add a restart loop on top of the outage."""
    _set_db(monkeypatch, raises=True)
    body = await main.health_check()
    assert body["live"] is True


# ── readiness IS allowed to fail ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_readiness_503s_when_the_database_is_down(monkeypatch):
    from fastapi import Response

    _set_db(monkeypatch, raises=True)
    response = Response()
    body = await main.readiness_check(response)
    assert body["ready"] is False
    assert response.status_code == 503


@pytest.mark.asyncio
async def test_readiness_200s_when_the_database_is_fine(monkeypatch):
    from fastapi import Response

    _set_db(monkeypatch, healthy=True)
    response = Response()
    body = await main.readiness_check(response)
    assert body["ready"] is True
    assert response.status_code == 200


# ── the signal that was missing ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_health_reports_the_memory_engine(monkeypatch):
    """`/health` is what a human and autoheal both read. For 27 hours it said
    "healthy" while every agent turn timed out on a wedged memory lock,
    because nothing in the response covered memory at all."""
    _set_db(monkeypatch, healthy=True)
    body = await main.health_check()

    assert "memory" in body, "memory is invisible to the only signal anyone reads"
    assert set(body["memory"]) >= {"in_flight", "oldest_age_s", "stuck"}


@pytest.mark.asyncio
async def test_a_stalled_memory_engine_makes_health_say_degraded(monkeypatch):
    from service.memory import inflight

    _set_db(monkeypatch, healthy=True)
    monkeypatch.setattr(inflight, "SLOW_OPERATION_S", 0.0)
    with inflight.track("index"):
        body = await main.health_check()

    assert body["memory"]["stuck"] is True
    assert body["status"] == "degraded"
    # Still LIVE: the loop serves fine, and a first re-index of a large vault
    # legitimately runs long. Failing liveness here would restart it halfway.
    assert body["live"] is True


@pytest.mark.asyncio
async def test_a_healthy_memory_engine_does_not_degrade_health(monkeypatch):
    _set_db(monkeypatch, healthy=True)
    body = await main.health_check()

    assert body["memory"]["stuck"] is False
    assert body["status"] == "healthy"


@pytest.mark.asyncio
async def test_task_dump_shows_where_a_pending_coroutine_is_parked():
    """The failure this exists for looks healthy from every other angle: the
    loop is running, threads are asleep, and one turn awaits something that
    never arrives. Only the task's own stack names the line."""
    import asyncio

    from fastapi import Response

    gate = asyncio.Event()

    async def _parked():
        await gate.wait()

    task = asyncio.create_task(_parked(), name="parked-turn")
    await asyncio.sleep(0)  # let it reach the await

    body = await main.health_tasks(Response())
    gate.set()
    await task

    parked = [t for t in body["tasks"] if t["name"] == "parked-turn"]
    assert parked, "a pending task was invisible in the dump"
    assert parked[0]["done"] is False
    assert any("_parked" in frame for frame in parked[0]["stack"]), (
        "the dump named the task but not where it is waiting"
    )


@pytest.mark.asyncio
async def test_the_dump_is_bounded():
    """A diagnostic that returns thousands of stacks is one nobody can read,
    and hitting it during an incident should not itself be the problem."""
    from fastapi import Response

    body = await main.health_tasks(Response(), limit=1)
    assert body["count"] <= 1
