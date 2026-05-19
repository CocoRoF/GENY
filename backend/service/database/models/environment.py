"""
Environment Model — Database row backing a stored environment manifest.

Phase 2B of the persistent-storage refactor (cycle 20260519). Each
row stores the full :class:`EnvironmentManifest` v2 record (or v0.7.x
``snapshot`` payload, for legacy imports) as JSONB. ``env_id`` is the
user-facing 12-char hex (or ``template-*`` for built-in templates)
and carries the UNIQUE constraint so the store can UPSERT.

The JSON-file fallback under ``ENVIRONMENT_STORAGE_PATH`` (Phase 1)
is preserved verbatim — when Postgres is down the EnvironmentService
falls through to those files. Reconcile on startup keeps the two
backends in lockstep (DB wins on conflict).
"""

from typing import Any, Dict

from service.database.models.base_model import BaseModel


class EnvironmentModel(BaseModel):
    """Persistent row for one stored EnvironmentManifest record."""

    def __init__(
        self,
        env_id: str = "",
        name: str = "",
        is_template: bool = False,
        data: str = "",
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.env_id = env_id
        self.name = name
        # Built-in templates use the ``template-*`` id prefix. Lifted
        # into a column so the controller can filter without parsing
        # every JSONB blob.
        self.is_template = is_template
        # Full environment record as JSON text. JSONB on the Postgres
        # side. ``EnvironmentService._summarize`` reads this and builds
        # the UI summary in Python so the table stays forward-compat
        # with manifest-schema changes.
        self.data = data

    def get_table_name(self) -> str:
        return "environments"

    def get_schema(self) -> Dict[str, str]:
        return {
            "env_id": "VARCHAR(255) NOT NULL",
            "name": "VARCHAR(255)",
            "is_template": "BOOLEAN DEFAULT FALSE",
            "data": "JSONB",
        }

    @classmethod
    def get_create_table_query(cls, db_type: str = "postgresql") -> str:
        base_query = super().get_create_table_query(db_type)
        constraint = ",\n            UNIQUE (env_id)"
        idx = base_query.rfind(")")
        if idx != -1:
            return base_query[:idx] + constraint + base_query[idx:]
        return base_query

    def get_indexes(self) -> list:
        return [
            ("idx_environments_env_id", "env_id"),
            ("idx_environments_is_template", "is_template"),
        ]

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "EnvironmentModel":
        return cls(
            env_id=data.get("env_id", ""),
            name=data.get("name", ""),
            is_template=bool(data.get("is_template", False)),
            data=data.get("data") or "",
            **{
                k: v
                for k, v in data.items()
                if k not in ("env_id", "name", "is_template", "data")
            },
        )

    def __repr__(self) -> str:
        return (
            f"EnvironmentModel(id={self.id}, env_id={self.env_id!r}, "
            f"name={self.name!r}, is_template={self.is_template})"
        )
