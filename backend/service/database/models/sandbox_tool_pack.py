"""Sandbox Tool Pack Model — DB row backing a saved [env + tools + skills] pack.

P2 of Sandbox Tool Packs (docs/sandbox-tools). A *pack* is one installable
capability an agent built in a sandbox: an independent GAPT environment
(project + workspace, restorable from a snapshot), one-or-more tools whose code
runs *inside* that sandbox, and the skills that document how to use them.

The full :class:`service.sandbox_tool_packs.models.SandboxToolPackDefinition`
payload lives in ``data`` (JSONB) so new fields don't require a schema change —
same shape pattern as :class:`CustomToolModel` / :class:`ToolPresetModel`.
"""

from typing import Any, Dict, List

from service.database.models.base_model import BaseModel


class SandboxToolPackModel(BaseModel):
    """Persistent row for a single SandboxToolPackDefinition."""

    def __init__(
        self,
        pack_id: str = "",
        name: str = "",
        enabled: bool = False,
        workspace_ref: str = "",
        snapshot_ref: str = "",
        project_ref: str = "",
        data: str = "",
        **kwargs,
    ):
        super().__init__(**kwargs)
        # User-facing ULID (SandboxToolPackDefinition.id). UNIQUE.
        self.pack_id = pack_id
        # Pack name (UNIQUE) — tool names are namespaced under it at load time.
        self.name = name
        # Packs default OFF until the owner confirms — they are code (security).
        self.enabled = enabled
        # The pack's dedicated GAPT environment (project separation, decision G)
        # + the durable snapshot its workspace is restored from when cold.
        self.workspace_ref = workspace_ref
        self.snapshot_ref = snapshot_ref
        self.project_ref = project_ref
        # Full pydantic-dumped payload (model_dump_json()).
        self.data = data

    def get_table_name(self) -> str:
        return "sandbox_tool_packs"

    def get_schema(self) -> Dict[str, str]:
        return {
            "pack_id": "VARCHAR(64) NOT NULL",
            "name": "VARCHAR(255) NOT NULL",
            "enabled": "BOOLEAN DEFAULT FALSE",
            "workspace_ref": "VARCHAR(120) DEFAULT ''",
            "snapshot_ref": "VARCHAR(120) DEFAULT ''",
            "project_ref": "VARCHAR(120) DEFAULT ''",
            "data": "JSONB",
        }

    @classmethod
    def get_create_table_query(cls, db_type: str = "postgresql") -> str:
        base_query = super().get_create_table_query(db_type)
        constraints = ",\n            UNIQUE (pack_id),\n            UNIQUE (name)"
        idx = base_query.rfind(")")
        if idx != -1:
            return base_query[:idx] + constraints + base_query[idx:]
        return base_query

    def get_indexes(self) -> List[tuple]:
        return [
            ("idx_sandbox_tool_packs_pack_id", "pack_id"),
            ("idx_sandbox_tool_packs_name", "name"),
            ("idx_sandbox_tool_packs_enabled", "enabled"),
        ]

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SandboxToolPackModel":
        return cls(
            pack_id=data.get("pack_id", ""),
            name=data.get("name", ""),
            enabled=bool(data.get("enabled", False)),
            workspace_ref=data.get("workspace_ref", "") or "",
            snapshot_ref=data.get("snapshot_ref", "") or "",
            project_ref=data.get("project_ref", "") or "",
            data=data.get("data") or "",
            **{
                k: v
                for k, v in data.items()
                if k
                not in (
                    "pack_id", "name", "enabled", "workspace_ref",
                    "snapshot_ref", "project_ref", "data",
                )
            },
        )

    def __repr__(self) -> str:
        return (
            f"SandboxToolPackModel(id={self.id}, pack_id={self.pack_id!r}, "
            f"name={self.name!r}, enabled={self.enabled}, "
            f"workspace_ref={self.workspace_ref!r})"
        )
