"""Background task REST endpoints (PR-A.5.4).

Wraps the BackgroundTaskRunner + TaskRegistry surface from
geny-executor 1.1.0 as plain REST under /api/agents/{session_id}/tasks/.

Endpoints:
    POST   /api/agents/{sid}/tasks                 — create + submit
    GET    /api/agents/{sid}/tasks                 — list (status filter)
    GET    /api/agents/{sid}/tasks/{tid}           — fetch one
    DELETE /api/agents/{sid}/tasks/{tid}           — cancel
    GET    /api/agents/{sid}/tasks/{tid}/output    — stream output bytes

The session_id is currently informational — task state is
process-global (per the runner's registry). When the runner is
swapped to a per-session backend, the path can be filtered without
breaking clients.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path as FPath, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from service.auth.auth_middleware import require_auth

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agents", tags=["agent-tasks"])


# ── Schemas ──────────────────────────────────────────────────────────


class TaskCreateRequest(BaseModel):
    kind: str = Field(min_length=1, max_length=64)
    payload: Dict[str, Any] = Field(default_factory=dict)
    task_id: Optional[str] = None


class TaskCreateResponse(BaseModel):
    task_id: str
    status: str


class TaskRecordResponse(BaseModel):
    task_id: str
    kind: str
    status: str
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    error: Optional[str] = None
    payload: Dict[str, Any] = Field(default_factory=dict)
    output_path: Optional[str] = None


class TaskListResponse(BaseModel):
    tasks: List[TaskRecordResponse]


# ── Helpers ──────────────────────────────────────────────────────────


def _registry(request: Request):
    reg = getattr(request.app.state, "task_registry", None)
    if reg is None:
        raise HTTPException(503, "task_registry not configured")
    return reg


def _runner(request: Request):
    runner = getattr(request.app.state, "task_runner", None)
    if runner is None:
        raise HTTPException(503, "task_runner not configured")
    return runner


def _row_session_id(rec) -> Optional[str]:
    """The session a task belongs to — stamped into payload at create."""
    try:
        return (rec.payload or {}).get("_session_id")
    except Exception:  # noqa: BLE001
        return None


def _session_scope(session_id: str, include_linked: bool) -> set:
    """Session ids whose tasks this view may see (audit 2026-06-18, GAP E).

    The task registry is global; per-session isolation is enforced here by
    matching the ``_session_id`` stamped into each task's payload. For a
    VTuber/Sub-Worker pair the linked peer is folded in so the VTuber's
    작업 탭 also shows its sub-agent's tasks.
    """
    scope = {session_id}
    if include_linked:
        try:
            from service.sessions import get_session_store

            rec = get_session_store().get(session_id)
            linked = (rec or {}).get("linked_session_id")
            if linked:
                scope.add(linked)
        except Exception:  # noqa: BLE001 — best effort; fall back to self only
            pass
    return scope


# ── Endpoints ────────────────────────────────────────────────────────


@router.post("/{session_id}/tasks", response_model=TaskCreateResponse)
async def create_task(
    request: Request,
    body: TaskCreateRequest,
    session_id: str = FPath(..., min_length=1),
    _auth: dict = Depends(require_auth),
):
    runner = _runner(request)
    registry = _registry(request)
    from geny_executor.stages.s13_task_registry import TaskRecord

    record = TaskRecord(
        task_id=body.task_id or str(uuid.uuid4()),
        kind=body.kind,
        payload={**body.payload, "_session_id": session_id},
    )
    task_id = await runner.submit(record)
    rec = registry.get(task_id)
    return TaskCreateResponse(
        task_id=task_id,
        status=(rec.status.value if rec else "submitted"),
    )


@router.get("/{session_id}/tasks", response_model=TaskListResponse)
async def list_tasks(
    request: Request,
    session_id: str = FPath(..., min_length=1),
    status: Optional[str] = Query(None),
    kind: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=200),
    include_linked: bool = Query(
        True, description="VTuber: also include the linked Sub-Worker's tasks."
    ),
    _auth: dict = Depends(require_auth),
):
    registry = _registry(request)
    from geny_executor.stages.s13_task_registry import TaskFilter, TaskStatus

    parsed_status: Optional[TaskStatus] = None
    if status:
        try:
            parsed_status = TaskStatus(status)
        except ValueError:
            raise HTTPException(400, f"unknown status: {status}")

    # Session scoping (GAP E): the registry is global, so fetch a wide
    # window then keep only this session's (and its linked peer's) tasks
    # before applying the caller's limit.
    scope = _session_scope(session_id, include_linked)
    rows = registry.list_filtered(
        TaskFilter(status=parsed_status, kind=kind, limit=200),
    )
    scoped = [r for r in rows if _row_session_id(r) in scope][:limit]
    return TaskListResponse(
        tasks=[TaskRecordResponse(**_serialize(r)) for r in scoped],
    )


@router.get("/{session_id}/tasks/{task_id}", response_model=TaskRecordResponse)
async def get_task(
    request: Request,
    session_id: str = FPath(..., min_length=1),
    task_id: str = FPath(..., min_length=1),
    _auth: dict = Depends(require_auth),
):
    registry = _registry(request)
    rec = registry.get(task_id)
    if rec is None or _row_session_id(rec) not in _session_scope(session_id, True):
        raise HTTPException(404, "task not found")
    return TaskRecordResponse(**_serialize(rec))


@router.delete("/{session_id}/tasks/{task_id}")
async def stop_task(
    request: Request,
    session_id: str = FPath(..., min_length=1),
    task_id: str = FPath(..., min_length=1),
    _auth: dict = Depends(require_auth),
):
    registry = _registry(request)
    rec = registry.get(task_id)
    if rec is None or _row_session_id(rec) not in _session_scope(session_id, True):
        raise HTTPException(404, "task not found")

    # Already finished → nothing to stop (idempotent success).
    if getattr(rec, "is_terminal", False):
        return {"task_id": task_id, "stopped": False, "reason": "already terminal"}

    # Sub-agent (mirror) tasks run in the SubAgentManager, NOT the task runner —
    # route Stop to the manager (by sub_agent_id) and mark the mirror terminal.
    if rec.kind == "subagent":
        mgr = getattr(request.app.state, "subagent_manager", None)
        sub_agent_id = (rec.payload or {}).get("sub_agent_id")
        stopped = False
        if mgr is not None and sub_agent_id:
            try:
                stopped = bool(await mgr.stop(sub_agent_id))
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(500, f"sub-agent stop failed: {exc}")
        from geny_executor.stages.s13_task_registry import TaskStatus

        registry.update_status(task_id, TaskStatus.CANCELLED, error="stopped by user")
        return {"task_id": task_id, "stopped": stopped, "kind": "subagent"}

    runner = _runner(request)
    stopped = await runner.stop(task_id)
    if not stopped:
        raise HTTPException(404, "task not found or already terminal")
    return {"task_id": task_id, "stopped": True}


@router.get("/{session_id}/tasks/{task_id}/output")
async def stream_task_output(
    request: Request,
    session_id: str = FPath(..., min_length=1),
    task_id: str = FPath(..., min_length=1),
    _auth: dict = Depends(require_auth),
):
    registry = _registry(request)
    rec = registry.get(task_id)
    if rec is None or _row_session_id(rec) not in _session_scope(session_id, True):
        raise HTTPException(404, "task not found")

    async def gen():
        produced = False
        async for chunk in registry.stream_output(task_id):
            produced = True
            yield chunk
        # Fallback for tasks that don't stream incremental output — notably
        # sub-agent (mirror) tasks, whose result/error is stashed in payload on
        # completion (see PostgresTaskRegistryStore.update_status). Surface it so
        # the 작업 탭 Output shows what the sub-agent produced.
        if not produced:
            cur = registry.get(task_id)
            pl = (cur.payload or {}) if cur is not None else {}
            text = pl.get("result") or pl.get("error") or getattr(cur, "error", None)
            if not text and cur is not None and getattr(cur, "result", None):
                text = cur.result
            if text:
                yield (text if isinstance(text, str) else str(text)).encode("utf-8")

    # text/plain (not octet-stream) so the browser/modal shows it inline rather
    # than downloading a file.
    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")


# ── Helpers ──────────────────────────────────────────────────────────


def _serialize(rec) -> Dict[str, Any]:
    return {
        "task_id": rec.task_id,
        "kind": rec.kind,
        "status": rec.status.value,
        "created_at": rec.created_at.isoformat() if rec.created_at else None,
        "started_at": rec.started_at.isoformat() if rec.started_at else None,
        "completed_at": rec.completed_at.isoformat() if rec.completed_at else None,
        "error": rec.error,
        "payload": dict(rec.payload or {}),
        "output_path": rec.output_path,
    }
