"""PostgresTaskRegistryStore — multi-host durable task registry (PR-D.1.1).

Implements ``geny_executor.stages.s13_task_registry.TaskRegistryStore``
backed by Geny's existing psycopg3 connection pool. Two tables, both
auto-created via APPLICATION_MODELS:

- ``background_tasks``         (one row per task)
- ``background_task_outputs``  (append-only chunks per task)

The pool is sync — every coroutine method wraps the call in
``asyncio.to_thread`` so we don't block the event loop. The pool is
already thread-safe.

Use this when:

- multiple backend instances need a shared task view (Postgres is the
  shared truth; FileBackedRegistry's jsonl is per-host)
- operators want to query task history with SQL
- the file backend's registry.jsonl is hitting size limits

InMemoryRegistry + FileBackedRegistry stay as the lighter options.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

from geny_executor.stages.s13_task_registry.interface import TaskRegistry
from geny_executor.stages.s13_task_registry.types import (
    TaskFilter,
    TaskRecord,
    TaskStatus,
)

logger = logging.getLogger(__name__)


_TASKS_TABLE = "background_tasks"
_OUTPUTS_TABLE = "background_task_outputs"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_record(row: Dict[str, Any]) -> TaskRecord:
    payload_raw = row.get("payload") or ""
    try:
        payload = json.loads(payload_raw) if payload_raw else {}
    except (json.JSONDecodeError, TypeError):
        payload = {}
    started = row.get("started_at") or None
    completed = row.get("completed_at") or None
    return TaskRecord(
        task_id=row["task_id"],
        kind=row.get("kind") or "",
        payload=payload,
        status=TaskStatus(row.get("status") or TaskStatus.PENDING.value),
        created_at=_parse_dt(row.get("created_at")),
        started_at=_parse_dt(started),
        completed_at=_parse_dt(completed),
        error=row.get("error") or None,
        iteration_seen=int(row.get("iteration_seen") or 0),
        output_path=row.get("output_path") or None,
    )


def _parse_dt(value) -> Optional[datetime]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


class PostgresTaskRegistryStore(TaskRegistry):
    """Postgres-backed TaskRegistryStore.

    Constructor takes the Geny ``DatabaseManager`` — same instance the
    rest of Geny uses (no separate pool). Strategy slot ``name`` /
    ``description`` reflect the backend so /api/admin tooling can
    distinguish runtimes.
    """

    def __init__(self, db_manager: Any) -> None:
        self._db = self._unwrap(db_manager)
        # asyncio.Event per task for stream_output wake-up. Created
        # lazily on first append so we don't track tasks that never
        # stream.
        self._wake: Dict[str, asyncio.Event] = {}

    # ── Strategy contract ────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "postgres"

    @property
    def description(self) -> str:
        return "Postgres-backed task registry (multi-host durable)"

    # ── Helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _unwrap(db_manager):
        # Mirrors the pattern used across helpers — the public manager
        # exposes the actual DatabaseManager via .db_manager.
        if db_manager is None:
            return None
        if hasattr(db_manager, "db_manager"):
            return db_manager.db_manager
        return db_manager

    def _execute(self, query: str, params: tuple = ()):
        if self._db is None:
            raise RuntimeError("PostgresTaskRegistryStore: db_manager not bound")
        return self._db.execute_query(query, params)

    def _execute_one(self, query: str, params: tuple = ()):
        if self._db is None:
            raise RuntimeError("PostgresTaskRegistryStore: db_manager not bound")
        return self._db.execute_query_one(query, params)

    def _execute_modify(self, query: str, params: tuple = ()) -> Optional[int]:
        if self._db is None:
            raise RuntimeError("PostgresTaskRegistryStore: db_manager not bound")
        return self._db.execute_update_delete(query, params)

    # ── TaskRegistry / TaskRegistryStore protocol ────────────────────

    def register(self, record: TaskRecord) -> None:
        # UPSERT — same id re-registered overwrites (matches InMemory).
        payload_blob = json.dumps(record.payload or {}, ensure_ascii=False, default=str)
        query = f"""
            INSERT INTO {_TASKS_TABLE}
                (task_id, kind, payload, status, started_at, completed_at,
                 error, output_path, iteration_seen, extra_data,
                 created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
            ON CONFLICT (task_id) DO UPDATE SET
                kind = EXCLUDED.kind,
                payload = EXCLUDED.payload,
                status = EXCLUDED.status,
                started_at = EXCLUDED.started_at,
                completed_at = EXCLUDED.completed_at,
                error = EXCLUDED.error,
                output_path = EXCLUDED.output_path,
                iteration_seen = EXCLUDED.iteration_seen,
                updated_at = NOW()
        """
        self._execute_modify(query, (
            record.task_id,
            record.kind or "",
            payload_blob,
            record.status.value,
            record.started_at.isoformat() if record.started_at else "",
            record.completed_at.isoformat() if record.completed_at else "",
            record.error or "",
            record.output_path or "",
            int(record.iteration_seen or 0),
            "",
        ))
        # Wake events are session-bound; create lazily.
        self._wake.setdefault(record.task_id, asyncio.Event())

    def get(self, task_id: str) -> Optional[TaskRecord]:
        row = self._execute_one(
            f"SELECT * FROM {_TASKS_TABLE} WHERE task_id = %s LIMIT 1",
            (task_id,),
        )
        return _row_to_record(row) if row else None

    def update_status(
        self,
        task_id: str,
        status: TaskStatus,
        *,
        result: Any = None,
        error: Optional[str] = None,
    ) -> Optional[TaskRecord]:
        # We don't store ``result`` as a column (it's free-form); stash
        # into payload so consumers can read it back via to_dict().
        existing = self.get(task_id)
        if existing is None:
            return None
        existing.mark(status, result=result, error=error)
        # Pure UPDATE rather than a re-INSERT; we already validated
        # the row exists.
        self._execute_modify(
            f"""
            UPDATE {_TASKS_TABLE}
            SET status = %s,
                started_at = %s,
                completed_at = %s,
                error = %s,
                payload = %s,
                updated_at = NOW()
            WHERE task_id = %s
            """,
            (
                existing.status.value,
                existing.started_at.isoformat() if existing.started_at else "",
                existing.completed_at.isoformat() if existing.completed_at else "",
                existing.error or "",
                json.dumps(existing.payload or {}, ensure_ascii=False, default=str),
                task_id,
            ),
        )
        if existing.is_terminal:
            ev = self._wake.get(task_id)
            if ev is not None:
                ev.set()
        return existing

    def list_all(self) -> List[TaskRecord]:
        rows = self._execute(
            f"SELECT * FROM {_TASKS_TABLE} ORDER BY created_at DESC"
        )
        return [_row_to_record(r) for r in (rows or [])]

    def remove(self, task_id: str) -> bool:
        self._execute_modify(
            f"DELETE FROM {_OUTPUTS_TABLE} WHERE task_id = %s", (task_id,),
        )
        affected = self._execute_modify(
            f"DELETE FROM {_TASKS_TABLE} WHERE task_id = %s", (task_id,),
        )
        ev = self._wake.pop(task_id, None)
        if ev is not None:
            ev.set()
        return bool(affected and affected > 0)

    # ── Filtering (override default impl for query pushdown) ─────────

    def list_filtered(self, filter: TaskFilter) -> List[TaskRecord]:
        where: List[str] = []
        params: List[Any] = []
        if filter.status is not None:
            where.append("status = %s")
            params.append(filter.status.value)
        if filter.kind is not None:
            where.append("kind = %s")
            params.append(filter.kind)
        if filter.created_after is not None:
            where.append("created_at >= %s")
            params.append(filter.created_after.isoformat())
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        limit_clause = f"LIMIT {int(filter.limit)}" if filter.limit else ""
        query = (
            f"SELECT * FROM {_TASKS_TABLE} {clause} "
            f"ORDER BY created_at DESC {limit_clause}"
        )
        rows = self._execute(query, tuple(params))
        return [_row_to_record(r) for r in (rows or [])]

    # ── Output streaming ─────────────────────────────────────────────

    async def append_output(self, task_id: str, chunk: bytes) -> None:
        if not chunk:
            return
        # Allocate a sequence number atomically — the unique
        # (task_id, seq) constraint protects against concurrent
        # writers if an operator runs two runners against the same
        # row (unsupported but should fail safely instead of
        # corrupting silently).
        await asyncio.to_thread(self._append_chunk, task_id, chunk)
        ev = self._wake.setdefault(task_id, asyncio.Event())
        ev.set()
        ev.clear()

    def _append_chunk(self, task_id: str, chunk: bytes) -> None:
        # MAX(seq) → next slot. Single-writer assumption per task; if a
        # gap appears the consumer just sees the new chunk later.
        row = self._execute_one(
            f"SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq "
            f"FROM {_OUTPUTS_TABLE} WHERE task_id = %s",
            (task_id,),
        )
        next_seq = int((row or {}).get("next_seq") or 0)
        self._execute_modify(
            f"INSERT INTO {_OUTPUTS_TABLE} (task_id, seq, chunk, "
            f"created_at, updated_at) VALUES (%s, %s, %s, NOW(), NOW())",
            (task_id, next_seq, chunk),
        )

    async def read_output(
        self,
        task_id: str,
        offset: int = 0,
        limit: Optional[int] = None,
    ) -> bytes:
        rows = await asyncio.to_thread(
            self._execute,
            f"SELECT chunk FROM {_OUTPUTS_TABLE} "
            f"WHERE task_id = %s ORDER BY seq",
            (task_id,),
        )
        buf = b"".join(bytes(r["chunk"]) for r in (rows or []))
        if offset >= len(buf):
            return b""
        end = len(buf) if limit is None else min(offset + limit, len(buf))
        return buf[offset:end]

    async def stream_output(self, task_id: str) -> AsyncIterator[bytes]:
        offset = 0
        while True:
            chunk = await self.read_output(task_id, offset)
            if chunk:
                yield chunk
                offset += len(chunk)
                continue
            # Wait either for a new chunk (via wake event) or for the
            # task to reach a terminal status.
            record = await asyncio.to_thread(self.get, task_id)
            if record is None:
                return
            if record.is_terminal:
                tail = await self.read_output(task_id, offset)
                if tail:
                    yield tail
                return
            ev = self._wake.setdefault(task_id, asyncio.Event())
            try:
                await asyncio.wait_for(ev.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass


__all__ = ["PostgresTaskRegistryStore"]
