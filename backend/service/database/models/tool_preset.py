"""
Tool Preset Model — Database row backing a ToolPresetDefinition.

Phase 2A of the persistent-storage refactor (cycle 20260519). Stores
each ToolPresetDefinition as a row keyed by ``preset_id`` (the
user-facing UUID). The full pydantic payload lives in the ``data``
column as JSONB so new fields on ToolPresetDefinition don't require
a schema migration — the JSON parses cleanly even if the table
schema is stale.

The JSON-file ToolPresetStore continues to act as a local fallback
when Postgres is unavailable. The DB is the source of truth and the
two are reconciled at startup (``ToolPresetStore.set_database()``).
"""

from typing import Any, Dict

from service.database.models.base_model import BaseModel


class ToolPresetModel(BaseModel):
    """Persistent row for a single ToolPresetDefinition."""

    def __init__(
        self,
        preset_id: str = "",
        name: str = "",
        is_template: bool = False,
        template_name: str = "",
        data: str = "",
        **kwargs,
    ):
        super().__init__(**kwargs)
        # ``preset_id`` is the user-facing UUID (or "template-xxx") from
        # ToolPresetDefinition.id — distinct from the row's auto-incremented
        # ``id``. Carries the UNIQUE constraint so writes can UPSERT.
        self.preset_id = preset_id
        self.name = name
        self.is_template = is_template
        self.template_name = template_name
        # Full pydantic-dumped payload as a JSON string. JSONB on the
        # Postgres side; ``get_schema`` declares it as ``JSONB`` so the
        # DB validates the shape, but the Python side handles raw text
        # so this model stays portable to SQLite for tests.
        self.data = data

    def get_table_name(self) -> str:
        return "tool_presets"

    def get_schema(self) -> Dict[str, str]:
        return {
            "preset_id": "VARCHAR(255) NOT NULL",
            "name": "VARCHAR(255)",
            "is_template": "BOOLEAN DEFAULT FALSE",
            "template_name": "VARCHAR(255)",
            "data": "JSONB",
        }

    @classmethod
    def get_create_table_query(cls, db_type: str = "postgresql") -> str:
        """Add UNIQUE(preset_id) so upserts can target it."""
        base_query = super().get_create_table_query(db_type)
        constraint = ",\n            UNIQUE (preset_id)"
        idx = base_query.rfind(")")
        if idx != -1:
            return base_query[:idx] + constraint + base_query[idx:]
        return base_query

    def get_indexes(self) -> list:
        return [
            ("idx_tool_presets_preset_id", "preset_id"),
            ("idx_tool_presets_is_template", "is_template"),
        ]

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ToolPresetModel":
        return cls(
            preset_id=data.get("preset_id", ""),
            name=data.get("name", ""),
            is_template=bool(data.get("is_template", False)),
            template_name=data.get("template_name") or "",
            data=data.get("data") or "",
            **{
                k: v
                for k, v in data.items()
                if k not in ("preset_id", "name", "is_template", "template_name", "data")
            },
        )

    def __repr__(self) -> str:
        return (
            f"ToolPresetModel(id={self.id}, preset_id={self.preset_id!r}, "
            f"name={self.name!r}, is_template={self.is_template})"
        )
