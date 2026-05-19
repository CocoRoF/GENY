"""
Tool Preset Store — Postgres-SOT with JSON-file fallback.

Phase 2A of the persistent-storage refactor (cycle 20260519). The
store now uses Postgres as the source of truth and the per-preset
JSON file as a local fallback:

  - **Save** writes to DB first; the JSON file is updated on success
    or as a fallback when DB is unavailable.
  - **Load / list / exists** prefer the DB; on miss or DB outage
    they fall through to the JSON files.
  - **Delete** removes from both backends.

The directory used by the JSON fallback honours, in order of precedence:
  1. The ``storage_dir`` arg passed to the constructor.
  2. The ``GENY_TOOL_PRESETS_DIR`` env var (set by docker-compose
     to point at a named volume — survives backend rebuilds).
  3. The legacy default ``<repo>/backend/tool_presets/`` — which
     **lives on the container's writable layer** and gets wiped on
     every ``docker compose up --build``. Kept as a final fallback
     for dev workflows where the operator manually mounts the repo.

DB wiring happens at startup via ``set_database(app_db)``; before
that call the store behaves identically to the pre-Phase-2 store
(JSON files only). ``reconcile()`` is called immediately after
``set_database`` to align the two backends — DB wins on conflict.
"""

from __future__ import annotations

import json
import os
import uuid
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

from service.tool_preset.models import ToolPresetDefinition

logger = getLogger(__name__)


def _resolve_default_dir() -> Path:
    env = (os.environ.get("GENY_TOOL_PRESETS_DIR") or "").strip()
    if env:
        return Path(env)
    return Path(__file__).parent.parent.parent / "tool_presets"


