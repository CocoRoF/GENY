"""Sandbox observability — see what agents actually DID in their sandboxes.

    GET /api/sandboxes                          list session sandboxes (GAPT workspaces)
    GET /api/sandboxes/{wid}/snapshots          snapshots of one sandbox
    GET /api/sandboxes/snapshots/{sid}          one snapshot (+ activity = chat+tool trail)
    GET /api/sandboxes/snapshots/{sid}/diff     the unified diff that snapshot introduced

This is the ground-truth view: GAPT snapshots capture the agent's chat dialog,
tool calls, file diff, and stats. Surfacing them here lets an operator verify
what an agent really did (vs. what it claimed) and review a pack's build log.
"""

from __future__ import annotations

import os
from logging import getLogger
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException

from controller.auth_controller import require_auth
from service.gapt import GaptApiError, get_gapt_client

logger = getLogger(__name__)

router = APIRouter(prefix="/api/sandboxes", tags=["sandboxes"])


def _gapt():
    gc = get_gapt_client()
    if not gc.configured:
        raise HTTPException(
            status_code=412,
            detail={"code": "gapt.not_configured", "reason": "GAPT_BASE_URL is not set"},
        )
    return gc


async def _project_id(gc) -> str:
    slug = os.getenv("GENY_GAPT_PROJECT_SLUG", "geny")
    projs = await gc.list_projects(include_archived=True)
    plist = projs.get("projects", projs) if isinstance(projs, dict) else projs
    proj = next((p for p in (plist or []) if p.get("slug") == slug), None)
    if not proj:
        raise HTTPException(
            status_code=404,
            detail={"code": "sandbox.project_not_found", "reason": slug},
        )
    return proj.get("id")


def _activity_summary(act: Any) -> Dict[str, int]:
    if not isinstance(act, dict):
        return {"turns": 0, "tool_calls": 0}
    turns = act.get("turns") or []
    return {
        "turns": len(turns) if isinstance(turns, list) else 0,
        "tool_calls": sum(len(t.get("tool_uses", []) or []) for t in turns if isinstance(t, dict)),
    }


@router.get("")
async def list_sandboxes(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    """Session sandboxes (GAPT workspaces) with status + snapshot counts."""
    gc = _gapt()
    try:
        pid = await _project_id(gc)
        ws = await gc.list_workspaces(pid)
    except GaptApiError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "reason": exc.reason})
    wl = ws.get("workspaces", ws) if isinstance(ws, dict) else ws
    out: List[Dict[str, Any]] = []
    for w in wl or []:
        wid = w.get("id")
        snap_count = 0
        try:
            snaps = await gc.list_snapshots(wid)
            sl = snaps.get("snapshots", snaps) if isinstance(snaps, dict) else snaps
            snap_count = len(sl or [])
        except Exception:  # noqa: BLE001 — one workspace's snapshot read never sinks the list
            snap_count = 0
        out.append(
            {
                "id": wid,
                "name": w.get("name"),
                "status": w.get("status"),
                "snapshot_count": snap_count,
            }
        )
    return {"sandboxes": out}


@router.get("/{workspace_id}/snapshots")
async def list_workspace_snapshots(
    workspace_id: str, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    gc = _gapt()
    try:
        snaps = await gc.list_snapshots(workspace_id)
    except GaptApiError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "reason": exc.reason})
    sl = snaps.get("snapshots", snaps) if isinstance(snaps, dict) else snaps
    out = [
        {
            "id": s.get("id"),
            "kind": s.get("kind"),
            "label": s.get("label"),
            "created_at": s.get("created_at"),
            "stats": s.get("stats") or {},
            "summary": _activity_summary(s.get("activity")),
        }
        for s in (sl or [])
    ]
    return {"workspace_id": workspace_id, "snapshots": out}


@router.get("/snapshots/{snapshot_id}")
async def get_snapshot(
    snapshot_id: str, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    """One snapshot incl. its activity — the chat dialog + tool calls the agent
    ran in the sandbox (the durable record of what actually happened)."""
    gc = _gapt()
    try:
        data = await gc.snapshot_activity(snapshot_id)
    except GaptApiError as exc:
        if exc.status == 404:
            raise HTTPException(status_code=404, detail={"code": "snapshot.not_found", "reason": snapshot_id})
        raise HTTPException(status_code=502, detail={"code": exc.code, "reason": exc.reason})
    return data if isinstance(data, dict) else {"activity": data}


@router.get("/snapshots/{snapshot_id}/diff")
async def get_snapshot_diff(
    snapshot_id: str, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    gc = _gapt()
    try:
        data = await gc.snapshot_diff(snapshot_id)
    except GaptApiError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "reason": exc.reason})
    return data if isinstance(data, dict) else {"unified": str(data)}
