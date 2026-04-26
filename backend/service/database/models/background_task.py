"""
BackgroundTaskModel — Database model for executor BackgroundTaskRunner state (PR-D.1.1).

One row per submitted task. Output bytes live in a separate
``background_task_outputs`` table (see BackgroundTaskOutputModel)
to keep this row small and append-stream-friendly.

Schema mirrors :class:`geny_executor.stages.s13_task_registry.TaskRecord`
plus an ``extra_data`` blob for forward-compat fields the executor
may add in future minors.
"""

from typing import Any, Dict

from service.database.models.base_model import BaseModel


class BackgroundTaskModel(BaseModel):
    """Persisted shape of a TaskRecord."""

    def __init__(
        self,
        task_id: str = "",
        kind: str = "",
        payload: str = "",      # JSON-encoded dict
        status: str = "pending",
        started_at: str = "",
        completed_at: str = "",
        error: str = "",
        output_path: str = "",
        iteration_seen: int = 0,
        extra_data: str = "",
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.task_id = task_id
        self.kind = kind
        self.payload = payload
        self.status = status
        self.started_at = started_at
        self.completed_at = completed_at
        self.error = error
        self.output_path = output_path
        self.iteration_seen = iteration_seen
        self.extra_data = extra_data

    def get_table_name(self) -> str:
        return "background_tasks"

    def get_schema(self) -> Dict[str, str]:
        return {
            "task_id": "VARCHAR(64) NOT NULL",
            "kind": "VARCHAR(32) NOT NULL DEFAULT ''",
            "payload": "TEXT DEFAULT ''",
            "status": "VARCHAR(16) NOT NULL DEFAULT 'pending'",
            "started_at": "VARCHAR(64) DEFAULT ''",
            "completed_at": "VARCHAR(64) DEFAULT ''",
            "error": "TEXT DEFAULT ''",
            "output_path": "VARCHAR(512) DEFAULT ''",
            "iteration_seen": "INTEGER DEFAULT 0",
            "extra_data": "TEXT DEFAULT ''",
        }

    @classmethod
    def get_create_table_query(cls, db_type: str = "postgresql") -> str:
        base = super().get_create_table_query(db_type)
        constraint = ",\n            UNIQUE (task_id)"
        idx = base.rfind(")")
        if idx != -1:
            return base[:idx] + constraint + base[idx:]
        return base

    def get_indexes(self) -> list:
        return [
            ("idx_background_tasks_task_id", "task_id"),
            ("idx_background_tasks_status_created", "status, created_at DESC"),
            ("idx_background_tasks_kind", "kind"),
        ]

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "BackgroundTaskModel":
        known = {
            "task_id", "kind", "payload", "status",
            "started_at", "completed_at", "error", "output_path",
            "iteration_seen", "extra_data",
            "id", "created_at", "updated_at",
        }
        return cls(**{k: v for k, v in data.items() if k in known})


class BackgroundTaskOutputModel(BaseModel):
    """One chunk of streamed output. Insert-only — never updated.

    Reading is `WHERE task_id=? AND seq >= ? ORDER BY seq` so the
    stream consumer pages through new rows as the producer appends.
    """

    def __init__(
        self,
        task_id: str = "",
        seq: int = 0,
        chunk: bytes = b"",
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.task_id = task_id
        self.seq = seq
        self.chunk = chunk

    def get_table_name(self) -> str:
        return "background_task_outputs"

    def get_schema(self) -> Dict[str, str]:
        return {
            "task_id": "VARCHAR(64) NOT NULL",
            "seq": "INTEGER NOT NULL DEFAULT 0",
            "chunk": "BYTEA NOT NULL",
        }

    def get_indexes(self) -> list:
        return [
            ("idx_bgt_outputs_task_seq", "task_id, seq"),
        ]
