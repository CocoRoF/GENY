"""Detached background work that cannot vanish, and cannot fail in silence.

WHY THIS MODULE EXISTS

``asyncio.create_task(coro())`` as a bare statement looks like fire-and-forget
but carries three defects, all of which we have shipped:

1. **The task can be garbage-collected mid-run.** The event loop keeps only a
   WEAK reference to a task. While the task is suspended at an ``await`` with
   nothing else holding it, it is collectable — the work simply stops, with no
   error anywhere. CPython's own docs say to save a reference for this reason.

2. **A failure is silent.** Nobody awaits the task, so its exception sits
   unretrieved inside the task object. It surfaces — if ever — as a bare
   ``Task exception was never retrieved`` at some unrelated later moment, with
   no request context attached. A background job can be dead for weeks.

3. **Fan-out is unbounded.** A per-request ``create_task`` starts one task per
   request. A prune sweep meant to run occasionally instead ran per uploaded
   frame; the leak was invisible precisely because of defects 1 and 2.

``spawn_background`` fixes all three at the call site: it holds a strong
reference until completion, logs any failure against a name you chose, and —
with ``key`` — collapses repeat scheduling onto the one sweep already running.

Use it for every detached task. If you want the result, ``await`` instead.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Dict, Optional, Set

logger = logging.getLogger(__name__)

#: Strong references to in-flight detached tasks (defect 1). Entries are
#: dropped by the done-callback, so this is a live set, not an accumulator.
_anonymous: Set["asyncio.Task[Any]"] = set()

#: Strong references for keyed tasks, which additionally give us "at most one
#: in flight per key" (defect 3).
_keyed: Dict[str, "asyncio.Task[Any]"] = {}


def _on_done(task: "asyncio.Task[Any]", name: str, key: Optional[str]) -> None:
    """Release the reference and make any failure audible."""
    _anonymous.discard(task)
    if key is not None and _keyed.get(key) is task:
        _keyed.pop(key, None)

    if task.cancelled():
        logger.debug("background task cancelled: %s", name)
        return
    exc = task.exception()          # also marks it retrieved
    if exc is not None:
        logger.error(
            "background task failed: %s — %s: %s",
            name, type(exc).__name__, exc,
            exc_info=exc,
        )


def spawn_background(
    coro: Awaitable[Any],
    *,
    name: str,
    key: Optional[str] = None,
) -> Optional["asyncio.Task[Any]"]:
    """Run ``coro`` detached, safely.

    Args:
        coro: The coroutine to run. Closed without running if scheduling is
            impossible, so no "never awaited" warning is emitted.
        name: Identifies the job in logs. Make it greppable — it is the only
            handle anyone gets when this fails at 3am.
        key: Optional dedup key. If a task with this key is still running, the
            new coroutine is discarded and the RUNNING task is returned. Use it
            for sweeps/refreshes where "one in flight" is the correct
            behaviour and a burst of triggers must not become a burst of tasks.

    Returns:
        The task, or None if there was no running loop to schedule on
        (best-effort by design — a detached job must never break its caller).
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # Called off the event loop: nothing to schedule on. Close the
        # coroutine so Python does not warn about it separately, and say so.
        logger.warning("background task %s not scheduled — no running loop", name)
        close = getattr(coro, "close", None)
        if callable(close):
            close()
        return None

    if key is not None:
        existing = _keyed.get(key)
        if existing is not None and not existing.done():
            close = getattr(coro, "close", None)
            if callable(close):
                close()
            logger.debug("background task %s already in flight (key=%s)", name, key)
            return existing

    task = loop.create_task(coro, name=name)
    if key is not None:
        _keyed[key] = task
    else:
        _anonymous.add(task)
    task.add_done_callback(lambda t: _on_done(t, name, key))
    return task


def background_task_count() -> Dict[str, int]:
    """In-flight counts, for /health and for tests asserting no leak."""
    return {"anonymous": len(_anonymous), "keyed": len(_keyed)}


def install_asyncio_exception_handler(loop: "asyncio.AbstractEventLoop") -> None:
    """Route every unhandled asyncio-level error into our logger.

    Without this, asyncio prints such errors to stderr through its own default
    handler: no logger name, no level, invisible to any log-level filter, and
    easy to lose among framework noise. Anything that reaches here escaped its
    task entirely, so it is logged at ERROR — including the tasks this module
    does not manage (third-party libraries, transports, callbacks).
    """
    default = loop.get_exception_handler()

    def handler(lp: "asyncio.AbstractEventLoop", context: Dict[str, Any]) -> None:
        exc = context.get("exception")
        message = context.get("message") or "unhandled asyncio error"
        where = context.get("future") or context.get("task") or context.get("handle")
        logger.error(
            "asyncio unhandled: %s (in %s)", message, where,
            exc_info=exc if exc is not None else False,
        )
        if default is not None:
            try:
                default(lp, context)
            except Exception:  # noqa: BLE001 — diagnostics must not cascade
                pass

    loop.set_exception_handler(handler)
    logger.info("asyncio exception handler installed")
