"""DELETE drains an in-flight turn before teardown (no delete-mid-turn).

``cleanup()`` tears the pipeline down (aclose → cancels HITL futures, closes
event taps, disconnects MCP). Running that UNDER a live turn corrupts the turn
and leaks its pipeline/MCP/HITL resources. ``delete_session`` now quiesces the
session first via ``close_session_execution``:

  * blocks NEW turns (``_closing_sessions`` gate, checked in the admission
    critical section → ``SessionClosingError``),
  * waits for the in-flight turn to finish on its own, and
  * gracefully cancels it past a bounded window (so the turn's own finally
    runs — never a mid-turn pipeline teardown).

These tests pin the drain helper's behaviour and that delete calls it BEFORE
cleanup.
"""

from __future__ import annotations

import asyncio

import pytest

from service.execution import agent_executor as ae


@pytest.fixture(autouse=True)
def _clean_executor_state():
    """Keep the module-global execution tables clean around each test."""
    yield
    for sid in ("drain-none", "drain-natural", "drain-stuck"):
        ae._active_executions.pop(sid, None)
        ae._closing_sessions.discard(sid)
        ae._exec_locks.pop(sid, None)


# ── close_session_execution ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_close_no_inflight_turn_returns_true_and_sets_gate():
    ok = await ae.close_session_execution("drain-none")
    assert ok is True
    assert "drain-none" in ae._closing_sessions  # new turns now blocked


@pytest.mark.asyncio
async def test_close_waits_for_natural_completion():
    async def turn():
        await asyncio.sleep(0.1)
        return "done"

    task = asyncio.create_task(turn())
    ae._active_executions["drain-natural"] = {
        "done": False, "task": task, "exec_id": "n1",
    }

    ok = await ae.close_session_execution("drain-natural", drain_timeout=2.0)

    assert ok is True
    assert task.done() and not task.cancelled()  # finished on its own, not cancelled


@pytest.mark.asyncio
async def test_close_gracefully_cancels_a_stuck_turn():
    started = asyncio.Event()

    async def stuck():
        started.set()
        try:
            await asyncio.sleep(100)  # never finishes within the drain window
        finally:
            # Mirror execute_command's finally: a cancelled turn clears its
            # own holder (cleanup_execution) as it unwinds.
            ae.cleanup_execution("drain-stuck", exec_id="s1")

    task = asyncio.create_task(stuck())
    ae._active_executions["drain-stuck"] = {
        "done": False, "task": task, "exec_id": "s1",
    }
    await started.wait()

    ok = await ae.close_session_execution(
        "drain-stuck", drain_timeout=0.15, cancel_timeout=2.0
    )

    assert ok is True
    assert task.cancelled()  # the turn was cancelled, its finally could run


@pytest.mark.asyncio
async def test_gate_blocks_new_admissions_then_clears():
    ae.mark_session_closing("drain-none")
    assert "drain-none" in ae._closing_sessions
    ae.clear_session_closing("drain-none")
    assert "drain-none" not in ae._closing_sessions


# ── delete_session ordering (drain BEFORE cleanup) ───────────────────

@pytest.mark.asyncio
async def test_delete_drains_before_cleanup(monkeypatch):
    """delete_session must call close_session_execution BEFORE agent.cleanup()."""
    from service.executor.agent_session_manager import AgentSessionManager

    order: list[str] = []

    class _FakeAgent:
        storage_path = None

        async def cleanup(self, *, flush: bool = True):
            order.append("cleanup")

    class _FakeStore:
        def soft_delete(self, sid):
            order.append("soft_delete")

    class _FakeBus:
        async def emit(self, *a, **k):
            pass

    class _FakePersona:
        def reset(self, sid):
            pass

    mgr = object.__new__(AgentSessionManager)
    mgr._local_agents = {"s1": _FakeAgent()}
    mgr._store = _FakeStore()
    mgr._lifecycle_bus = _FakeBus()
    mgr._persona_provider = _FakePersona()

    async def _fake_close(session_id, **kw):
        order.append("drain")
        return True

    monkeypatch.setattr(ae, "close_session_execution", _fake_close)

    ok = await mgr.delete_session("s1")

    assert ok is True
    # Drain happened, and strictly BEFORE cleanup.
    assert "drain" in order and "cleanup" in order
    assert order.index("drain") < order.index("cleanup")
    assert "s1" not in mgr._local_agents
