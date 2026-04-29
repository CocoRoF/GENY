"""
EnvDefaultsService — read/write the "default-for-new-env" id lists.

Lives on top of `service.database.db_config_helper` so the data
travels through the same UPSERT path as Geny's other persistent
configs. The four categories (hooks/skills/permissions/mcp_servers)
are stored as four rows under `config_name = "env_defaults"`; reads
materialise an in-memory dict for the controller's GET handler.

Concurrency model: the underlying DatabaseManager wraps writes in
its own retry decorator, and persistent_configs has a UNIQUE
constraint on (config_name, config_key) so concurrent UPSERTs from
two browser tabs land deterministically. No additional locks here.

The service degrades gracefully when the DB is unavailable —
`get_all()` returns an empty dict, mutations log + return False.
The frontend treats both as "uncurated" so the user sees their
new env with every host registration on. Re-syncing happens on
the next successful write.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from service.database.db_config_helper import get_db_config, set_db_config

logger = logging.getLogger("env-defaults-service")

CONFIG_NAME = "env_defaults"
CATEGORY = "env_management"
DATA_TYPE = "list"

# Categories supported by the host-registered + env-pickable
# pattern. Adding a new category here is a one-line change AS LONG
# AS the frontend has a corresponding picker / registry tab.
SUPPORTED_CATEGORIES: tuple[str, ...] = (
    "hooks",
    "skills",
    "permissions",
    "mcp_servers",
)


class EnvDefaultsService:
    """Thin facade over `db_config_helper` for the env-defaults rows."""

    def __init__(self, app_db: Any) -> None:
        # `app_db` is the `AppDatabaseManager` instance attached to
        # `app.state.app_db` during startup. The helper unwraps it
        # to the underlying `DatabaseManager`, so we just pass
        # through.
        self._app_db = app_db

    # ── Reads ────────────────────────────────────────────────

    def get_all(self) -> Dict[str, List[str]]:
        """Materialise every supported category as a name → id-list dict.

        Missing rows are reported as empty lists. The frontend
        decides whether an empty list means "no defaults set"
        (uncurated → wildcard at seed time) or "explicit opt-out"
        (every item off). Today the seeder uses the former
        interpretation; see the docstring on
        `seedDefaultToolLists` in the frontend store.
        """
        out: Dict[str, List[str]] = {}
        for category in SUPPORTED_CATEGORIES:
            value = get_db_config(self._app_db, CONFIG_NAME, category)
            if isinstance(value, list):
                out[category] = [str(v) for v in value]
            else:
                # Either missing, or stored as something unexpected.
                # Treat as "no defaults curated yet" rather than
                # raising — UI degrades to wildcard.
                out[category] = []
        return out

    def get(self, category: str) -> List[str]:
        """Return the id list for a single category."""
        if category not in SUPPORTED_CATEGORIES:
            raise ValueError(
                f"Unsupported env-defaults category: {category!r} "
                f"(supported: {SUPPORTED_CATEGORIES})"
            )
        value = get_db_config(self._app_db, CONFIG_NAME, category)
        if isinstance(value, list):
            return [str(v) for v in value]
        return []

    # ── Writes ───────────────────────────────────────────────

    def set(self, category: str, ids: List[str]) -> bool:
        """Replace the id list for *category* outright.

        Returns False if the DB is unavailable; the caller should
        surface that to the operator (failed save) so they don't
        think their toggles persisted when they didn't.
        """
        if category not in SUPPORTED_CATEGORIES:
            raise ValueError(
                f"Unsupported env-defaults category: {category!r}"
            )
        # Coerce + dedup while preserving insertion order so the UI
        # can rely on the read order matching the write order.
        seen: set[str] = set()
        normalised: List[str] = []
        for raw in ids:
            sid = str(raw).strip()
            if not sid or sid in seen:
                continue
            seen.add(sid)
            normalised.append(sid)
        ok = set_db_config(
            self._app_db,
            CONFIG_NAME,
            category,
            normalised,
            config_type=DATA_TYPE,
            category=CATEGORY,
        )
        if not ok:
            logger.error(
                "env_defaults: persisting category %r failed (db unavailable?)",
                category,
            )
        return ok

    def toggle(self, category: str, item_id: str) -> Optional[List[str]]:
        """Add *item_id* if absent, remove if present; return the new list.

        Returns None if the DB write fails. Idempotent within a
        single call — caller can poll `get(category)` to confirm
        the post-state if needed (no read-after-write guarantee
        across replicas, but Geny's DB pool is a single primary
        today so this is safe in practice).
        """
        current = self.get(category)
        if item_id in current:
            current = [x for x in current if x != item_id]
        else:
            current = [*current, item_id]
        ok = self.set(category, current)
        return current if ok else None

    def clear(self, category: str) -> bool:
        """Reset the row to an empty list (frontend reads as 'uncurated').

        We don't hard-delete the row because `db_config_helper`
        only exposes a delete-by-config_name primitive
        (`delete_config_group`) that would wipe every category.
        Writing `[]` is semantically equivalent — the frontend
        falls back to wildcard at seed time either way.
        """
        return self.set(category, [])


def get_env_defaults_service(request) -> Optional[EnvDefaultsService]:
    """FastAPI dependency helper.

    Returns None when `app.state.app_db` is missing (DB-disabled
    deployment). Controllers translate that into a 503 — the
    feature genuinely cannot work without persistence.
    """
    app_db = getattr(request.app.state, "app_db", None)
    if app_db is None:
        return None
    return EnvDefaultsService(app_db)
