"""
Custom Tool Model — DB row backing a user-defined tool.

PR #2 of the Custom Tools rollout (cycle 20260525_1). Stores each
:class:`service.custom_tools.models.CustomToolDefinition` as a row keyed
by the user-facing ``tool_id`` (ULID). The full pydantic payload lives
in the ``data`` column as JSONB so new fields on
``CustomToolDefinition`` don't require a schema migration.

Same shape pattern as ``ToolPresetModel`` — pinned UNIQUE on the
user-facing id, JSON blob for the payload, indexed on ``enabled`` for
the boot-time roster load.

The store layer (``service.custom_tools.store``) is the only consumer.
ToolLoader pulls registered tools from the store at boot and wires them
into the loader via per-kind adapters (HTTP / MCP-proxy / builtin
alias). UI does CRUD via ``custom_tools_controller``.
"""

from typing import Any, Dict, List

from service.database.models.base_model import BaseModel


class CustomToolModel(BaseModel):
    """Persistent row for a single CustomToolDefinition."""

    def __init__(
        self,
        tool_id: str = "",
        name: str = "",
        backend_kind: str = "",
        enabled: bool = True,
        is_sample: bool = False,
        data: str = "",
        **kwargs,
    ):
        super().__init__(**kwargs)
        # ``tool_id`` is the user-facing ULID from
        # ``CustomToolDefinition.id``. Carries the UNIQUE constraint.
        self.tool_id = tool_id
        # ``name`` is the LLM-visible tool name. Must also be unique
        # because two tools with the same name would collide in the
        # ToolLoader registry — enforced at the store layer.
        self.name = name
        # ``backend_kind`` mirrors :class:`CustomToolDefinition.backend_kind`
        # — 'http' | 'mcp_proxy' | 'builtin_alias'. Indexed for the
        # admin-UI grouping query.
        self.backend_kind = backend_kind
        self.enabled = enabled
        # Marks tools that ship with Geny as samples (Phase D will seed
        # the blog_agent_* family here). Sample rows are immutable from
        # the UI's perspective — users can disable / duplicate / fork
        # but not edit in place.
        self.is_sample = is_sample
        # Full pydantic-dumped payload (CustomToolDefinition.model_dump_json()).
        self.data = data

    def get_table_name(self) -> str:
        return "custom_tools"

    def get_schema(self) -> Dict[str, str]:
        return {
            "tool_id": "VARCHAR(64) NOT NULL",
            "name": "VARCHAR(255) NOT NULL",
            "backend_kind": "VARCHAR(32) NOT NULL",
            "enabled": "BOOLEAN DEFAULT TRUE",
            "is_sample": "BOOLEAN DEFAULT FALSE",
            "data": "JSONB",
        }

    @classmethod
    def get_create_table_query(cls, db_type: str = "postgresql") -> str:
        """Add UNIQUE(tool_id) and UNIQUE(name) so upserts target both."""
        base_query = super().get_create_table_query(db_type)
        constraints = (
            ",\n            UNIQUE (tool_id)"
            ",\n            UNIQUE (name)"
        )
        idx = base_query.rfind(")")
        if idx != -1:
            return base_query[:idx] + constraints + base_query[idx:]
        return base_query

    def get_indexes(self) -> List[tuple]:
        return [
            ("idx_custom_tools_tool_id", "tool_id"),
            ("idx_custom_tools_name", "name"),
            ("idx_custom_tools_enabled", "enabled"),
            ("idx_custom_tools_kind", "backend_kind"),
        ]

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CustomToolModel":
        return cls(
            tool_id=data.get("tool_id", ""),
            name=data.get("name", ""),
            backend_kind=data.get("backend_kind", ""),
            enabled=bool(data.get("enabled", True)),
            is_sample=bool(data.get("is_sample", False)),
            data=data.get("data") or "",
            **{
                k: v
                for k, v in data.items()
                if k not in (
                    "tool_id", "name", "backend_kind", "enabled",
                    "is_sample", "data",
                )
            },
        )

    def __repr__(self) -> str:
        return (
            f"CustomToolModel(id={self.id}, tool_id={self.tool_id!r}, "
            f"name={self.name!r}, kind={self.backend_kind!r}, "
            f"enabled={self.enabled}, sample={self.is_sample})"
        )
