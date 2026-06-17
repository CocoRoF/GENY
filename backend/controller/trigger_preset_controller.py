"""Trigger Preset CRUD API.

Mounts ``/api/trigger-presets`` for managing the swappable trigger
bundles consumed by :mod:`service.vtuber.thinking_trigger`. The shape
mirrors :mod:`controller.environment_controller` — list / get / create
(blank|clone|manifest_override) / patch metadata / replace manifest /
duplicate / delete — so the frontend reuses the same registry idioms.

Auth: every endpoint carries ``Depends(require_auth)`` per Geny-wide
policy.
"""

from __future__ import annotations

from logging import getLogger

from fastapi import APIRouter, Depends, HTTPException, Request

from service.auth.auth_middleware import require_auth
from service.trigger_preset.exceptions import TriggerPresetNotFoundError
from service.trigger_preset.schemas import (
    CreateTriggerPresetRequest,
    CreateTriggerPresetResponse,
    DuplicateTriggerPresetRequest,
    ReplaceManifestRequest,
    TriggerPresetDetailResponse,
    TriggerPresetListResponse,
    TriggerPresetSummaryResponse,
    UpdateTriggerPresetRequest,
)

logger = getLogger(__name__)

router = APIRouter(prefix="/api/trigger-presets", tags=["trigger-presets"])


# ── Helpers ──────────────────────────────────────────────


def _svc(request: Request):
    svc = getattr(request.app.state, "trigger_preset_service", None)
    if svc is None:
        raise HTTPException(
            status_code=503,
            detail="Trigger preset service not configured",
        )
    return svc


def _detail(record) -> TriggerPresetDetailResponse:
    return TriggerPresetDetailResponse(
        id=record.id,
        name=record.name,
        description=record.description,
        tags=list(record.tags),
        created_at=record.created_at,
        updated_at=record.updated_at,
        manifest=record.manifest,
    )


# ── Defaults / template ──────────────────────────────────


@router.get("/defaults", response_model=TriggerPresetDetailResponse)
async def get_default_manifest(auth: dict = Depends(require_auth)):
    """Return a synthetic record holding the bundled default manifest.

    Used by the "Reset to defaults" affordance in the editor and by the
    initial seed flow when the user clicks "+ 새 드래프트" — the FE
    paints the default phases / categories straight from this response
    instead of round-tripping a real preset.
    """
    from service.trigger_preset.defaults import default_manifest

    manifest = default_manifest()
    return TriggerPresetDetailResponse(
        id="__default__",
        name="기본 트리거 프리셋",
        description="현재 하드코딩된 트리거 동작과 동일한 기본값",
        tags=["builtin"],
        created_at="",
        updated_at="",
        manifest=manifest,
    )


# ── CRUD ─────────────────────────────────────────────────


@router.get("", response_model=TriggerPresetListResponse)
async def list_presets(request: Request, auth: dict = Depends(require_auth)):
    svc = _svc(request)
    summaries = svc.list_all()
    return TriggerPresetListResponse(
        presets=[TriggerPresetSummaryResponse(**s) for s in summaries],
        default_preset_id=svc.get_active_default_id(),
    )


@router.post("/{preset_id}/set-default", response_model=TriggerPresetListResponse)
async def set_default_preset(
    preset_id: str, request: Request, auth: dict = Depends(require_auth),
):
    """Designate *preset_id* as the active default — the preset used by any
    VTuber session that neither passes an explicit preset nor has one mapped on
    its environment. Returns the refreshed list so the UI can re-badge."""
    svc = _svc(request)
    try:
        svc.set_active_default(preset_id)
    except TriggerPresetNotFoundError:
        raise HTTPException(404, f"preset not found: {preset_id}")
    return TriggerPresetListResponse(
        presets=[TriggerPresetSummaryResponse(**s) for s in svc.list_all()],
        default_preset_id=svc.get_active_default_id(),
    )


@router.post("", response_model=CreateTriggerPresetResponse)
async def create_preset(
    request: Request,
    body: CreateTriggerPresetRequest,
    auth: dict = Depends(require_auth),
):
    try:
        preset_id = _svc(request).create(
            body.name,
            description=body.description,
            tags=body.tags,
            manifest=body.manifest,
            clone_from=body.clone_from,
        )
    except TriggerPresetNotFoundError as exc:
        raise HTTPException(404, f"clone_from preset not found: {exc}")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return CreateTriggerPresetResponse(id=preset_id)


