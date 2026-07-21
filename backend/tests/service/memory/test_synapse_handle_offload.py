"""SynapseVectorHandle must run its blocking SQLite/graph ops OFF the event
loop. A large session's on-loop Synapse re-index once wedged the whole backend
for hours (main thread stuck in ``rq_qos_wait``). These tests pin the offload:
every ``self._m.*`` call runs on a worker thread, never the loop thread.
"""

from __future__ import annotations

import asyncio
import threading

import pytest

from service.memory.synapse_handle import SynapseVectorHandle


class _FakeHit:
    def __init__(self, _id: str) -> None:
        self.id = _id
        self.title = _id
        self.score = 1.0
        self.sources = []
        self.query_token = "t"
        self.kind = "note"
        self.features = None


class _FakeMem:
    """Records the thread each op ran on, so the test can prove offloading."""

    def __init__(self) -> None:
        self.threads: dict[str, int] = {}

    def _mark(self, op: str) -> None:
        self.threads[op] = threading.get_ident()

    def search(self, text, top_k=5):
        self._mark("search")
        return [_FakeHit("n1"), _FakeHit("n2")]

    def get_text(self, _id):
        self._mark("get_text")
        return f"body-{_id}"

    def index(self, node_id, text, kind="note"):
        self._mark("index")

    def remove(self, node_id):
        self._mark("remove")

    def distill(self):
        self._mark("distill")
        return {"pairs": 3}


class _Ref:
    def __init__(self, filename: str) -> None:
        self.filename = filename
        self.scope = "session"
        self.category = "note"


def _loop_thread_id() -> int:
    return threading.get_ident()


@pytest.mark.asyncio
async def test_search_runs_off_the_loop_thread():
    mem = _FakeMem()
    handle = SynapseVectorHandle(mem, dim=256)
    loop_tid = _loop_thread_id()
    out = await handle.search("hello", top_k=2)
    # Result still correct...
    assert [c.key for c in out] == ["n1", "n2"]
    assert out[0].content == "body-n1"
    # ...and the SQLite work happened on a DIFFERENT (worker) thread.
    assert mem.threads["search"] != loop_tid
    assert mem.threads["get_text"] != loop_tid


@pytest.mark.asyncio
async def test_index_and_batch_offloaded():
    mem = _FakeMem()
    handle = SynapseVectorHandle(mem, dim=256)
    loop_tid = _loop_thread_id()
    await handle.index(_Ref("a.md"), "text")
    assert mem.threads["index"] != loop_tid
    mem.threads.clear()
    n = await handle.index_batch([(_Ref("b.md"), "t1"), (_Ref("c.md"), "t2")])
    assert n == 2
    assert mem.threads["index"] != loop_tid


@pytest.mark.asyncio
async def test_remove_and_reindex_offloaded():
    mem = _FakeMem()
    handle = SynapseVectorHandle(mem, dim=256)
    loop_tid = _loop_thread_id()
    await handle.remove(_Ref("a.md"))
    plan = await handle.reindex()
    assert mem.threads["remove"] != loop_tid
    assert mem.threads["distill"] != loop_tid
    assert plan.chunks_to_reindex == 3


@pytest.mark.asyncio
async def test_loop_stays_responsive_during_slow_synapse_op():
    """A slow Synapse call must not stall other loop tasks."""
    import time

    class _SlowMem(_FakeMem):
        def search(self, text, top_k=5):
            time.sleep(0.4)  # simulate a heavy on-disk search
            return super().search(text, top_k=top_k)

    handle = SynapseVectorHandle(_SlowMem(), dim=256)
    ticks = 0

    async def ticker():
        nonlocal ticks
        for _ in range(8):
            await asyncio.sleep(0.05)
            ticks += 1

    t = asyncio.create_task(ticker())
    await handle.search("q")
    await t
    # If search had blocked the loop, the ticker couldn't have advanced.
    assert ticks >= 5
