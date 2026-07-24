"""Regression pin for the 2026-07-25 memory-hygiene deadlock.

The cycle: the single-worker memory side-effect pool runs an archiver, which
drives ``notes.write`` on the event loop via ``run_coro_sync`` (worker BLOCKED
until the coroutine finishes) → ``notes.write`` awaits the
``after_note_update`` hook → the hook awaited ``offload_blocking(...)`` which
queues onto that SAME single worker → circular wait, permanent hang (s18 stuck
720s in prod, every later turn timing out behind it).

Fix under test: the hook schedules hygiene work as a DETACHED task on the
default thread pool (``asyncio.to_thread``), never awaiting anything that
needs the side-effect worker.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import threading

import pytest

from service.memory.sync_async_bridge import offload_blocking, run_coro_sync


def _engine_call_factory(called: threading.Event):
    def engine_call(key, top_k=3):
        called.set()
        return []
    return engine_call


@pytest.mark.asyncio
async def test_fixed_hook_pattern_survives_worker_driven_write():
    """EFFECT PROOF: with the fixed pattern (fire-and-forget submit to a
    DEDICATED pool), a notes-write driven FROM the side-effect worker
    completes instead of deadlocking — and the hygiene check still runs,
    even though the hook's loop (run_coro_sync's fresh loop) dies right
    after the write."""
    from service.executor.agent_session import _hygiene_pool

    called = threading.Event()
    engine_call = _engine_call_factory(called)

    async def fixed_hook():
        # The fixed wiring: loop-independent submit to the dedicated pool.
        _hygiene_pool().submit(engine_call, "k")

    async def notes_write_like():
        await fixed_hook()
        return "written"

    def archiver_sideeffect():
        # Worker thread blocks here until the loop finishes the coroutine —
        # exactly what the conversation archiver does.
        return run_coro_sync(notes_write_like())

    result = await asyncio.wait_for(
        offload_blocking(archiver_sideeffect), timeout=8)
    assert result == "written"
    # The submitted hygiene check still executes on its own pool, despite
    # the short-lived loop being gone.
    assert called.wait(timeout=3), "hygiene check must still run, detached"


@pytest.mark.asyncio
async def test_old_awaiting_pattern_deadlocks_negative_control():
    """Negative control documenting WHY the fix exists: awaiting work queued
    on the same single-worker pool from inside the hook is a circular wait.
    Reproduced on an ISOLATED single-worker pool (never the module-global one,
    which a real deadlock would poison for the whole test session)."""
    pool = concurrent.futures.ThreadPoolExecutor(
        max_workers=1, thread_name_prefix="deadlock-repro")
    loop = asyncio.get_running_loop()

    async def bad_hook():
        # OLD wiring: await work queued on the SAME single worker that is
        # currently running this very coroutine's loop (run_coro_sync spins
        # a fresh loop INSIDE the worker thread) → the loop awaits a pool
        # slot only its own thread can free — circular wait.
        await asyncio.get_running_loop().run_in_executor(
            pool, lambda: "hygiene")

    async def notes_write_like():
        await bad_hook()
        return "written"

    def archiver_sideeffect():
        return run_coro_sync(notes_write_like())

    fut = loop.run_in_executor(pool, archiver_sideeffect)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.shield(fut), timeout=1.5)
    pool.shutdown(wait=False, cancel_futures=True)


def test_contradiction_check_never_uses_side_effect_pool_or_tasks():
    """Source-level pin: the hygiene scheduler must reference neither
    offload_blocking (single-worker pool → circular wait) nor asyncio task
    creation (dies with run_coro_sync's short-lived loop) — only the
    dedicated hygiene pool's fire-and-forget submit."""
    import inspect
    from service.executor.agent_session import AgentSession

    src = inspect.getsource(AgentSession._schedule_contradiction_check)
    assert "offload_blocking" not in src
    assert "create_task" not in src
    assert "_hygiene_pool" in src and ".submit(" in src
