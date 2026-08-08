"""Memory-engine visibility — effect-proving tests.

Every Synapse call is sync, runs on a worker thread, and serialises behind one
global lock. One call that never returns therefore ends every agent turn at
the 1800s timeout — the product is dead.

That happened for 27 hours in production, and `/health` answered "healthy"
throughout: the loop was idle, the database was up, requests were served.
Nothing was checking the part that was wedged. These tests are about that gap,
not about the wedge itself — a native call cannot be interrupted from Python,
so being able to SEE it is the whole remedy available.
"""

from __future__ import annotations

import threading
import time

from service.memory import inflight


def setup_function():
    with inflight._lock:
        inflight._inflight.clear()


def test_an_idle_engine_reports_nothing_in_flight():
    snap = inflight.status()
    assert snap["in_flight"] == 0
    assert snap["stuck"] is False
    assert snap["oldest_operation"] is None


def test_a_running_operation_is_visible_while_it_runs():
    seen = {}
    started, release = threading.Event(), threading.Event()

    def worker():
        with inflight.track("index"):
            started.set()
            release.wait(5)

    t = threading.Thread(target=worker)
    t.start()
    started.wait(5)
    seen = inflight.status()
    release.set()
    t.join(5)

    assert seen["in_flight"] == 1
    assert seen["oldest_operation"] == "index"
    assert inflight.status()["in_flight"] == 0, "the entry outlived the call"


def test_the_age_of_the_oldest_call_is_what_is_reported():
    """A count alone reads the same whether ten calls take 20ms each or one
    has been running since Tuesday. The age is the signal."""
    with inflight.track("search"):
        time.sleep(0.05)
        with inflight.track("index"):
            snap = inflight.status()

    assert snap["in_flight"] == 2
    assert snap["oldest_operation"] == "search", "reported the newest, not the oldest"
    assert snap["oldest_age_s"] >= 0.05


def test_a_long_running_call_crosses_the_line(monkeypatch):
    monkeypatch.setattr(inflight, "SLOW_OPERATION_S", 0.05)
    with inflight.track("index_batch"):
        time.sleep(0.08)
        snap = inflight.status()
        assert snap["stuck"] is True
        assert inflight.stuck_for() is not None


def test_a_normal_call_does_not_cry_wolf():
    """A cold-start backfill of the production vault (8,052 notes) was
    measured at ~630s. The threshold shipped at 300s and flagged that normal
    restart as stuck — an alarm that fires every time is one everyone learns
    to scroll past, and then the real one goes unread too."""
    with inflight.track("index_batch"):
        assert inflight.status()["stuck"] is False
        assert inflight.stuck_for() is None
    assert inflight.SLOW_OPERATION_S >= 630.0 * 2, (
        "no headroom over a backfill that is genuinely this slow"
    )


def test_a_failing_operation_still_clears():
    """An exception must not leave a phantom entry — it would report a wedge
    that ended, and the next real one would be indistinguishable."""
    try:
        with inflight.track("distill"):
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    assert inflight.status()["in_flight"] == 0


def test_concurrent_calls_are_counted_independently():
    """The engine queues callers behind one lock, so the in-flight count is
    how anyone outside learns the queue exists."""
    release = threading.Event()
    ready = threading.Barrier(6)

    def worker():
        with inflight.track("search"):
            ready.wait(5)
            release.wait(5)

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    ready.wait(5)
    snap = inflight.status()
    release.set()
    for t in threads:
        t.join(5)

    assert snap["in_flight"] == 5
    assert inflight.status()["in_flight"] == 0
