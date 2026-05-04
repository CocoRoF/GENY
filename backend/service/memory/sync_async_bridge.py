"""Tiny sync↔async bridge for archive layer cut-over.

The legacy archive functions (`StructuredMemoryWriter.write_note`,
`SessionMemoryManager.record_message`, `ConversationArchiver.archive`,
…) are all synchronous. The executor's `NotesHandle.write` is async.
Phase 3 cuts the disk-write path over to NotesHandle without
converting every caller to async — that cascade would touch ~30 call
sites including FastAPI request handlers and the executor's pipeline
runtime.

`run_coro_sync(coro)` is the choke point: it awaits `coro` from a
sync caller. When invoked from within an event loop (the normal
case — the chat broadcast handler is async), it offloads to a
worker thread with its own loop. When invoked outside any loop
(scripts, tests), it uses `asyncio.run` directly.

Cost: each call spawns one short-lived worker thread + a fresh event
loop. For one note write that is ~1-3 ms of overhead on top of the
disk write itself. The phase 3 plan budgets <50 ms per turn (5-10
note writes) which the measurement bears out.

Centralising the bridge here means later promotion to a shared
worker pool or a different async-friendly path is a one-file change
— callers stay on `run_coro_sync(...)`.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
from logging import getLogger
from typing import Awaitable, TypeVar

logger = getLogger(__name__)

_T = TypeVar("_T")


def run_coro_sync(coro: Awaitable[_T]) -> _T:
    """Await a coroutine from a sync context.

    - **Outside an event loop** (CLI, pytest sync test): uses
      `asyncio.run` for a fresh dedicated loop.
    - **Inside a running loop** (FastAPI handler, websocket
      callback): offloads to a worker thread with its own loop so
      we never re-enter the running loop.

    The worker-thread path is robust under nested broadcasts —
    different turns get different threads, so a slow embedding round
    trip on one turn cannot stall another.
    """
    try:
        asyncio.get_running_loop()
        in_loop = True
    except RuntimeError:
        in_loop = False

    if not in_loop:
        return asyncio.run(coro)  # type: ignore[arg-type]

    def _runner() -> _T:
        new_loop = asyncio.new_event_loop()
        try:
            return new_loop.run_until_complete(coro)  # type: ignore[arg-type]
        finally:
            new_loop.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(_runner).result()


__all__ = ["run_coro_sync"]
