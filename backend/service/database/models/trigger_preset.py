"""
Trigger Preset Model — Database row backing a TriggerPresetRecord.

Phase 2C of the persistent-storage refactor (cycle 20260519). Each
row stores the full :class:`TriggerPresetRecord` as JSONB and is
keyed by ``preset_id`` (the 12-char hex from
``TriggerPresetService._fresh_id``).

The JSON-file fallback under ``TRIGGER_PRESET_STORAGE_PATH`` (Phase
1) is preserved verbatim — when Postgres is unreachable the service
falls through to those files. Reconcile on startup keeps the two in
agreement (DB wins on conflict).
"""

from typing import Any, Dict

from service.database.models.base_model import BaseModel


class TriggerPresetModel(BaseModel):
    """Persistent row for one stored TriggerPresetRecord."""

    def __init__(
        self,
        preset_id: str = "",
        name: str = "",
        data: str = "",
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.preset_id = preset_id
        self.name = name
        # Full TriggerPresetRecord as JSON. JSONB on the Postgres side;
        # the service unmarshals via ``TriggerPresetRecord.model_validate``
        # so manifest-schema changes don't require table migrations.
        self.data = data

    def get_table_name(self) -> str:
        return "trigger_presets"

    def get_schema(self) -> Dict[str, str]:
        return {
            "preset_id": "VARCHAR(255) NOT NULL",
            "name": "VARCHAR(255)",
            "data": "JSONB",
        }

    @classmethod
    def get_create_table_query(cls, db_type: str = "postgresql") -> str:
        base_query = super().get_create_table_query(db_type)
        constraint = ",\n            UNIQUE (preset_id)"
        idx = base_query.rfind(")")
        if idx != -1:
            return base_query[:idx] + constraint + base_query[idx:]
        return base_query

    def get_indexes(self) -> list:
        return [
            ("idx_trigger_presets_preset_id", "preset_id"),
        ]

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TriggerPresetModel":
        return cls(
            preset_id=data.get("preset_id", ""),
            name=data.get("name", ""),
            data=data.get("data") or "",
            **{
                k: v
                for k, v in data.items()
                if k not in ("preset_id", "name", "data")
            },
        )

    def __repr__(self) -> str:
        return (
            f"TriggerPresetModel(id={self.id}, preset_id={self.preset_id!r}, "
            f"name={self.name!r})"
        )
