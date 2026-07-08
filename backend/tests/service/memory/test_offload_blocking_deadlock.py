"""Regression: ``offload_blocking`` must break the event-loop deadlock that
froze the backend in prod (three separate hangs).

The deadlock
------------
Several host-side memory SIDE-EFFECTS are SYNC chains that bridge to async
provider writes via ``run_coro_sync``:

  * the ``after_record_turn`` archive hook (conversation / DM archiving),
  * ``PersistingLLMSummaryCompactor.compact`` → ``record_compaction``,
  * end-of-session ``auto_flush`` → ``compact_now``.

When one of these runs *inline on the main event loop*, ``run_coro_sync``
takes its in-loop branch: it spins a worker thread with a fresh loop and
**blocks the main loop thread on ``.result()``**. That worker then does a
provider ``notes.write`` which acquires a process-wide ``LoopAgnosticLock``
(``threading.Lock``-backed). If that lock is momentarily held by ANOTHER
coroutine on the now-frozen main loop — one that yielded mid-critical
section (e.g. ``vector_store.index`` awaiting an embedding while holding the
lock) — the holder can never resume to release it. Worker waits on the
lock forever; the loop waits on the worker forever. Permanent deadlock.

The fix is not to run these side-effects on the loop at all:
``offload_blocking`` runs them on a dedicated single-worker thread, so
``run_coro_sync`` sees no running loop, uses ``asyncio.run`` on the worker,
and the main loop stays free — the lock holder resumes and releases.

These tests reproduce the exact ingredients (real ``LoopAgnosticLock`` +
real ``run_coro_sync``) and assert ``offload_blocking`` does not deadlock.
The old inline pattern would hang here (the loop can't even fire the
``wait_for`` timeout, since it's frozen), which is precisely why it took a
faulthandler stack to diagnose in prod.
"""

from __future__ import annotations

import asyncio
import threading

import pytest

from geny_executor.memory._locks import LoopAgnosticLock

from service.memory.sync_async_bridge import offload_blocking, run_coro_sync


@pytest.mark.asyncio
async def test_offload_blocking_does_not_deadlock_on_cross_loop_lock() -> None:
    """A main-loop coroutine holds a LoopAgnosticLock across an await while a
    ``run_coro_sync``-using side-effect (needing the same lock) is offloaded.

    This is the prod hang, reproduced. With the old inline call it deadlocks;
    ``offload_blocking`` keeps the loop free so the holder releases and the
    worker proceeds.
    """
    lock = LoopAgnosticLock()
    order: list[str] = []

    async def _provider_write() -> str:
        # Stands in for notes.write / vector index: acquires the store lock
        # inside the worker's fresh loop.
        async with lock:
            order.append("worker-acquired")
            return "wrote"

    def _sync_archiver() -> str:
        # Stands in for the archiver: sync code bridging to async via the
        # in-loop run_coro_sync path.
        return run_coro_sync(_provider_write())

    async def _holder_on_main_loop() -> None:
        # A main-loop coroutine that holds the SAME lock across an await —
        # the "vector_store.index awaiting an embedding" case.
        async with lock:
            order.append("holder-acquired")
            await asyncio.sleep(0.3)  # yields to the loop, still holding
            order.append("holder-releasing")

    holder = asyncio.create_task(_holder_on_main_loop())
    await asyncio.sleep(0.05)  # let the holder grab the lock first

    # Would hang forever under the old inline pattern. offload_blocking runs
    # the archiver off the loop, so a 5s wait_for is ample headroom.
    result = await asyncio.wait_for(offload_blocking(_sync_archiver), timeout=5.0)

    assert result == "wrote"
    await holder
    # Proves the loop stayed live: the holder held across its await and
    # released BEFORE the offloaded worker could acquire.
    assert order == ["holder-acquired", "holder-releasing", "worker-acquired"]


@pytest.mark.asyncio
async def test_offload_blocking_runs_off_the_calling_loop_thread() -> None:
    """The callable must execute on a different thread than the caller, and
    ``run_coro_sync`` inside it must take the no-running-loop branch (so it
    never blocks the caller's loop)."""
    caller_thread = threading.get_ident()
    observed: dict[str, object] = {}

    def _side_effect() -> str:
        observed["thread"] = threading.get_ident()
        try:
            asyncio.get_running_loop()
            observed["in_loop"] = True
        except RuntimeError:
            observed["in_loop"] = False
        # run_coro_sync here must use asyncio.run (no running loop on the pool
        # worker), proving the loop-blocking in-loop branch is not taken.
        return run_coro_sync(_trivial())

    async def _trivial() -> str:
        return "ok"

    result = await offload_blocking(_side_effect)

    assert result == "ok"
    assert observed["thread"] != caller_thread
    assert observed["in_loop"] is False


@pytest.mark.asyncio
async def test_offload_blocking_serialises_side_effects() -> None:
    """The dedicated pool is single-worker, preserving the "one archiver /
    compaction writer at a time" invariant the sync chains were written under
    (previously enforced implicitly by loop-blocking). Overlapping offloads
    must not interleave."""
    active = 0
    max_active = 0
    guard = threading.Lock()

    def _side_effect(tag: str) -> str:
        nonlocal active, max_active
        with guard:
            active += 1
            max_active = max(max_active, active)
        # Busy a touch so overlap would be observable if it were allowed.
        end = threading.Event()
        end.wait(0.02)
        with guard:
            active -= 1
        return tag

    results = await asyncio.gather(
        *(offload_blocking(lambda t=f"t{i}": _side_effect(t)) for i in range(5))
    )

    assert sorted(results) == ["t0", "t1", "t2", "t3", "t4"]
    assert max_active == 1  # never two at once
