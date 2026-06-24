"""Sandbox Tool Packs REST API.

    GET    /api/sandbox-tool-packs            list (summaries)
    GET    /api/sandbox-tool-packs/{id}       full pack
    POST   /api/sandbox-tool-packs/test       run a tool spec in a workspace (pre-save check)
    POST   /api/sandbox-tool-packs            save (GAPT tool_save snapshot + persist)
    POST   /api/sandbox-tool-packs/{id}/resave  re-snapshot + update specs/skills
    PATCH  /api/sandbox-tool-packs/{id}/enabled  enable/disable (code → owner gates)
    DELETE /api/sandbox-tool-packs/{id}       delete (row + best-effort snapshot)

A pack = an independent GAPT environment (workspace restorable from a snapshot)
+ the tools whose code runs inside it + the skills documenting them.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from controller.auth_controller import require_auth
from service.gapt import GaptApiError, get_gapt_client
from service.sandbox_tool_packs import (
    PackSkill,
    SandboxToolPackDefinition,
    SandboxToolSpec,
    get_sandbox_tool_pack_store,
)
from service.sandbox_tool_packs.builder import resave_pack, save_pack, test_tool
from service.sandbox_tool_packs.store import (
    SandboxToolPackNameTaken,
    SandboxToolPackNotFound,
)

logger = getLogger(__name__)

router = APIRouter(prefix="/api/sandbox-tool-packs", tags=["sandbox-tool-packs"])


# ── shapes ───────────────────────────────────────────────────────────


class PackSummary(BaseModel):
    id: str
    name: str
    description: str
    enabled: bool
    tool_count: int
    skill_count: int
    workspace_ref: str
    snapshot_ref: str
    project_ref: str


class SavePackRequest(BaseModel):
    name: str
    description: str = ""
    project_ref: str
    workspace_ref: str
    tools: List[SandboxToolSpec]
    skills: List[PackSkill] = Field(default_factory=list)
    enabled: bool = False


class ResavePackRequest(BaseModel):
    tools: Optional[List[SandboxToolSpec]] = None
    skills: Optional[List[PackSkill]] = None
    description: Optional[str] = None


class TestToolRequest(BaseModel):
    project_ref: str
    workspace_ref: str
    spec: SandboxToolSpec
    sample_input: Dict[str, Any] = Field(default_factory=dict)
    snapshot_ref: str = ""


class EnabledRequest(BaseModel):
    enabled: bool


def _summary(p: SandboxToolPackDefinition) -> PackSummary:
    return PackSummary(
        id=p.id, name=p.name, description=p.description, enabled=p.enabled,
        tool_count=len(p.tools), skill_count=len(p.skills),
        workspace_ref=p.workspace_ref, snapshot_ref=p.snapshot_ref, project_ref=p.project_ref,
    )


def _gapt():
    gc = get_gapt_client()
    if not gc.configured:
        raise HTTPException(
            status_code=412,
            detail={"code": "gapt.not_configured", "reason": "GAPT_BASE_URL is not set"},
        )
    return gc


# ── reads ────────────────────────────────────────────────────────────


@router.get("")
async def list_packs(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    packs = get_sandbox_tool_pack_store().list_all()
    return {"packs": [_summary(p).model_dump() for p in packs]}


@router.get("/{pack_id}")
async def get_pack(pack_id: str, _auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    try:
        return get_sandbox_tool_pack_store().get(pack_id).model_dump()
    except SandboxToolPackNotFound:
        raise HTTPException(status_code=404, detail={"code": "pack.not_found", "reason": pack_id})


@router.get("/{pack_id}/activity")
async def get_pack_activity(
    pack_id: str, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    """The build log of the pack's snapshot — the agent's chat + tool trail that
    produced it (the ground truth of what actually happened in the sandbox)."""
    try:
        pack = get_sandbox_tool_pack_store().get(pack_id)
    except SandboxToolPackNotFound:
        raise HTTPException(status_code=404, detail={"code": "pack.not_found", "reason": pack_id})
    if not pack.snapshot_ref:
        return {"snapshot_ref": "", "activity": {}, "stats": {}}
    try:
        data = await _gapt().snapshot_activity(pack.snapshot_ref)
    except GaptApiError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "reason": exc.reason})
    return {"snapshot_ref": pack.snapshot_ref, **(data if isinstance(data, dict) else {"activity": data})}


@router.get("/{pack_id}/diff")
async def get_pack_diff(
    pack_id: str, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    """The unified diff the pack's snapshot introduced (what files/code it added)."""
    try:
        pack = get_sandbox_tool_pack_store().get(pack_id)
    except SandboxToolPackNotFound:
        raise HTTPException(status_code=404, detail={"code": "pack.not_found", "reason": pack_id})
    if not pack.snapshot_ref:
        return {"snapshot_ref": "", "unified": "", "truncated": False, "stats": {}}
    try:
        data = await _gapt().snapshot_diff(pack.snapshot_ref)
    except GaptApiError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "reason": exc.reason})
    return {"snapshot_ref": pack.snapshot_ref, **(data if isinstance(data, dict) else {})}


