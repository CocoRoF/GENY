"""
Tiny key-value SQLite store for the Voice Studio Settings page.

Data lives in the same ``GENY_VOICE_STUDIO_DATA_DIR`` as the synthesis
history (named-volume backed in prod, see docker-compose). Values are
JSON-serialized so the API can hold scalars, lists, dicts uniformly.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Optional

from .history_store import _resolve_data_dir

_SCHEMA = """
CREATE TABLE IF NOT EXISTS voice_studio_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


class SettingsStore:
    def __init__(self, data_dir: Optional[Path | str] = None) -> None:
        self.data_dir = Path(data_dir) if data_dir else _resolve_data_dir()
        self.db_path = self.data_dir / "settings.sqlite3"
        self.data_dir.mkdir(parents=True, exist_ok=True)
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

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM voice_studio_settings WHERE key = ?", (key,)
            ).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except Exception:
            return default

    def set(self, key: str, value: Any) -> None:
        payload = json.dumps(value, ensure_ascii=False, default=str)
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO voice_studio_settings (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = datetime('now')
                """,
                (key, payload),
            )

    def delete(self, key: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM voice_studio_settings WHERE key = ?", (key,))


_store: Optional[SettingsStore] = None


def get_settings_store() -> SettingsStore:
    global _store
    if _store is None:
        _store = SettingsStore()
    return _store
