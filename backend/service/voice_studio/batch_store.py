"""
SQLite + filesystem store for Voice Studio batch jobs.

Job artifacts live at::

    <data_dir>/batch_jobs/<job_id>/
        0001.wav
        0002.wav
        ...
        manifest.json   (written when finished)
        result.zip      (written when finished or cancelled)

Schema:

  batch_jobs(id, created_at, started_at, finished_at, state,
             total_lines, completed_lines, error_lines,
             defaults_json, lines_json, zip_path, log_text, label)

Hard cap of 500 lines/job (controller enforces) keeps the disk
predictable; cleanup is manual for now.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

from .history_store import _resolve_data_dir

logger = getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS batch_jobs (
    id              TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL,
    started_at      TEXT,
    finished_at     TEXT,
    state           TEXT NOT NULL,
    total_lines     INTEGER NOT NULL,
    completed_lines INTEGER NOT NULL DEFAULT 0,
    error_lines     INTEGER NOT NULL DEFAULT 0,
    defaults_json   TEXT NOT NULL,
    lines_json      TEXT NOT NULL,
    zip_path        TEXT,
    log_text        TEXT NOT NULL DEFAULT '',
    label           TEXT
);
CREATE INDEX IF NOT EXISTS ix_batch_jobs_created ON batch_jobs(created_at DESC);
"""

JOB_STATES = ("queued", "running", "done", "cancelled", "failed")


def _now_utc() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class BatchStore:
    def __init__(self, data_dir: Optional[Path | str] = None) -> None:
        self.data_dir = Path(data_dir) if data_dir else _resolve_data_dir()
        self.jobs_dir = self.data_dir / "batch_jobs"
        self.db_path = self.data_dir / "batch.sqlite3"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, isolation_level=None, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    # ── Reads ───────────────────────────────────────────────────────────

    def get(self, id: str) -> Optional[Dict[str, Any]]:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM batch_jobs WHERE id = ?", (id,)).fetchone()
        return dict(row) if row else None

    def list_recent(self, limit: int = 20) -> List[Dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM batch_jobs ORDER BY created_at DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
        return [dict(r) for r in rows]

    def job_dir(self, id: str) -> Path:
        return self.jobs_dir / id

    def line_audio_path(self, id: str, seq: int) -> Path:
        return self.job_dir(id) / f"{seq:04d}.wav"

    # ── Mutations ───────────────────────────────────────────────────────

    def insert(self, *, defaults: Dict[str, Any], lines: List[Dict[str, Any]], label: Optional[str]) -> str:
        if not lines:
            raise ValueError("lines must not be empty")
        job_id = secrets.token_hex(8)
        created_at = _now_utc()
        self.job_dir(job_id).mkdir(parents=True, exist_ok=True)
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO batch_jobs (
                    id, created_at, state, total_lines,
                    defaults_json, lines_json, label
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id, created_at, "queued", len(lines),
                    json.dumps(defaults, ensure_ascii=False),
                    json.dumps(lines, ensure_ascii=False),
                    label,
                ),
            )
        return job_id

    def mark_running(self, id: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE batch_jobs SET state='running', started_at=COALESCE(started_at, ?) WHERE id=?",
                (_now_utc(), id),
            )

    def update_progress(self, id: str, *, completed: int, errors: int) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE batch_jobs SET completed_lines=?, error_lines=? WHERE id=?",
                (int(completed), int(errors), id),
            )

    def append_log(self, id: str, line: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE batch_jobs SET log_text = log_text || ? WHERE id = ?",
                (line + "\n", id),
            )

    def mark_done(self, id: str, zip_path: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE batch_jobs SET state='done', finished_at=?, zip_path=? WHERE id=?",
                (_now_utc(), zip_path, id),
            )

    def mark_cancelled(self, id: str, zip_path: Optional[str] = None) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE batch_jobs SET state='cancelled', finished_at=?, zip_path=COALESCE(?, zip_path) WHERE id=?",
                (_now_utc(), zip_path, id),
            )

    def mark_failed(self, id: str, reason: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE batch_jobs SET state='failed', finished_at=?, log_text = log_text || ? WHERE id=?",
                (_now_utc(), f"[failed] {reason}\n", id),
            )


_store: Optional[BatchStore] = None


def get_batch_store() -> BatchStore:
    global _store
    if _store is None:
        _store = BatchStore()
    return _store
