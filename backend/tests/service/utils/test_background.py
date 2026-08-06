"""spawn_background — effect-proving tests.

Doctrine: each test asserts the MEASURED property the helper exists to
guarantee, not merely that it ran. Every property here corresponds to a defect
that reached production through a bare ``asyncio.create_task``.
"""

from __future__ import annotations

import asyncio
import gc

import pytest

from service.utils import background as bg


@pytest.fixture(autouse=True)
def _clean_registry():
    bg._anonymous.clear()
    bg._keyed.clear()
    yield
    bg._anonymous.clear()
    bg._keyed.clear()


# ── strong reference (defect: task collected mid-run) ───────────────────────

@pytest.mark.asyncio
async def test_task_survives_aggressive_gc_while_suspended():
    """The reference is real: the task completes even under forced collection.

    This is the property a bare create_task does NOT have — the loop keeps only
    a weak reference, so a suspended task with no other referrer is collectable.
    """
    done = asyncio.Event()

    async def _work():
        await asyncio.sleep(0.05)   # suspended — the collectable window
        done.set()

    bg.spawn_background(_work(), name="test.survives")
    for _ in range(3):
        gc.collect()
        await asyncio.sleep(0.01)

    await asyncio.wait_for(done.wait(), timeout=1.0)


@pytest.mark.asyncio
async def test_reference_is_released_after_completion():
    """Held until done, then dropped — a registry that only grows is a leak."""
    async def _work():
        return None

    task = bg.spawn_background(_work(), name="test.released")
    assert bg.background_task_count()["anonymous"] == 1
    await task
    await asyncio.sleep(0)          # let the done-callback run
    assert bg.background_task_count()["anonymous"] == 0


# ── audible failure (defect: exception swallowed forever) ───────────────────

@pytest.mark.asyncio
async def test_failure_is_logged_not_swallowed(caplog):
    async def _boom():
        raise ValueError("kaboom")

    task = bg.spawn_background(_boom(), name="test.boom")
    with pytest.raises(ValueError):
        await task
    await asyncio.sleep(0)

    assert any(
        "test.boom" in r.message and "kaboom" in r.message
        for r in caplog.records
        if r.levelname == "ERROR"
    ), f"failure was not logged at ERROR: {[r.message for r in caplog.records]}"


@pytest.mark.asyncio
async def test_cancellation_is_not_reported_as_failure(caplog):
    async def _work():
        await asyncio.sleep(10)

    task = bg.spawn_background(_work(), name="test.cancelled")
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0)

    assert not [r for r in caplog.records if r.levelname == "ERROR"]


# ── bounded fan-out (defect: one task per request) ──────────────────────────

@pytest.mark.asyncio
async def test_key_collapses_a_burst_onto_one_task():
    """The _prune_tasks case: a burst of triggers must not become a burst of
    tasks. Fifty schedules of the same key run the body exactly once."""
    runs = 0

    async def _sweep():
        nonlocal runs
        runs += 1
        await asyncio.sleep(0.05)

    tasks = [
        bg.spawn_background(_sweep(), name="test.sweep", key="sweep")
        for _ in range(50)
    ]
    assert len({id(t) for t in tasks}) == 1, "burst created more than one task"
    await tasks[0]
    assert runs == 1


@pytest.mark.asyncio
async def test_key_is_reusable_once_the_previous_run_finished():
    """Dedup must not become a permanent lockout."""
    runs = 0

    async def _sweep():
        nonlocal runs
        runs += 1

    await bg.spawn_background(_sweep(), name="test.again", key="again")
    await asyncio.sleep(0)
    await bg.spawn_background(_sweep(), name="test.again", key="again")
    assert runs == 2


# ── caller safety (a detached job must never break its caller) ──────────────

def test_no_running_loop_returns_none_instead_of_raising():
    async def _work():
        return None

    coro = _work()
    assert bg.spawn_background(coro, name="test.noloop") is None
