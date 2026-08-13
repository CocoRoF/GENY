"""A wedged memory side-effect must not take the agent down with it.

Production, 2026-08-10. Turns stopped answering, always with the same
signature: no log progress for ~300s, then a host-side guard abandoning
the turn. The await chain showed every one of them parked in the same
place —

    stage s18_memory → record_turn → stm_store._fire_hook
      → _on_record_turn → offload_blocking → <awaiting FutureIter>

— and the worker it was waiting on was parked inside the conversation
archiver's nested event loop, which never came back. The pool has
``max_workers=1`` on purpose, so from that moment every later turn
queued behind a thread that would never return. Only a restart cleared
it.

The side-effects here are best-effort by contract: a conversation that
does not get archived is a lost archive. An agent that stops answering
is a broken product. These tests pin that the trade is made the right
way round — the wait is bounded, a wedged worker is retired so the NEXT
turn is unaffected, and repeated wedges degrade to skipping rather than
leaking a thread per turn.
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest

from service.memory import sync_async_bridge as bridge


@pytest.fixture(autouse=True)
def _fresh_pool():
    """Each test gets its own worker and counters."""
    import concurrent.futures

    old_pool = bridge._SIDE_EFFECT_POOL
    old_retirements = bridge._retirements
    old_degraded = bridge._degraded
    bridge._SIDE_EFFECT_POOL = concurrent.futures.ThreadPoolExecutor(
        max_workers=1, thread_name_prefix="test-sideeffect"
    )
    bridge._retirements = 0
    bridge._degraded = False
    yield
    bridge._SIDE_EFFECT_POOL.shutdown(wait=False, cancel_futures=True)
    bridge._SIDE_EFFECT_POOL = old_pool
    bridge._retirements = old_retirements
    bridge._degraded = old_degraded


@pytest.mark.asyncio
async def test_a_wedged_side_effect_does_not_block_the_next_one():
    """The failure that mattered: turn N wedges, turn N+1 must still run.

    Before the fix the second call queued behind the first forever, and
    "forever" was the whole product.
    """
    release = threading.Event()

    def wedged():
        release.wait(30)          # never released during the test
        return "wedged-finished"

    def healthy():
        return "healthy-finished"

    t0 = time.monotonic()
    first = await bridge.offload_blocking(wedged, timeout=0.5)
    assert first is None, "a wedged side-effect must give up, not hang"

    second = await asyncio.wait_for(
        bridge.offload_blocking(healthy, timeout=5.0), timeout=10.0
    )
    assert second == "healthy-finished", (
        "the next side-effect queued behind the wedged worker — this is "
        "exactly the production stall"
    )
    assert time.monotonic() - t0 < 8.0
    release.set()


@pytest.mark.asyncio
async def test_healthy_side_effects_still_return_their_value():
    """The bound must not change the normal path."""
    calls = []

    def work():
        calls.append(1)
        return 42

    assert await bridge.offload_blocking(work) == 42
    assert calls == [1]
    assert bridge.side_effect_status()["retirements"] == 0


@pytest.mark.asyncio
async def test_serialisation_survives_the_change():
    """``max_workers=1`` exists to serialise archiver writes — the retire
    path must not quietly turn that into concurrency."""
    concurrent_peak = 0
    live = 0
    guard = threading.Lock()

    def work():
        nonlocal concurrent_peak, live
        with guard:
            live += 1
            concurrent_peak = max(concurrent_peak, live)
        time.sleep(0.05)
        with guard:
            live -= 1
        return True

    await asyncio.gather(*(bridge.offload_blocking(work) for _ in range(6)))
    assert concurrent_peak == 1, (
        f"side-effects ran {concurrent_peak}-way concurrently; the archiver "
        "write path is not written for that"
    )


@pytest.mark.asyncio
async def test_repeated_wedges_degrade_instead_of_leaking_threads():
    """Replacing the pool is a repair, not a strategy.

    If every worker wedges, replacing one per turn would leak a thread
    per turn. Past the cap the bridge stops trying and says so.
    """
    release = threading.Event()

    def wedged():
        release.wait(30)
        return None

    for _ in range(bridge._MAX_RETIREMENTS + 1):
        assert await bridge.offload_blocking(wedged, timeout=0.2) is None

    status = bridge.side_effect_status()
    assert status["degraded"] is True
    assert status["retirements"] == bridge._MAX_RETIREMENTS + 1

    # Degraded means the next call returns immediately — no new worker,
    # no wait at all.
    t0 = time.monotonic()
    assert await bridge.offload_blocking(lambda: "x") is None
    assert time.monotonic() - t0 < 0.2
    release.set()


@pytest.mark.asyncio
async def test_a_swept_side_effect_does_not_abort_the_turn():
    """Retiring a pool cancels its QUEUED futures (`cancel_futures=True`).

    A side-effect queued behind the wedged one gets swept — and that
    CancelledError used to escape `offload_blocking` into the turn,
    aborting a whole answer over a lost best-effort archive. Swept must
    read as skipped (None), exactly like a timeout.
    """
    release = threading.Event()

    def wedged():
        release.wait(30)

    def queued_victim():
        return "ran"

    # Occupy the single worker, queue a second job behind it, then let
    # the first one time out — the retire sweeps the queued job.
    first = asyncio.create_task(bridge.offload_blocking(wedged, timeout=0.5))
    await asyncio.sleep(0.1)
    second = asyncio.create_task(bridge.offload_blocking(queued_victim, timeout=10.0))
    await asyncio.sleep(0.1)

    assert await first is None
    result = await asyncio.wait_for(second, timeout=10.0)
    assert result is None, (
        "the swept side-effect neither ran nor was skipped cleanly — "
        f"got {result!r}"
    )
    release.set()


@pytest.mark.asyncio
async def test_the_callers_own_cancellation_still_propagates():
    """Only the sweep is a skip. If the TURN is cancelled, the await
    must raise — swallowing it would keep dead turns alive."""
    release = threading.Event()

    def slow():
        release.wait(30)

    task = asyncio.create_task(bridge.offload_blocking(slow, timeout=60.0))
    await asyncio.sleep(0.1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    release.set()


@pytest.mark.asyncio
async def test_status_is_visible_before_anything_goes_wrong():
    """/health reads this; it must answer on a healthy process too."""
    status = bridge.side_effect_status()
    assert status["degraded"] is False
    assert status["retirements"] == 0
    assert status["timeout_s"] > 0
