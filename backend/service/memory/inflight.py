"""In-flight registry for memory-engine work.

Every Synapse call is sync and runs on a worker thread. The engine serialises
them behind one global lock, so a single call that never returns takes the
whole memory subsystem with it — and, because agent turns retrieve memory,
every conversation with it.

That is not a hypothetical. A matmul wedged inside OpenBLAS held the lock for
27 hours in production. Thirteen threads queued behind it, every turn timed
out at 1800s, and ``/health`` answered ``healthy`` the entire time, because
nothing in the process was actually *broken* — the loop was idle, the DB was
up, requests were being served. The product was dead and every signal was
green.

This module is the missing signal. It costs a dict insert per call and makes
"memory work has been running for N seconds" answerable from outside.

It deliberately does NOT try to cancel anything: the wedge lives inside a
native call that Python cannot interrupt. Reporting is the whole job — a
process that says it is stuck can be restarted by something that can.
"""

from __future__ import annotations

import itertools
import threading
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterator, Optional, Tuple

# How long one memory operation may run before it is worth someone's
# attention.
#
# Measured, not guessed: a cold-start backfill of the production vault (8,052
# notes) takes ~630s. The first value here was 300s and it flagged that normal
# start as stuck — which is the failure mode this number must not have. An
# alarm that fires on every restart is one everybody learns to scroll past,
# and then the real one goes unread too.
#
# 1800s leaves ~3x headroom over the worst backfill actually observed, while
# the wedge this exists for ran for 27 HOURS. There is no overlap to split.
SLOW_OPERATION_S = 1800.0

_lock = threading.Lock()
_inflight: Dict[int, Tuple[str, float]] = {}
_seq = itertools.count()


@contextmanager
def track(operation: str) -> Iterator[None]:
    """Record that *operation* is running on a worker thread."""
    token = next(_seq)
    with _lock:
        _inflight[token] = (operation, time.monotonic())
    try:
        yield
    finally:
        with _lock:
            _inflight.pop(token, None)


def status() -> Dict[str, Any]:
    """Snapshot for ``/health``.

    ``oldest_age_s`` is the number that matters — a count alone looks the same
    whether ten operations are each taking 20ms or one has been running since
    Tuesday.
    """
    now = time.monotonic()
    with _lock:
        entries = list(_inflight.values())
    if not entries:
        return {"in_flight": 0, "oldest_age_s": 0.0, "oldest_operation": None,
                "stuck": False}
    operation, started = min(entries, key=lambda e: e[1])
    age = max(0.0, now - started)
    return {
        "in_flight": len(entries),
        "oldest_age_s": round(age, 1),
        "oldest_operation": operation,
        "stuck": age > SLOW_OPERATION_S,
    }


def stuck_for() -> Optional[float]:
    """Seconds the oldest operation has been running, if it is over the line."""
    snapshot = status()
    return snapshot["oldest_age_s"] if snapshot["stuck"] else None
