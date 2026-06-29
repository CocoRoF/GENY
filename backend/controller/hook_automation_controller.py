"""Hooks (user automation) REST API.

A Hook is a ``CronJob`` with ``target_kind="agent_hook"`` (see
``service/hooks_runtime``). This is the UI surface — list the hooks a session
created, pause/resume, or delete them. Hooks are CREATED by the agent via the
``HookCreate`` tool when the user asks in chat, so there is intentionally NO
create endpoint here.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from service.auth.auth_middleware import require_auth

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/automations", tags=["hooks"])

_TARGET_KIND = "agent_hook"


def _store(request: Request):
    store = getattr(request.app.state, "cron_store", None)
    if store is None:
        raise HTTPException(503, "hook store not configured")
    return store


def _is_hook(job: Any) -> bool:
    return getattr(job, "target_kind", None) == _TARGET_KIND


def _next_fire(job: Any) -> Optional[str]:
    try:
        from croniter import croniter  # type: ignore[import-not-found]

        base = job.last_fired_at or job.created_at or datetime.now(timezone.utc)
        if base.tzinfo is not None:
            base = base.replace(tzinfo=None)
        nxt = croniter(job.cron_expr, base).get_next(datetime)
        return nxt.replace(tzinfo=timezone.utc).isoformat()
    except Exception:  # noqa: BLE001
        return None


def _serialize(job: Any) -> Dict[str, Any]:
    payload = getattr(job, "payload", None) or {}
    return {
        "name": job.name,
        "kind": payload.get("kind", "schedule"),
        "cron_expr": job.cron_expr,
        "status": job.status.value if hasattr(job.status, "value") else str(job.status),
        "description": job.description,
        "action_prompt": payload.get("action_prompt"),
        "session_id": payload.get("session_id"),
        "last_fired_at": job.last_fired_at.isoformat() if job.last_fired_at else None,
        "next_fire_at": _next_fire(job),
    }


class HookResponse(BaseModel):
    name: str
    kind: str
    cron_expr: str
    status: str
    description: Optional[str] = None
    action_prompt: Optional[str] = None
    session_id: Optional[str] = None
    last_fired_at: Optional[str] = None
    next_fire_at: Optional[str] = None


class StatusBody(BaseModel):
    status: str  # "enabled" | "disabled"


@router.get("", response_model=List[HookResponse])
async def list_hooks(
    request: Request,
    session_id: Optional[str] = Query(None),
    _auth: dict = Depends(require_auth),
):
    """List Hooks. When ``session_id`` is given, only that session's hooks."""
    store = _store(request)
    jobs = await store.list(only_enabled=False)
    out: List[HookResponse] = []
    for j in jobs:
        if not _is_hook(j):
            continue
        if session_id and (getattr(j, "payload", None) or {}).get("session_id") != session_id:
            continue
        out.append(HookResponse(**_serialize(j)))
    return out


@router.patch("/{name}/status", response_model=HookResponse)
async def set_hook_status(
    request: Request,
    name: str,
    body: StatusBody,
    _auth: dict = Depends(require_auth),
):
    store = _store(request)
    job = await store.get(name)
    if job is None or not _is_hook(job):
        raise HTTPException(404, f"no hook {name!r}")
    from geny_executor.cron.types import CronJobStatus

    status = CronJobStatus.ENABLED if body.status == "enabled" else CronJobStatus.DISABLED
    await store.update_status(name, status)
    runner = getattr(request.app.state, "cron_runner", None)
    if runner is not None and hasattr(runner, "refresh"):
        try:
            await runner.refresh()
        except Exception:  # noqa: BLE001
            pass
    job = await store.get(name)
    return HookResponse(**_serialize(job))


@router.delete("/{name}")
async def delete_hook(
    request: Request,
    name: str,
    _auth: dict = Depends(require_auth),
):
    store = _store(request)
    job = await store.get(name)
    if job is None or not _is_hook(job):
        raise HTTPException(404, f"no hook {name!r}")
    ok = await store.delete(name)
    return {"deleted": name, "ok": bool(ok)}
