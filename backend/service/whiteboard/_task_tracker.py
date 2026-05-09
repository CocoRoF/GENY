"""
Internal: hold strong references to fire-and-forget asyncio tasks.

CPython's asyncio docs (`asyncio.create_task`):

  > Important: Save a reference to the result of this function, to
  > avoid a task disappearing mid-execution. The event loop only
  > keeps weak references to tasks. A task that isn't referenced
  > elsewhere may be garbage collected at any time, even before it's
  > done.

The whiteboard surface fires several background tasks
(post-capture hooks, [USER_SHARED] trigger). Their callers don't
await the result, and historically also didn't store the Task
handle, so a heavily-loaded process could see hooks vanish silently.

This module is the single shared "set of in-flight tasks" plus a
helper that schedules a coroutine and (a) keeps the Task referenced
until done, (b) re-logs any exception so silent failures still
reach the warning channel.

Best-effort throughout — if no event loop is running, the helper
returns ``None`` rather than raising into the caller's hot path.
"""

from __future__ import annotations

import asyncio
import threading
from logging import getLogger
from typing import Awaitable, Optional, Set

logger = getLogger(__name__)


_TASKS: Set[asyncio.Task] = set()
_TASKS_LOCK = threading.Lock()


def schedule(coro: Awaitable, *, name: str = "whiteboard.task") -> Optional[asyncio.Task]:
    """Schedule ``coro`` as a fire-and-forget background task.

    Returns the created Task (mainly for tests) or ``None`` when no
    event loop is running.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No loop in this context (sync-only call from CLI / tests).
        # Caller decides whether to spin one up; we don't, because
        # creating a private loop here would leak it.
        logger.debug("%s: no running loop, skipping background task", name)
        return None

    task = loop.create_task(coro, name=name)

    # Hold a strong reference until the task finishes so the GC
    # can't collect it mid-flight.
    with _TASKS_LOCK:
        _TASKS.add(task)

    def _on_done(t: asyncio.Task) -> None:
        with _TASKS_LOCK:
            _TASKS.discard(t)
        # Surface exceptions that the task swallowed locally — at
        # warning level, keyed by the task name.
        try:
            exc = t.exception()
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            return
        if exc is not None:
            logger.warning(
                "%s task raised: %s", t.get_name(), exc, exc_info=exc
            )

    task.add_done_callback(_on_done)
    return task


def in_flight_count() -> int:
    """For diagnostics / tests — how many tasks are currently held."""
    with _TASKS_LOCK:
        return len(_TASKS)
