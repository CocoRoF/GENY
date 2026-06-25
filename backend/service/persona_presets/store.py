"""DB-only persistence for :class:`PersonaPresetDefinition`.

Mirrors :class:`service.sandbox_tool_packs.store.SandboxToolPackStore` — UNIQUE on
``preset_id`` + ``name``, full payload in a ``data`` JSONB column, 404 / 409
exceptions for the controller.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, List, Optional

from service.persona_presets.models import PersonaPresetDefinition

logger = logging.getLogger(__name__)


class PersonaPresetNotFound(Exception):
    pass


class PersonaPresetNameTaken(Exception):
    pass


class PersonaPresetStore:
    def __init__(self, app_db: Any = None) -> None:
        self._app_db = app_db

    def set_database(self, app_db: Any) -> None:
        self._app_db = app_db

    def _require_db(self) -> Any:
        if self._app_db is None:
            raise RuntimeError(
                "PersonaPresetStore: database not attached. "
                "main.py wires it via set_database() at boot."
            )
        return self._app_db

    @staticmethod
    def _row(row: Any) -> Optional[PersonaPresetDefinition]:
        if row is None:
            return None
        payload = row["data"] if isinstance(row, dict) else row.get("data")
        if not payload:
            return None
        try:
            obj = json.loads(payload) if isinstance(payload, str) else payload
            return PersonaPresetDefinition.model_validate(obj)
        except Exception:  # noqa: BLE001
            logger.warning("PersonaPresetStore: malformed row payload — skipping")
            return None

    # ── reads ──
    def list_all(self) -> List[PersonaPresetDefinition]:
        db = self._require_db()
        rows = db.db_manager.execute_query(
            "SELECT data FROM persona_presets ORDER BY created_at ASC NULLS LAST, name ASC"
        ) or []
        return [d for r in rows if (d := self._row(r)) is not None]

    def get(self, preset_id: str) -> PersonaPresetDefinition:
        db = self._require_db()
        row = db.db_manager.execute_query_one(
            "SELECT data FROM persona_presets WHERE preset_id = %s", (preset_id,)
        )
        defn = self._row(row) if row else None
        if defn is None:
            raise PersonaPresetNotFound(preset_id)
        return defn

    def get_by_name(self, name: str) -> Optional[PersonaPresetDefinition]:
        db = self._require_db()
        row = db.db_manager.execute_query_one(
            "SELECT data FROM persona_presets WHERE name = %s", (name,)
        )
        return self._row(row) if row else None

    def exists(self, preset_id: str) -> bool:
        db = self._require_db()
        row = db.db_manager.execute_query_one(
            "SELECT 1 AS one FROM persona_presets WHERE preset_id = %s", (preset_id,)
        )
        return row is not None

    # ── writes ──
    def create(self, defn: PersonaPresetDefinition) -> PersonaPresetDefinition:
        db = self._require_db()
        if self.get_by_name(defn.name) is not None:
            raise PersonaPresetNameTaken(defn.name)
        now = datetime.now(timezone.utc).isoformat()
        defn.created_at = defn.created_at or now
        defn.updated_at = now
        db.db_manager.execute_insert(
            "INSERT INTO persona_presets (preset_id, name, is_template, data) "
            "VALUES (%s, %s, %s, %s::jsonb) RETURNING id",
            (defn.id, defn.name, defn.is_template, defn.model_dump_json()),
        )
        logger.info("PersonaPresetStore: created preset_id=%s name=%s", defn.id, defn.name)
        return defn

    def replace(self, preset_id: str, defn: PersonaPresetDefinition) -> PersonaPresetDefinition:
        db = self._require_db()
        existing = self.get(preset_id)
        if defn.name != existing.name:
            taken = self.get_by_name(defn.name)
            if taken is not None and taken.id != preset_id:
                raise PersonaPresetNameTaken(defn.name)
        defn.id = preset_id
        defn.created_at = existing.created_at
        defn.updated_at = datetime.now(timezone.utc).isoformat()
        db.db_manager.execute_update_delete(
            "UPDATE persona_presets SET name = %s, is_template = %s, data = %s::jsonb "
            "WHERE preset_id = %s",
            (defn.name, defn.is_template, defn.model_dump_json(), preset_id),
        )
        logger.info("PersonaPresetStore: updated preset_id=%s name=%s", preset_id, defn.name)
        return defn

    def save(self, defn: PersonaPresetDefinition) -> PersonaPresetDefinition:
        """Insert or replace by id — used by the template installer."""
        if self.exists(defn.id):
            return self.replace(defn.id, defn)
        return self.create(defn)

    def delete(self, preset_id: str) -> None:
        db = self._require_db()
        self.get(preset_id)  # 404 if absent
        db.db_manager.execute_update_delete(
            "DELETE FROM persona_presets WHERE preset_id = %s", (preset_id,)
        )
        logger.info("PersonaPresetStore: deleted preset_id=%s", preset_id)


_store: Optional[PersonaPresetStore] = None


def get_persona_preset_store() -> PersonaPresetStore:
    global _store
    if _store is None:
        _store = PersonaPresetStore()
    return _store
