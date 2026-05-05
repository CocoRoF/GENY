"""Sync→async bridge for the host-side memory layer.

After Sprint 3 + Step 7 most production paths skip this bridge
entirely:

- **Tools** (``memory_tools`` / ``memory_inspect_tools`` /
  ``knowledge_tools``) override ``arun`` and call manager ``a*``
  siblings directly. The executor's tool runtime prefers ``arun``,
  so dispatch never hits a sync wrapper.
- **Controllers** (``memory_controller`` / ``user_opsidian_controller``
  / ``curated_knowledge_controller``) are async-native and call
  ``await mgr.aX(...)`` siblings.
- **Session manager helpers** (``_stm_*`` / ``_ltm_*`` / ``_notes_*``
  / ``_index_*`` / ``_vector_*``) are async-native; ``await
  provider.X()`` directly with no internal bridge call.
- **Multi-tenant managers** (``GlobalMemoryManager`` /
  ``CuratedKnowledgeManager`` / ``UserOpsidianManager``) expose ``a*``
  async siblings used by every async caller.

Where the bridge IS still load-bearing:

1. **Singleton constructor for multi-tenant managers** — the
   ``get_X_manager(...)`` getters lazily build a per-tenant
   ``MemoryProvider`` from a sync ``__init__`` path. The lone
   ``run_coro_sync(build_single_tenant_provider(...))`` call there
   bridges the inevitable sync→async hop.
2. **Sync public-method back-compat wrappers** — every async helper
   on the managers is wrapped by a sync method of the same name
   (without the ``a`` prefix). Production never calls them, but
   tests + CLI scripts + any pre-async caller still can.
3. **Archiver internals** — ``ConversationArchiver._merge_to_disk``
   and ``CompactionArchiver`` write paths run inside sync
   ``record_message`` / ``record_compaction`` chains. Migrating those
   to async would cascade into the executor's ``after_record_turn``
   hook contract; deferred.

``run_coro_sync(coro)`` is the choke point:
- **Outside an event loop** (CLI, pytest sync test): ``asyncio.run``
  spins up a fresh loop and tears it down.
- **Inside a running loop** (FastAPI handler that fell into a sync
  wrapper, websocket callback): offloads to a one-shot worker thread
  with its own loop so we never re-enter the caller's loop.

Cost per call: ~1-3 ms of overhead on top of the underlying I/O.
After Step 7 only ~3 production sites still pay it (the singleton
constructors). Centralising the bridge here keeps a future
shared-worker-pool promotion a one-file change.
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