class ToolPresetStore:
    """Persist and load ToolPresetDefinition objects.

    Primary storage: Postgres (``tool_presets`` table).
    Fallback storage: per-preset JSON files in the configured directory.
    """

    def __init__(self, storage_dir: Optional[Path] = None, app_db: Any = None) -> None:
        self._dir = Path(storage_dir) if storage_dir else _resolve_default_dir()
        self._dir.mkdir(parents=True, exist_ok=True)
        self._app_db = app_db
        logger.info(
            "ToolPresetStore initialised at %s (db_attached=%s)",
            self._dir,
            self._app_db is not None,
        )

    # ── DB wiring ──

    def set_database(self, app_db: Any) -> None:
        """Attach the AppDatabaseManager and reconcile both backends.

        Reconcile rules:
          - Every preset present in the DB is mirrored to disk (DB wins).
          - Every JSON preset *not* in the DB is pushed up (covers the
            case where the DB was down when the preset was created).
          - Stale JSON files for IDs that no longer exist in the DB
            are left in place — deletes are explicit, not implicit.

        Called from ``main.py`` after ``app_db.initialize_database``.
        """
        self._app_db = app_db
        logger.info("ToolPresetStore: database backend attached")
        try:
            self._reconcile()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "ToolPresetStore: reconcile failed (continuing with whatever sources are reachable): %s",
                exc,
            )

    @property
    def _db_available(self) -> bool:
        """True when the attached AppDatabaseManager has a live pool."""
        if self._app_db is None:
            return False
        try:
            return self._app_db.db_manager._is_pool_healthy()
        except Exception:
            return False

    # ── CRUD ──

    def save(self, preset: ToolPresetDefinition) -> None:
        """Save a preset to DB (primary) + JSON (fallback / mirror)."""
        preset.touch()
        db_ok = False
        if self._db_available:
            try:
                self._save_to_db(preset)
                db_ok = True
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "ToolPresetStore: DB save failed for %s, falling back to JSON: %s",
                    preset.id, exc,
                )
        # Mirror to JSON regardless — this is the disaster-recovery copy.
        self._save_to_file(preset)
        logger.info(
            "Tool preset saved: %s (%s) [db=%s, file=ok]",
            preset.name, preset.id, "ok" if db_ok else "skip",
        )

    def load(self, preset_id: str) -> Optional[ToolPresetDefinition]:
        """Prefer DB; fall back to JSON on miss or outage."""
        if self._db_available:
            try:
                preset = self._load_from_db(preset_id)
                if preset is not None:
                    return preset
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "ToolPresetStore: DB load failed for %s, trying JSON: %s",
                    preset_id, exc,
                )
        return self._load_from_file(preset_id)

    def delete(self, preset_id: str) -> bool:
        """Delete from both backends. Returns True if anything was removed."""
        db_removed = False
        if self._db_available:
            try:
                db_removed = self._delete_from_db(preset_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "ToolPresetStore: DB delete failed for %s: %s",
                    preset_id, exc,
                )

        file_removed = False
        path = self._path_for(preset_id)
        if path.exists():
            path.unlink()
            file_removed = True

        if db_removed or file_removed:
            logger.info(
                "Tool preset deleted: %s (db=%s, file=%s)",
                preset_id, db_removed, file_removed,
            )
        return db_removed or file_removed

    def list_all(self) -> List[ToolPresetDefinition]:
        """List every saved preset. Prefers DB; merges in file-only rows."""
        seen: Dict[str, ToolPresetDefinition] = {}
        if self._db_available:
            try:
                for preset in self._list_from_db():
                    seen[preset.id] = preset
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "ToolPresetStore: DB list failed, falling back to JSON: %s", exc,
                )
        # Layer in JSON-only entries (e.g. saved while DB was down). DB
        # rows already encountered keep their values; orphans on disk
        # surface so the operator can decide whether to delete them.
        for preset in self._list_from_files():
            seen.setdefault(preset.id, preset)
        return list(seen.values())

    def list_templates(self) -> List[ToolPresetDefinition]:
        return [p for p in self.list_all() if p.is_template]

    def list_user_presets(self) -> List[ToolPresetDefinition]:
        return [p for p in self.list_all() if not p.is_template]

    def exists(self, preset_id: str) -> bool:
        if self._db_available:
            try:
                if self._exists_in_db(preset_id):
                    return True
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "ToolPresetStore: DB exists() failed for %s: %s",
                    preset_id, exc,
                )
        return self._path_for(preset_id).exists()

    def clone(self, preset_id: str, new_name: str) -> Optional[ToolPresetDefinition]:
        """Clone an existing preset with a new name and ID."""
        source = self.load(preset_id)
        if not source:
            return None

        cloned = ToolPresetDefinition(
            id=str(uuid.uuid4()),
            name=new_name,
            description=source.description,
            icon=source.icon,
            custom_tools=list(source.custom_tools),
            mcp_servers=list(source.mcp_servers),
            built_in_mode=source.built_in_mode,
            built_in_tools=list(source.built_in_tools),
            built_in_deny=list(source.built_in_deny),
            is_template=False,
            template_name=None,
        )
        self.save(cloned)
        return cloned

    # ── DB helpers ──

    def _save_to_db(self, preset: ToolPresetDefinition) -> None:
        """UPSERT a preset row keyed by ``preset_id``."""
        payload = preset.model_dump_json()
        query = """
            INSERT INTO tool_presets
                (preset_id, name, is_template, template_name, data)
            VALUES (%s, %s, %s, %s, %s::jsonb)
            ON CONFLICT (preset_id)
            DO UPDATE SET
                name = EXCLUDED.name,
                is_template = EXCLUDED.is_template,
                template_name = EXCLUDED.template_name,
                data = EXCLUDED.data,
                updated_at = CURRENT_TIMESTAMP
        """
        self._app_db.db_manager.execute_insert(
            query,
            (
                preset.id,
                preset.name,
                preset.is_template,
                preset.template_name or "",
                payload,
            ),
        )

    def _load_from_db(self, preset_id: str) -> Optional[ToolPresetDefinition]:
        row = self._app_db.db_manager.execute_query_one(
            "SELECT data FROM tool_presets WHERE preset_id = %s",
            (preset_id,),
        )
        if not row:
            return None
        return _row_to_preset(row)

    def _list_from_db(self) -> List[ToolPresetDefinition]:
        rows = self._app_db.db_manager.execute_query(
            "SELECT data FROM tool_presets ORDER BY name ASC",
        )
        if not rows:
            return []
        out: List[ToolPresetDefinition] = []
        for row in rows:
            preset = _row_to_preset(row)
            if preset is not None:
                out.append(preset)
        return out

    def _delete_from_db(self, preset_id: str) -> bool:
        affected = self._app_db.db_manager.execute_update_delete(
            "DELETE FROM tool_presets WHERE preset_id = %s",
            (preset_id,),
        )
        return bool(affected and affected > 0)

    def _exists_in_db(self, preset_id: str) -> bool:
        row = self._app_db.db_manager.execute_query_one(
            "SELECT 1 FROM tool_presets WHERE preset_id = %s LIMIT 1",
            (preset_id,),
        )
        return row is not None

    # ── File helpers ──

    def _save_to_file(self, preset: ToolPresetDefinition) -> None:
        path = self._path_for(preset.id)
        path.write_text(preset.model_dump_json(indent=2), encoding="utf-8")

    def _load_from_file(self, preset_id: str) -> Optional[ToolPresetDefinition]:
        path = self._path_for(preset_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return ToolPresetDefinition(**data)
        except Exception as exc:  # noqa: BLE001
            logger.error("Failed to load tool preset %s from file: %s", preset_id, exc)
            return None

    def _list_from_files(self) -> List[ToolPresetDefinition]:
        presets: List[ToolPresetDefinition] = []
        for path in sorted(self._dir.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                presets.append(ToolPresetDefinition(**data))
            except Exception as exc:  # noqa: BLE001
                logger.warning("Skipping malformed preset file %s: %s", path.name, exc)
        return presets

    def _path_for(self, preset_id: str) -> Path:
        safe_id = "".join(c for c in preset_id if c.isalnum() or c in "-_")
        return self._dir / f"{safe_id}.json"

    # ── Reconcile ──

    def _reconcile(self) -> None:
        """Bring DB and JSON-fallback into agreement at startup.

        Strategy:
          1. Mirror every DB row to disk (DB wins on conflict).
          2. Push every JSON-only preset back into the DB (covers
             "DB was down when user created preset X" recovery).

        Deletes are NEVER implicit — orphans on either side stay.
        """
        if not self._db_available:
            logger.info("ToolPresetStore: reconcile skipped (DB unavailable)")
            return

        try:
            db_presets = {p.id: p for p in self._list_from_db()}
        except Exception as exc:  # noqa: BLE001
            logger.warning("ToolPresetStore: reconcile read from DB failed: %s", exc)
            return

        file_presets = {p.id: p for p in self._list_from_files()}

        # 1) DB → file (DB wins)
        mirrored = 0
        for preset in db_presets.values():
            try:
                self._save_to_file(preset)
                mirrored += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "ToolPresetStore: reconcile failed to mirror %s to disk: %s",
                    preset.id, exc,
                )

        # 2) File-only → DB (push up)
        pushed = 0
        for preset_id, preset in file_presets.items():
            if preset_id in db_presets:
                continue
            try:
                self._save_to_db(preset)
                pushed += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "ToolPresetStore: reconcile failed to push %s to DB: %s",
                    preset_id, exc,
                )

        logger.info(
            "ToolPresetStore: reconcile done — db_rows=%d, files=%d, mirrored=%d, pushed=%d",
            len(db_presets), len(file_presets), mirrored, pushed,
        )


def _row_to_preset(row: Any) -> Optional[ToolPresetDefinition]:
    """Decode a ``tool_presets.data`` row into a ToolPresetDefinition.

    psycopg returns JSONB as a Python dict by default; older drivers
    can hand back a string. Handle both.
    """
    if row is None:
        return None
    raw = row.get("data") if isinstance(row, dict) else row[0]
    if raw is None:
        return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.error("Failed to parse tool preset JSON from DB: %s", exc)
            return None
    try:
        return ToolPresetDefinition(**raw)
    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to instantiate ToolPresetDefinition from DB row: %s", exc)
        return None


# ── Singleton ──

_store_instance: Optional[ToolPresetStore] = None


def get_tool_preset_store() -> ToolPresetStore:
    """Return the global ToolPresetStore singleton."""
    global _store_instance
    if _store_instance is None:
        _store_instance = ToolPresetStore()
    return _store_instance