@router.get("/{preset_id}", response_model=TriggerPresetDetailResponse)
async def get_preset(
    request: Request, preset_id: str, auth: dict = Depends(require_auth)
):
    record = _svc(request).get(preset_id)
    if record is None:
        raise HTTPException(404, "Trigger preset not found")
    return _detail(record)


@router.patch("/{preset_id}", response_model=TriggerPresetDetailResponse)
async def patch_preset(
    request: Request,
    preset_id: str,
    body: UpdateTriggerPresetRequest,
    auth: dict = Depends(require_auth),
):
    """Partial update — name / description / tags only.

    Pass an explicit ``null`` to keep a field as-is; ``model_dump
    (exclude_none=True)`` strips unset values before delegating.
    """
    try:
        record = _svc(request).update_metadata(
            preset_id,
            **body.model_dump(exclude_none=True),
        )
    except TriggerPresetNotFoundError:
        raise HTTPException(404, "Trigger preset not found")
    return _detail(record)


@router.put("/{preset_id}/manifest", response_model=TriggerPresetDetailResponse)
async def replace_manifest(
    request: Request,
    preset_id: str,
    body: ReplaceManifestRequest,
    auth: dict = Depends(require_auth),
):
    try:
        record = _svc(request).replace_manifest(preset_id, body.manifest)
    except TriggerPresetNotFoundError:
        raise HTTPException(404, "Trigger preset not found")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return _detail(record)


@router.post("/{preset_id}/reset", response_model=TriggerPresetDetailResponse)
async def reset_preset(
    request: Request, preset_id: str, auth: dict = Depends(require_auth)
):
    """Reset this preset's manifest to the bundled defaults."""
    try:
        record = _svc(request).reset_to_defaults(preset_id)
    except TriggerPresetNotFoundError:
        raise HTTPException(404, "Trigger preset not found")
    return _detail(record)


@router.post("/{preset_id}/duplicate", response_model=CreateTriggerPresetResponse)
async def duplicate_preset(
    request: Request,
    preset_id: str,
    body: DuplicateTriggerPresetRequest,
    auth: dict = Depends(require_auth),
):
    try:
        new_id = _svc(request).duplicate(preset_id, body.new_name)
    except TriggerPresetNotFoundError:
        raise HTTPException(404, "Trigger preset not found")
    return CreateTriggerPresetResponse(id=new_id)


@router.delete("/{preset_id}")
async def delete_preset(
    request: Request, preset_id: str, auth: dict = Depends(require_auth)
):
    if not _svc(request).delete(preset_id):
        raise HTTPException(404, "Trigger preset not found")
    return {"deleted": True}


# ── Reverse-lookup: VTuber sessions bound to this preset ──


@router.get("/{preset_id}/sessions")
async def list_preset_sessions(
    request: Request,
    preset_id: str,
    auth: dict = Depends(require_auth),
):
    """List active VTuber sessions currently using this preset.

    Read from :class:`SessionStore` — the authoritative ledger that
    captures ``trigger_preset_id`` at session create time. Mirrors the
    env-preset reverse-lookup endpoint so the FE can warn the operator
    before they delete a preset that's still in use.
    """
    if _svc(request).get(preset_id) is None:
        raise HTTPException(404, "Trigger preset not found")

    try:
        from service.sessions.store import get_session_store

        store = get_session_store()
        records = store.list_active()
    except Exception:  # noqa: BLE001 — session store unavailable in some tests
        return {"preset_id": preset_id, "sessions": [], "active_count": 0}

    matching = [
        r for r in records
        if (r.get("trigger_preset_id") or "") == preset_id
    ]
    return {
        "preset_id": preset_id,
        "active_count": len(matching),
        "sessions": [
            {
                "session_id": r.get("session_id", ""),
                "session_name": r.get("session_name"),
                "status": r.get("status"),
                "role": r.get("role"),
            }
            for r in matching
        ],
    }