# ── test (pre-save) ──────────────────────────────────────────────────


@router.post("/test")
async def test_pack_tool(
    payload: TestToolRequest, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    try:
        return await test_tool(
            _gapt(),
            project_ref=payload.project_ref,
            workspace_ref=payload.workspace_ref,
            spec=payload.spec,
            sample_input=payload.sample_input,
            snapshot_ref=payload.snapshot_ref,
        )
    except GaptApiError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "reason": exc.reason})


# ── save / manage ────────────────────────────────────────────────────


@router.post("")
async def create_pack(
    payload: SavePackRequest, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    try:
        pack = await save_pack(
            get_sandbox_tool_pack_store(),
            _gapt(),
            name=payload.name,
            description=payload.description,
            project_ref=payload.project_ref,
            workspace_ref=payload.workspace_ref,
            tools=payload.tools,
            skills=payload.skills,
            enabled=payload.enabled,
            created_by=str(_auth.get("user_id") or _auth.get("id") or "") or None,
        )
    except SandboxToolPackNameTaken:
        raise HTTPException(status_code=409, detail={"code": "pack.name_taken", "reason": payload.name})
    except GaptApiError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "reason": exc.reason})
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "pack.invalid", "reason": str(exc)})
    return pack.model_dump()


@router.post("/{pack_id}/resave")
async def resave(
    pack_id: str, payload: ResavePackRequest, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    try:
        pack = await resave_pack(
            get_sandbox_tool_pack_store(), _gapt(),
            pack_id=pack_id, tools=payload.tools, skills=payload.skills,
            description=payload.description,
        )
    except SandboxToolPackNotFound:
        raise HTTPException(status_code=404, detail={"code": "pack.not_found", "reason": pack_id})
    except GaptApiError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "reason": exc.reason})
    return pack.model_dump()


@router.patch("/{pack_id}/enabled")
async def set_enabled(
    pack_id: str, payload: EnabledRequest, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    try:
        pack = get_sandbox_tool_pack_store().set_enabled(pack_id, payload.enabled)
    except SandboxToolPackNotFound:
        raise HTTPException(status_code=404, detail={"code": "pack.not_found", "reason": pack_id})
    return _summary(pack).model_dump()


@router.delete("/{pack_id}")
async def delete_pack(pack_id: str, _auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    store = get_sandbox_tool_pack_store()
    try:
        pack = store.get(pack_id)
    except SandboxToolPackNotFound:
        raise HTTPException(status_code=404, detail={"code": "pack.not_found", "reason": pack_id})
    # Best-effort: drop the GAPT snapshot too (never blocks the row delete).
    if pack.snapshot_ref:
        try:
            gc = get_gapt_client()
            if gc.configured:
                await gc.delete_snapshot(pack.snapshot_ref)
        except Exception:  # noqa: BLE001
            logger.warning("pack %s: snapshot %s cleanup failed", pack_id, pack.snapshot_ref)
    store.delete(pack_id)
    return {"ok": True, "pack_id": pack_id}
