"""PostgresTaskRegistryStore tests (PR-D.1.1).

These mock the underlying psycopg3 DatabaseManager so the test
suite doesn't need a live Postgres. Real DB integration tests
belong in tests/integration with a CI-provisioned Postgres.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Dict, List

import pytest

pytest.importorskip("geny_executor")

from geny_executor.stages.s13_task_registry.types import (  # noqa: E402
    TaskFilter,
    TaskRecord,
    TaskStatus,
)

from service.tasks.store_postgres import PostgresTaskRegistryStore  # noqa: E402


class _FakeDB:
    """Minimal in-memory psycopg3-shaped fake.

    Implements only the three methods PostgresTaskRegistryStore calls:
    execute_query / execute_query_one / execute_update_delete. Doesn't
    parse SQL — just records the calls and returns whatever the test
    pre-loaded into the rows store.
    """

    def __init__(self):
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.outputs: Dict[str, List[bytes]] = {}
        self.calls: List[tuple] = []

    # Queries we recognise via simple substring matching.
    def execute_query(self, query: str, params: tuple = ()):
        self.calls.append(("q", query, params))
        if "FROM background_tasks" in query and "ORDER BY created_at DESC" in query:
            rows = list(self.tasks.values())
            rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
            # Apply WHERE filter via simple substring inspection
            rows = self._apply_filter(query, params, rows)
            limit = self._parse_limit(query)
            if limit:
                rows = rows[:limit]
            return rows
        if "FROM background_task_outputs" in query and "ORDER BY seq" in query:
            task_id = params[0] if params else ""
            chunks = self.outputs.get(task_id, [])
            return [{"chunk": c} for c in chunks]
        return []

    def _apply_filter(self, query, params, rows):
        idx = 0
        if "status = %s" in query:
            rows = [r for r in rows if r.get("status") == params[idx]]
            idx += 1
        if "kind = %s" in query:
            rows = [r for r in rows if r.get("kind") == params[idx]]
            idx += 1
        if "created_at >= %s" in query:
            cutoff = params[idx]
            rows = [r for r in rows if (r.get("created_at") or "") >= cutoff]
            idx += 1
        return rows

    def _parse_limit(self, query):
        if "LIMIT" not in query:
            return None
        try:
            return int(query.rsplit("LIMIT", 1)[-1].strip())
        except ValueError:
            return None

    def execute_query_one(self, query: str, params: tuple = ()):
        self.calls.append(("q1", query, params))
        if "FROM background_tasks" in query and "WHERE task_id" in query:
            return self.tasks.get(params[0])
        if "MAX(seq)" in query:
            chunks = self.outputs.get(params[0], [])
            return {"next_seq": len(chunks)}
        return None

    def execute_update_delete(self, query: str, params: tuple = ()):
        self.calls.append(("u", query, params))
        if "INSERT INTO background_tasks" in query:
            (task_id, kind, payload, status, started, completed,
             error, output_path, iteration, _extra) = params
            self.tasks[task_id] = {
                "task_id": task_id, "kind": kind, "payload": payload,
                "status": status, "started_at": started,
                "completed_at": completed, "error": error,
                "output_path": output_path, "iteration_seen": iteration,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            return 1
        if "UPDATE background_tasks" in query:
            task_id = params[-1]
            if task_id not in self.tasks:
                return 0
            (status, started, completed, error, payload) = params[:-1]
            self.tasks[task_id].update({
                "status": status, "started_at": started,
                "completed_at": completed, "error": error,
                "payload": payload,
            })
            return 1
        if "DELETE FROM background_task_outputs" in query:
            task_id = params[0]
            self.outputs.pop(task_id, None)
            return 1
        if "DELETE FROM background_tasks" in query:
            task_id = params[0]
            return 1 if self.tasks.pop(task_id, None) is not None else 0
        if "INSERT INTO background_task_outputs" in query:
            task_id, _seq, chunk = params
            self.outputs.setdefault(task_id, []).append(chunk)
            return 1
        return 0


@pytest.fixture
def store() -> PostgresTaskRegistryStore:
    return PostgresTaskRegistryStore(_FakeDB())


# ── Round-trip ───────────────────────────────────────────────────────


class TestRoundTrip:
    def test_register_then_get(self, store):
        rec = TaskRecord(task_id="t1", kind="bash", payload={"x": 1})
        store.register(rec)
        got = store.get("t1")
        assert got is not None
        assert got.task_id == "t1"
        assert got.kind == "bash"
        assert got.payload == {"x": 1}

    def test_get_unknown_returns_none(self, store):
        assert store.get("ghost") is None

    def test_re_register_overwrites(self, store):
        store.register(TaskRecord(task_id="t1", kind="A"))
        store.register(TaskRecord(task_id="t1", kind="B"))
        got = store.get("t1")
        assert got.kind == "B"

    def test_remove_deletes(self, store):
        store.register(TaskRecord(task_id="t1"))
        assert store.remove("t1") is True
        assert store.get("t1") is None

    def test_remove_unknown_returns_false(self, store):
        assert store.remove("ghost") is False


# ── update_status ────────────────────────────────────────────────────


class TestUpdateStatus:
    def test_terminal_transition(self, store):
        store.register(TaskRecord(task_id="t1"))
        updated = store.update_status("t1", TaskStatus.DONE, result={"ok": True})
        assert updated is not None
        assert updated.status == TaskStatus.DONE
        assert updated.completed_at is not None

    def test_unknown_returns_none(self, store):
        assert store.update_status("ghost", TaskStatus.DONE) is None

    def test_failed_records_error(self, store):
        store.register(TaskRecord(task_id="t1"))
        updated = store.update_status("t1", TaskStatus.FAILED, error="boom")
        assert updated.error == "boom"


# ── Filtering ────────────────────────────────────────────────────────


class TestFilter:
    def test_filter_by_status(self, store):
        store.register(TaskRecord(task_id="a", kind="K"))
        running = TaskRecord(task_id="b", kind="K")
        running.mark(TaskStatus.RUNNING)
        store.register(running)
        out = store.list_filtered(TaskFilter(status=TaskStatus.RUNNING))
        assert [r.task_id for r in out] == ["b"]

    def test_filter_by_kind(self, store):
        store.register(TaskRecord(task_id="a", kind="bash"))
        store.register(TaskRecord(task_id="b", kind="agent"))
        out = store.list_filtered(TaskFilter(kind="agent"))
        assert [r.task_id for r in out] == ["b"]

    def test_limit(self, store):
        for i in range(5):
            store.register(TaskRecord(task_id=f"t{i}"))
        out = store.list_filtered(TaskFilter(limit=2))
        assert len(out) == 2


# ── Output streaming ─────────────────────────────────────────────────


class TestOutput:
    @pytest.mark.asyncio
    async def test_append_then_read(self, store):
        store.register(TaskRecord(task_id="t1"))
        await store.append_output("t1", b"hello ")
        await store.append_output("t1", b"world")
        assert await store.read_output("t1") == b"hello world"

    @pytest.mark.asyncio
    async def test_offset_and_limit(self, store):
        store.register(TaskRecord(task_id="t1"))
        await store.append_output("t1", b"abcdefghij")
        assert await store.read_output("t1", offset=2, limit=4) == b"cdef"

    @pytest.mark.asyncio
    async def test_remove_clears_outputs(self, store):
        store.register(TaskRecord(task_id="t1"))
        await store.append_output("t1", b"data")
        store.remove("t1")
        assert await store.read_output("t1") == b""

    @pytest.mark.asyncio
    async def test_empty_chunk_no_op(self, store):
        store.register(TaskRecord(task_id="t1"))
        await store.append_output("t1", b"x")
        await store.append_output("t1", b"")
        assert await store.read_output("t1") == b"x"

    @pytest.mark.asyncio
    async def test_stream_yields_then_completes(self, store):
        store.register(TaskRecord(task_id="t1"))
        await store.append_output("t1", b"chunk")
        store.update_status("t1", TaskStatus.DONE)
        chunks = [c async for c in store.stream_output("t1")]
        assert b"".join(chunks) == b"chunk"


# ── ABC contract ─────────────────────────────────────────────────────


def test_no_db_manager_raises_on_use():
    s = PostgresTaskRegistryStore(None)
    with pytest.raises(RuntimeError):
        s.register(TaskRecord(task_id="x"))


def test_unwrap_chooses_inner_db_manager():
    class Outer:
        def __init__(self):
            self.db_manager = _FakeDB()
    s = PostgresTaskRegistryStore(Outer())
    assert s._db is not None
    s.register(TaskRecord(task_id="x"))


def test_strategy_name_and_description():
    s = PostgresTaskRegistryStore(_FakeDB())
    assert s.name == "postgres"
    assert "postgres" in s.description.lower()
