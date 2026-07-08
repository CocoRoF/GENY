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


# ── Off-loop side-effect executor ────────────────────────────────────
#
# A dedicated single-worker thread pool for host-side memory SIDE-EFFECTS
# that are (a) best-effort and (b) implemented as SYNC chains which call
# ``run_coro_sync`` internally — specifically conversation/DM archiving
# (``_on_record_turn`` hook) and compaction-snapshot writes
# (``PersistingLLMSummaryCompactor.compact``).
#
# Why this is mandatory, not an optimisation:
#   Those chains reach ``run_coro_sync``. If invoked directly from a
#   coroutine on the main event loop, ``run_coro_sync`` takes its
#   *in-loop* branch — it spins a worker future and BLOCKS the loop
#   thread on ``.result()``. That worker then does ``notes.write`` /
#   ``notes.update`` which acquires a ``LoopAgnosticLock`` (a process-wide
#   ``threading.Lock``). If that lock is momentarily held by ANOTHER
#   coroutine on the (now frozen) main loop that yielded mid-critical-
#   section, the holder can never resume to release it → permanent
#   process deadlock. (Observed in prod as repeated backend hangs;
#   executor 2.48.2's non-blocking acquire only fixed the same-loop
#   contention case, not this cross-thread block.)
#
#   Running the sync chain HERE instead means ``run_coro_sync`` sees no
#   running loop → uses ``asyncio.run`` on this worker thread, blocking
#   only the worker. The main loop stays free, so any lock holder on it
#   resumes and releases normally. ``max_workers=1`` preserves the global
#   "one archiver/compaction writer at a time" serialisation these code
#   paths were written under (previously enforced implicitly by the
#   loop-blocking behaviour), so no new concurrency races are introduced.
_SIDE_EFFECT_POOL = concurrent.futures.ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="mem-sideeffect"
)


async def offload_blocking(fn):
    """Run a blocking, ``run_coro_sync``-using memory side-effect OFF the
    event loop, from an async caller, and await its completion.

    Keeps loop-blocking (and its deadlock class, see ``_SIDE_EFFECT_POOL``)
    out of the pipeline while preserving back-pressure — the awaiting
    coroutine still waits for the side-effect, it just no longer freezes
    the loop for every other task while it runs.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_SIDE_EFFECT_POOL, fn)


__all__ = ["run_coro_sync", "offload_blocking"]
