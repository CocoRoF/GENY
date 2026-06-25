"""Create + test orchestration for Sandbox Tool Packs.

The agent authors tool code in a real GAPT workspace (its session workspace, or
a dedicated one), tests it, then **saves** a pack: GAPT takes a ``tool_save``
snapshot of that workspace (files + build artifacts) — the durable truth — and
Geny persists the pack row (workspace_ref + snapshot_ref + project_ref + the
tool specs + skills). On reuse the pack's :class:`PackSandboxHandle` restores
that snapshot, so the tool always runs in the exact environment it was saved in.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from service.sandbox_tool_packs.loader import PackSandboxHandle
from service.sandbox_tool_packs.models import (
    PackSkill,
    SandboxToolPackDefinition,
    SandboxToolSpec,
)

logger = logging.getLogger(__name__)


async def test_tool(
    gapt_client: Any,
    *,
    project_ref: str,
    workspace_ref: str,
    spec: SandboxToolSpec,
    sample_input: Dict[str, Any],
    snapshot_ref: str = "",
) -> Dict[str, Any]:
    """Run one tool with sample input in its workspace — the pre-save check.

    Builds the same executor ``SandboxExecTool`` a loaded pack would, bound to a
    :class:`PackSandboxHandle` for the (live) workspace, and executes it.
    """
    from geny_executor.tools.base import ToolContext  # noqa: PLC0415
    from geny_executor.tools.built_in.sandbox_exec_tool import (  # noqa: PLC0415
        SandboxExecTool,
    )

    handle = PackSandboxHandle(
        gapt_client,
        project_ref=project_ref,
        workspace_ref=workspace_ref,
        snapshot_ref=snapshot_ref,
    )
    tool = SandboxExecTool.from_dict(spec.model_dump(), sandbox=handle)
    result = await tool.execute(dict(sample_input or {}), ToolContext())
    return {
        "ok": not result.is_error,
        "is_error": result.is_error,
        "output": result.content,
        "metadata": result.metadata or {},
    }


async def save_pack(
    store: Any,
    gapt_client: Any,
    *,
    name: str,
    description: str = "",
    project_ref: str,
    workspace_ref: str,
    tools: List[SandboxToolSpec],
    skills: Optional[List[PackSkill]] = None,
    created_by: Optional[str] = None,
    enabled: bool = False,
) -> SandboxToolPackDefinition:
    """Snapshot the authoring workspace (``tool_save``, artifacts included) and
    persist the pack. Disabled by default — code, so the owner confirms first.
    """
    if not tools:
        raise ValueError("a pack must declare at least one tool")

    snap = await gapt_client.create_snapshot(
        workspace_ref,
        label=f"tool_save: {name}",
        kind="tool_save",
        include_ignored=True,
    )
    snapshot_ref = (snap or {}).get("id") if isinstance(snap, dict) else None
    if not snapshot_ref:
        raise RuntimeError(
            f"GAPT did not return a snapshot id for workspace {workspace_ref}"
        )

    # Pack names are unique. An agent that re-saves a tool (or two agents using
    # the same name) must NOT fail — append a random hash suffix so the save
    # always succeeds (self-service: forge → save just works). Resolve up-front
    # via get_by_name, and retry on the create() race with a fresh suffix.
    import secrets as _secrets
    from service.sandbox_tool_packs.store import SandboxToolPackNameTaken

    base_name = name
    try:
        if store.get_by_name(name) is not None:
            name = f"{base_name}-{_secrets.token_hex(3)}"
    except Exception:  # noqa: BLE001 — get_by_name is best-effort; create() still guards
        pass

    saved = None
    for _attempt in range(6):
        defn = SandboxToolPackDefinition(
            name=name,
            description=description,
            project_ref=project_ref,
            workspace_ref=workspace_ref,
            snapshot_ref=snapshot_ref,
            tools=list(tools),
            skills=list(skills or []),
            enabled=enabled,
            created_by=created_by,
        )
        try:
            saved = store.create(defn)
            break
        except SandboxToolPackNameTaken:
            name = f"{base_name}-{_secrets.token_hex(3)}"
    if saved is None:
        raise RuntimeError(f"could not allocate a unique pack name for {base_name!r}")
    if name != base_name:
        logger.info("pack name %r taken → saved as %r", base_name, name)
    logger.info(
        "saved sandbox tool pack name=%s id=%s snapshot=%s tools=%d",
        saved.name, saved.id, snapshot_ref, len(saved.tools),
    )
    return saved


async def resave_pack(
    store: Any,
    gapt_client: Any,
    *,
    pack_id: str,
    tools: Optional[List[SandboxToolSpec]] = None,
    skills: Optional[List[PackSkill]] = None,
    description: Optional[str] = None,
) -> SandboxToolPackDefinition:
    """Re-snapshot a pack's workspace after edits + update its specs/skills.
    Keeps id, name, project/workspace refs."""
    existing = store.get(pack_id)
    snap = await gapt_client.create_snapshot(
        existing.workspace_ref,
        label=f"tool_save: {existing.name} (update)",
        kind="tool_save",
        include_ignored=True,
    )
    snapshot_ref = (snap or {}).get("id") if isinstance(snap, dict) else None
    if not snapshot_ref:
        raise RuntimeError("GAPT did not return a snapshot id")
    existing.snapshot_ref = snapshot_ref
    if tools is not None:
        existing.tools = list(tools)
    if skills is not None:
        existing.skills = list(skills)
    if description is not None:
        existing.description = description
    return store.replace(pack_id, existing)
