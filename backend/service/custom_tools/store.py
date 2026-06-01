"""Custom Tool Store — DB-backed CRUD.

Stores :class:`CustomToolDefinition` rows in the ``custom_tools`` table.
Unlike ``ToolPresetStore`` there is **no JSON-file fallback** — custom
tools are operator-edited DB rows and the DB is the only source of
truth. A DB outage means the registry is unavailable for that boot;
the loader falls back to the filesystem-only ``tools/built_in`` +
``tools/custom`` roster (which is the pre-Custom-Tools behaviour).

The hot path is the boot-time ``list_enabled()`` call from
:class:`ToolLoader`. CRUD endpoints (``custom_tools_controller``) and
the in-process registry hot-reload also go through this store.
"""

from __future__ import annotations

import json
from logging import getLogger
from typing import Any, List, Optional

from service.custom_tools.models import CustomToolDefinition
from service.database.models.custom_tool import CustomToolModel

logger = getLogger(__name__)


class CustomToolNotFound(Exception):
    """Lookup miss — controller maps to 404."""


class CustomToolNameTaken(Exception):
    """Name collision with another DB row — controller maps to 409."""


class CustomToolStore:
    """DB-only persistence for :class:`CustomToolDefinition`.

    Methods raise :class:`CustomToolNotFound` and
    :class:`CustomToolNameTaken` so the controller maps them to HTTP
    404 / 409 without leaking SQL detail to the API surface.
    """

    def __init__(self, app_db: Any = None) -> None:
        self._app_db = app_db

    def set_database(self, app_db: Any) -> None:
        self._app_db = app_db

    # ── helpers ──

    def _require_db(self) -> Any:
        if self._app_db is None:
            raise RuntimeError(
                "CustomToolStore: database not attached. "
                "main.py wires it via set_database() at boot."
            )
        return self._app_db

    @staticmethod
    def _row_to_definition(row: Any) -> Optional[CustomToolDefinition]:
        # execute_query_one / execute_query return RealDictRow which
        # exposes both mapping and column-name attribute access. The
        # ``data`` column is JSONB so psycopg may return a dict or
        # a str depending on version — handle both.
        if row is None:
            return None
        payload = row["data"] if isinstance(row, dict) else row.get("data")
        if not payload:
            return None
        try:
            obj = json.loads(payload) if isinstance(payload, str) else payload
            return CustomToolDefinition.model_validate(obj)
        except Exception:  # noqa: BLE001
            logger.warning(
                "CustomToolStore: malformed row payload — skipping",
            )
            return None

    # ── CRUD ──

    def list_all(self) -> List[CustomToolDefinition]:
        """Return every custom tool definition (enabled + disabled)."""
        db = self._require_db()
        rows = db.db_manager.execute_query(
            "SELECT data FROM custom_tools "
            "ORDER BY is_sample DESC, created_at ASC",
        ) or []
        return [
            d for row in rows if (d := self._row_to_definition(row)) is not None
        ]

    def list_enabled(self) -> List[CustomToolDefinition]:
        """Return only enabled tools (the boot-time loader subset)."""
        db = self._require_db()
        rows = db.db_manager.execute_query(
            "SELECT data FROM custom_tools WHERE enabled = TRUE "
            "ORDER BY is_sample DESC, created_at ASC",
        ) or []
        return [
            d for row in rows if (d := self._row_to_definition(row)) is not None
        ]

    def get(self, tool_id: str) -> CustomToolDefinition:
        db = self._require_db()
        row = db.db_manager.execute_query_one(
            "SELECT data FROM custom_tools WHERE tool_id = %s",
            (tool_id,),
        )
        if not row:
            raise CustomToolNotFound(tool_id)
        defn = self._row_to_definition(row)
        if defn is None:
            raise CustomToolNotFound(tool_id)
        return defn

    def get_by_name(self, name: str) -> Optional[CustomToolDefinition]:
        db = self._require_db()
        row = db.db_manager.execute_query_one(
            "SELECT data FROM custom_tools WHERE name = %s",
            (name,),
        )
        if not row:
            return None
        return self._row_to_definition(row)

    def create(self, defn: CustomToolDefinition) -> CustomToolDefinition:
        """Insert. Raises :class:`CustomToolNameTaken` on name collision."""
        db = self._require_db()
        # Collision check before insert so the API reply is helpful;
        # the UNIQUE constraint catches the race if two creates land
        # simultaneously.
        existing = self.get_by_name(defn.name)
        if existing is not None:
            raise CustomToolNameTaken(defn.name)

        from datetime import datetime, timezone
        defn.updated_at = datetime.now(timezone.utc)
        payload = defn.model_dump_json()
        # execute_insert calls cur.fetchone() after the write — psycopg3
        # raises ProgrammingError unless the statement actually produces
        # rows, so we need an explicit RETURNING clause.
        db.db_manager.execute_insert(
            "INSERT INTO custom_tools "
            "(tool_id, name, backend_kind, enabled, is_sample, data) "
            "VALUES (%s, %s, %s, %s, %s, %s::jsonb) "
            "RETURNING id",
            (
                defn.id, defn.name, defn.backend_kind,
                defn.enabled, defn.is_sample, payload,
            ),
        )
        logger.info(
            "CustomToolStore: created tool_id=%s name=%s kind=%s",
            defn.id, defn.name, defn.backend_kind,
        )
        return defn

    def replace(self, tool_id: str, defn: CustomToolDefinition) -> CustomToolDefinition:
        """Update an existing row in place. Preserves ``id`` and ``is_sample``."""
        db = self._require_db()
        existing = self.get(tool_id)  # 404 if not present

        # Name collisions are OK if the row keeping the name is the
        # one being edited.
        if defn.name != existing.name:
            taken = self.get_by_name(defn.name)
            if taken is not None and taken.id != tool_id:
                raise CustomToolNameTaken(defn.name)

        # Pin immutable fields.
        defn.id = tool_id
        defn.is_sample = existing.is_sample
        from datetime import datetime, timezone
        defn.created_at = existing.created_at
        defn.updated_at = datetime.now(timezone.utc)

        payload = defn.model_dump_json()
        db.db_manager.execute_update_delete(
            "UPDATE custom_tools SET "
            "name = %s, backend_kind = %s, enabled = %s, data = %s::jsonb "
            "WHERE tool_id = %s",
            (
                defn.name, defn.backend_kind, defn.enabled,
                payload, tool_id,
            ),
        )
        logger.info(
            "CustomToolStore: updated tool_id=%s name=%s", tool_id, defn.name,
        )
        return defn

    def delete(self, tool_id: str) -> None:
        """Remove a tool. Samples can be deleted by an operator."""
        db = self._require_db()
        existing = self.get(tool_id)  # 404 if not present
        db.db_manager.execute_update_delete(
            "DELETE FROM custom_tools WHERE tool_id = %s",
            (tool_id,),
        )
        logger.info(
            "CustomToolStore: deleted tool_id=%s name=%s",
            tool_id, existing.name,
        )

    def set_enabled(self, tool_id: str, enabled: bool) -> CustomToolDefinition:
        """Cheap UPDATE for the disable / enable toggle."""
        db = self._require_db()
        existing = self.get(tool_id)
        existing.enabled = enabled
        from datetime import datetime, timezone
        existing.updated_at = datetime.now(timezone.utc)
        payload = existing.model_dump_json()
        db.db_manager.execute_update_delete(
            "UPDATE custom_tools SET enabled = %s, data = %s::jsonb "
            "WHERE tool_id = %s",
            (enabled, payload, tool_id),
        )
        return existing


_singleton: Optional[CustomToolStore] = None


def get_custom_tool_store() -> CustomToolStore:
    """Process-wide singleton. ``main.py`` calls ``set_database`` once."""
    global _singleton
    if _singleton is None:
        _singleton = CustomToolStore()
    return _singleton
