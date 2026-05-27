"""
SQLite + filesystem store for Voice Studio synthesis history.

Each Synthesize-card invocation that succeeds writes one row + one wav
file. The store enforces a hard cap (``HISTORY_CAP``) — when an insert
pushes the count over the cap, the oldest row's audio file is removed
and the row deleted (FIFO).

Data directory resolution:
  1. ``GENY_VOICE_STUDIO_DATA_DIR`` env var.
  2. ``/data/voice_studio`` — the prod named-volume mount point.
  3. ``/app/data/voice_studio`` — legacy fallback on the writable layer.

In prod the docker-compose adds a named volume at ``/data/voice_studio``
so history survives ``docker compose up --build backend``.
"""

from __future__ import annotations

import json as _json
import os
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = getLogger(__name__)

HISTORY_CAP = 20

_SCHEMA = """
CREATE TABLE IF NOT EXISTS synthesis_history (
    id              TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL,
    text            TEXT NOT NULL,
    profile         TEXT,
    engine          TEXT NOT NULL,
    mode            TEXT,
    seed            INTEGER,
    params_json     TEXT NOT NULL,
    audio_path      TEXT NOT NULL,
    duration_seconds REAL,
    rtf             REAL,
    sample_rate     INTEGER
);
CREATE INDEX IF NOT EXISTS ix_synthesis_history_created ON synthesis_history(created_at DESC);
"""


def _resolve_data_dir() -> Path:
    env = os.environ.get("GENY_VOICE_STUDIO_DATA_DIR")
    if env:
        return Path(env)
    for candidate in (Path("/data/voice_studio"), Path("/app/data/voice_studio")):
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            # Probe writability before committing.
            probe = candidate / ".write_probe"
            probe.write_text("ok")
            probe.unlink(missing_ok=True)
            return candidate
        except Exception:
            continue
    # Last-ditch — local working directory.
    fallback = Path("./data/voice_studio").resolve()
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


@dataclass(slots=True)
class HistoryRow:
    id: str
    created_at: str
    text: str
    profile: Optional[str]
    engine: str
    mode: Optional[str]
    seed: Optional[int]
    duration_seconds: float
    rtf: float
    sample_rate: int

    @classmethod
    def from_db(cls, row: sqlite3.Row) -> "HistoryRow":
        return cls(
            id=row["id"],
            created_at=row["created_at"],
            text=row["text"],
            profile=row["profile"],
            engine=row["engine"],
            mode=row["mode"],
            seed=row["seed"],
            duration_seconds=row["duration_seconds"] or 0.0,
            rtf=row["rtf"] or 0.0,
            sample_rate=row["sample_rate"] or 24000,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "created_at": self.created_at,
            "text": self.text,
            "profile": self.profile,
            "engine": self.engine,
            "mode": self.mode,
            "seed": self.seed,
            "duration_seconds": self.duration_seconds,
            "rtf": self.rtf,
            "sample_rate": self.sample_rate,
        }


class HistoryStore:
    def __init__(self, data_dir: Optional[Path | str] = None) -> None:
        self.data_dir = Path(data_dir) if data_dir else _resolve_data_dir()
        self.audio_dir = self.data_dir / "audio"
        self.db_path = self.data_dir / "history.sqlite3"
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            conn.commit()
        logger.info("voice-studio history store ready at %s", self.data_dir)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, isolation_level=None, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # Better concurrency for a multi-request workload.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    # ── Read paths ──────────────────────────────────────────────────────

    def list_recent(self, limit: int = HISTORY_CAP) -> List[HistoryRow]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM synthesis_history ORDER BY created_at DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
        return [HistoryRow.from_db(r) for r in rows]

    def get(self, id: str) -> Optional[Dict[str, Any]]:
        """Returns the *full* row (including params_json + audio_path) or None."""
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM synthesis_history WHERE id = ?", (id,)).fetchone()
        if not row:
            return None
        return {k: row[k] for k in row.keys()}

    def audio_path(self, id: str) -> Optional[Path]:
        row = self.get(id)
        if not row:
            return None
        p = Path(row["audio_path"])
        return p if p.exists() else None

    # ── Mutations ───────────────────────────────────────────────────────

    def insert(
        self,
        *,
        text: str,
        profile: Optional[str],
        engine: str,
        mode: Optional[str],
        seed: Optional[int],
        params: Dict[str, Any],
        audio_bytes: bytes,
        duration_seconds: float,
        rtf: float,
        sample_rate: int,
    ) -> str:
        id = secrets.token_hex(8)
        created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        audio_path = self.audio_dir / f"{id}.wav"

        with self._lock:
            audio_path.write_bytes(audio_bytes)
            try:
                with self._connect() as conn:
                    conn.execute(
                        """
                        INSERT INTO synthesis_history (
                            id, created_at, text, profile, engine, mode, seed,
                            params_json, audio_path, duration_seconds, rtf, sample_rate
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            id, created_at, text, profile, engine, mode, seed,
                            _json.dumps(params, ensure_ascii=False, default=str),
                            str(audio_path),
                            float(duration_seconds or 0.0),
                            float(rtf or 0.0),
                            int(sample_rate or 24000),
                        ),
                    )
            except Exception:
                # Roll back the audio file if the DB write failed.
                try:
                    audio_path.unlink(missing_ok=True)
                except Exception:
                    pass
                raise
            self._enforce_cap_locked()
        return id

    def delete(self, id: str) -> bool:
        with self._lock:
            row = self.get(id)
            if not row:
                return False
            try:
                Path(row["audio_path"]).unlink(missing_ok=True)
            except Exception:  # pragma: no cover - best effort
                logger.warning("voice-studio: failed unlinking %s", row["audio_path"])
            with self._connect() as conn:
                conn.execute("DELETE FROM synthesis_history WHERE id = ?", (id,))
        return True

    # ── Internal ────────────────────────────────────────────────────────

    def _enforce_cap_locked(self) -> None:
        """Caller already holds ``self._lock``."""
        with self._connect() as conn:
            stale = conn.execute(
                "SELECT id, audio_path FROM synthesis_history "
                "ORDER BY created_at DESC LIMIT -1 OFFSET ?",
                (HISTORY_CAP,),
            ).fetchall()
            for row in stale:
                try:
                    Path(row["audio_path"]).unlink(missing_ok=True)
                except Exception:
                    pass
                conn.execute("DELETE FROM synthesis_history WHERE id = ?", (row["id"],))


# ── Singleton accessor ─────────────────────────────────────────────────

_store: Optional[HistoryStore] = None


def get_history_store() -> HistoryStore:
    global _store
    if _store is None:
        _store = HistoryStore()
    return _store
