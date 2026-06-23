"""DB-only persistence for :class:`SandboxToolPackDefinition`.

Mirrors :class:`service.custom_tools.store.CustomToolStore` — UNIQUE on
``pack_id`` + ``name``, full payload in the ``data`` JSONB column, helpful 404 /
409 exceptions for the controller. Packs default ``enabled=False`` (code →
owner confirms before any session can load them).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, List, Optional

from service.sandbox_tool_packs.models import SandboxToolPackDefinition

logger = logging.getLogger(__name__)


class SandboxToolPackNotFound(Exception):
    pass


class SandboxToolPackNameTaken(Exception):
    pass


class SandboxToolPackStore:
    def __init__(self, app_db: Any = None) -> None:
        self._app_db = app_db

    def set_database(self, app_db: Any) -> None:
        self._app_db = app_db

    def _require_db(self) -> Any:
        if self._app_db is None:
            raise RuntimeError(
                "SandboxToolPackStore: database not attached. "
                "main.py wires it via set_database() at boot."
            )
        return self._app_db

    @staticmethod
    def _row(row: Any) -> Optional[SandboxToolPackDefinition]:
        if row is None:
            return None
        payload = row["data"] if isinstance(row, dict) else row.get("data")
        if not payload:
            return None
        try:
            obj = json.loads(payload) if isinstance(payload, str) else payload
            return SandboxToolPackDefinition.model_validate(obj)
        except Exception:  # noqa: BLE001
            logger.warning("SandboxToolPackStore: malformed row payload — skipping")
            return None

    # ── reads ──
    def list_all(self) -> List[SandboxToolPackDefinition]:
        db = self._require_db()
        rows = db.db_manager.execute_query(
            "SELECT data FROM sandbox_tool_packs ORDER BY created_at ASC NULLS LAST, name ASC"
        ) or []
        return [d for r in rows if (d := self._row(r)) is not None]

    def list_enabled(self) -> List[SandboxToolPackDefinition]:
        db = self._require_db()
        rows = db.db_manager.execute_query(
            "SELECT data FROM sandbox_tool_packs WHERE enabled = TRUE "
            "ORDER BY created_at ASC NULLS LAST, name ASC"
        ) or []
        return [d for r in rows if (d := self._row(r)) is not None]

    def get(self, pack_id: str) -> SandboxToolPackDefinition:
        db = self._require_db()
        row = db.db_manager.execute_query_one(
            "SELECT data FROM sandbox_tool_packs WHERE pack_id = %s", (pack_id,)
        )
        defn = self._row(row) if row else None
        if defn is None:
            raise SandboxToolPackNotFound(pack_id)
        return defn

    def get_by_name(self, name: str) -> Optional[SandboxToolPackDefinition]:
        db = self._require_db()
        row = db.db_manager.execute_query_one(
            "SELECT data FROM sandbox_tool_packs WHERE name = %s", (name,)
        )
        return self._row(row) if row else None

    # ── writes ──
    def create(self, defn: SandboxToolPackDefinition) -> SandboxToolPackDefinition:
        db = self._require_db()
        if self.get_by_name(defn.name) is not None:
            raise SandboxToolPackNameTaken(defn.name)
        now = datetime.now(timezone.utc).isoformat()
        defn.created_at = defn.created_at or now
        defn.updated_at = now
        db.db_manager.execute_insert(
            "INSERT INTO sandbox_tool_packs "
            "(pack_id, name, enabled, workspace_ref, snapshot_ref, project_ref, data) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb) RETURNING id",
            (
                defn.id, defn.name, defn.enabled, defn.workspace_ref,
                defn.snapshot_ref, defn.project_ref, defn.model_dump_json(),
            ),
        )
        logger.info("SandboxToolPackStore: created pack_id=%s name=%s", defn.id, defn.name)
        return defn

    def replace(self, pack_id: str, defn: SandboxToolPackDefinition) -> SandboxToolPackDefinition:
        db = self._require_db()
        existing = self.get(pack_id)
        if defn.name != existing.name:
            taken = self.get_by_name(defn.name)
            if taken is not None and taken.id != pack_id:
                raise SandboxToolPackNameTaken(defn.name)
        defn.id = pack_id
        defn.created_at = existing.created_at
        defn.updated_at = datetime.now(timezone.utc).isoformat()
        db.db_manager.execute_update_delete(
            "UPDATE sandbox_tool_packs SET "
            "name = %s, enabled = %s, workspace_ref = %s, snapshot_ref = %s, "
            "project_ref = %s, data = %s::jsonb WHERE pack_id = %s",
            (
                defn.name, defn.enabled, defn.workspace_ref, defn.snapshot_ref,
                defn.project_ref, defn.model_dump_json(), pack_id,
            ),
        )
        logger.info("SandboxToolPackStore: updated pack_id=%s name=%s", pack_id, defn.name)
        return defn

    def set_enabled(self, pack_id: str, enabled: bool) -> SandboxToolPackDefinition:
        existing = self.get(pack_id)
        existing.enabled = enabled
        return self.replace(pack_id, existing)

    def delete(self, pack_id: str) -> None:
        db = self._require_db()
        self.get(pack_id)  # 404 if absent
        db.db_manager.execute_update_delete(
            "DELETE FROM sandbox_tool_packs WHERE pack_id = %s", (pack_id,)
        )
        logger.info("SandboxToolPackStore: deleted pack_id=%s", pack_id)


_store: Optional[SandboxToolPackStore] = None


def get_sandbox_tool_pack_store() -> SandboxToolPackStore:
    global _store
    if _store is None:
        _store = SandboxToolPackStore()
    return _store
