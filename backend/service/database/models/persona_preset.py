"""Persona Preset Model — DB row backing a reusable persona definition.

The full :class:`service.persona_presets.models.PersonaPresetDefinition` payload
lives in ``data`` (JSONB) so new persona fields never need a schema change —
same shape pattern as :class:`SandboxToolPackModel`.
"""

from typing import Any, Dict, List

from service.database.models.base_model import BaseModel


class PersonaPresetModel(BaseModel):
    """Persistent row for a single PersonaPresetDefinition."""

    def __init__(
        self,
        preset_id: str = "",
        name: str = "",
        is_template: bool = False,
        data: str = "",
        **kwargs,
    ):
        super().__init__(**kwargs)
        # User-facing id (PersonaPresetDefinition.id). UNIQUE.
        self.preset_id = preset_id
        # Preset name (UNIQUE).
        self.name = name
        # Built-in seed presets (MBTI/archetype starters) carry True.
        self.is_template = is_template
        # Full pydantic-dumped payload (model_dump_json()).
        self.data = data

    def get_table_name(self) -> str:
        return "persona_presets"

    def get_schema(self) -> Dict[str, str]:
        return {
            "preset_id": "VARCHAR(64) NOT NULL",
            "name": "VARCHAR(255) NOT NULL",
            "is_template": "BOOLEAN DEFAULT FALSE",
            "data": "JSONB",
        }

    @classmethod
    def get_create_table_query(cls, db_type: str = "postgresql") -> str:
        base_query = super().get_create_table_query(db_type)
        constraints = ",\n            UNIQUE (preset_id),\n            UNIQUE (name)"
        idx = base_query.rfind(")")
        if idx != -1:
            return base_query[:idx] + constraints + base_query[idx:]
        return base_query

    def get_indexes(self) -> List[tuple]:
        return [
            ("idx_persona_presets_preset_id", "preset_id"),
            ("idx_persona_presets_name", "name"),
        ]

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PersonaPresetModel":
        return cls(
            preset_id=data.get("preset_id", ""),
            name=data.get("name", ""),
            is_template=bool(data.get("is_template", False)),
            data=data.get("data") or "",
            **{
                k: v
                for k, v in data.items()
                if k not in ("preset_id", "name", "is_template", "data")
            },
        )

    def __repr__(self) -> str:
        return (
            f"PersonaPresetModel(id={self.id}, preset_id={self.preset_id!r}, "
            f"name={self.name!r}, is_template={self.is_template})"
        )
