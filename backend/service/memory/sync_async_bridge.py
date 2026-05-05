"""Sync→async bridge for the host-side memory layer.

After Sprint 3 the manager + archivers route every memory call
(``provider.stm()`` / ``provider.ltm()`` / ``provider.notes()`` /
``provider.index()`` / ``provider.vector()``) through this bridge.
The provider handles are async by design (the executor owns its
own loop policy), but the host surfaces — ``SessionMemoryManager``,
``ConversationArchiver``, ``CompactionArchiver``, every FastAPI
controller built on top — are still synchronous. Converting them
would cascade through ~90 call sites plus the in-process tools
framework (no ``arun`` yet).

``run_coro_sync(coro)`` is the choke point:
- **Outside an event loop** (CLI, pytest sync test): ``asyncio.run``
  spins up a fresh loop and tears it down.
- **Inside a running loop** (FastAPI handler, websocket callback):
  offloads to a one-shot worker thread with its own loop so we
  never re-enter the caller's loop.

Cost per call: ~1-3 ms of overhead on top of the underlying I/O.
A ``record_message`` turn does 5-10 provider calls and stays under
the 50 ms budget operator measured in 1.21.0.

Full retirement is gated on async-ifying every caller (``PR-C5`` in
the original plan). Until then, centralising the bridge here keeps
later promotion to a shared worker pool a one-file change.
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
