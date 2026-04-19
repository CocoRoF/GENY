"""Stage / artifact catalog REST surface — port of web ``/api/catalog``.

Mounts 5 read-only endpoints consumed by the Environment Builder UI:

  GET  /api/catalog/stages
  GET  /api/catalog/stages/{order}
  GET  /api/catalog/stages/{order}/artifacts
  GET  /api/catalog/stages/{order}/artifacts/{name}
  GET  /api/catalog/full

Everything is session-less — answers come from importable stage modules
and process-wide ``lru_cache`` slots on ``ArtifactService``. Auth still
applies (Geny-wide ``require_auth``).
"""

from __future__ import annotations

from logging import getLogger

from fastapi import APIRouter, Depends, HTTPException, Request

from service.artifact.schemas import (
    ArtifactListResponse,
    FullCatalogResponse,
    StageListResponse,
)
from service.artifact.service import ArtifactError, ArtifactService
from service.auth.auth_middleware import require_auth

logger = getLogger(__name__)

router = APIRouter(prefix="/api/catalog", tags=["catalog"])


def _service(request: Request) -> ArtifactService:
    svc = getattr(request.app.state, "artifact_service", None)
    if svc is None:
        raise HTTPException(
            status_code=503,
            detail="Artifact service not configured",
        )
    return svc


@router.get("/stages", response_model=StageListResponse)
async def list_stages(
    request: Request, auth: dict = Depends(require_auth)
) -> StageListResponse:
    """Return the 16-stage summary list with per-stage artifact counts."""
    service = _service(request)
    insps = service.full_introspection()
    stages = []
    for insp in insps:
        artifacts = service.list_for_stage(insp.order)
        stages.append(
            {
                "order": insp.order,
                "module": insp.stage,
                "name": insp.name,
                "category": insp.category,
                "default_artifact": insp.artifact,
                "artifact_count": len(artifacts),
            }
        )
    return StageListResponse(stages=stages)


@router.get("/stages/{order}")
async def describe_stage(
    request: Request, order: int, auth: dict = Depends(require_auth)
) -> dict:
    """Return the default artifact's full introspection for *order*."""
    service = _service(request)
    try:
        insp = next((i for i in service.full_introspection() if i.order == order), None)
        if insp is None:
            raise ArtifactError(f"Unknown stage order: {order}")
        return insp.to_dict()
    except ArtifactError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/stages/{order}/artifacts", response_model=ArtifactListResponse)
async def list_artifacts_route(
    request: Request, order: int, auth: dict = Depends(require_auth)
) -> ArtifactListResponse:
    """Return every artifact available for *order*."""
    try:
        artifacts = _service(request).list_for_stage(order)
    except ArtifactError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return ArtifactListResponse(
        stage=artifacts[0].stage if artifacts else "",
        artifacts=[a.to_dict() for a in artifacts],
    )


@router.get("/stages/{order}/artifacts/{name}")
async def describe_artifact_route(
    request: Request, order: int, name: str, auth: dict = Depends(require_auth)
) -> dict:
    """Return the full introspection for one specific (order, artifact)."""
    try:
        insp = _service(request).describe_artifact_full(order, name)
    except ArtifactError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return insp.to_dict()


@router.get("/full", response_model=FullCatalogResponse)
async def full_catalog(
    request: Request, auth: dict = Depends(require_auth)
) -> FullCatalogResponse:
    """Return the default-artifact introspection for every stage."""
    insps = _service(request).full_introspection()
    return FullCatalogResponse(stages=[i.to_dict() for i in insps])
