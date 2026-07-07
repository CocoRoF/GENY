"""Knowledge repository API — documents in the user vault, semantically
searchable. ``/api/opsidian/knowledge/*`` (auth-scoped to the user).

Upload is fire-and-forget: the card note appears immediately with
``status=processing`` and flips to ``ready``/``failed`` — the UI polls the
document list. A missing OpenAI key returns 409 ``openai_key_missing`` so
the frontend can route the user to settings.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Path, UploadFile
from pydantic import BaseModel, Field

from service.auth.auth_middleware import require_auth
from service.knowledge import KnowledgeUnavailable, get_knowledge_service
from service.knowledge.connectors import (
    SOURCE_TYPES,
    delete_source,
    load_sources,
    run_source,
    upsert_source,
)
from service.whiteboard._task_tracker import schedule as _schedule_task

logger = getLogger(__name__)

router = APIRouter(prefix="/api/opsidian/knowledge", tags=["knowledge"])

_MAX_UPLOAD_BYTES = 50 * 1024 * 1024


class SearchRequest(BaseModel):
    query: str
    top_k: int = Field(8, ge=1, le=50)


class SourceRequest(BaseModel):
    """Continuous-collection source (api / web / db)."""

    id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=120)
    type: str
    schedule: str = "0 * * * *"  # cron; hourly default
    enabled: bool = True
    config: Dict[str, Any] = Field(default_factory=dict)


def _unavailable(exc: KnowledgeUnavailable) -> HTTPException:
    return HTTPException(
        status_code=409, detail={"code": exc.reason, "message": str(exc)},
    )


@router.get("/status")
async def knowledge_status(auth: dict = Depends(require_auth)):
    svc = get_knowledge_service(auth.get("sub", "anonymous"))
    try:
        await svc.verify_embedding()
    except KnowledgeUnavailable as exc:
        st = svc.status()
        st["embedding_ready"] = False
        st["reason"] = exc.reason
        return st
    return svc.status()


@router.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    auth: dict = Depends(require_auth),
):
    svc = get_knowledge_service(auth.get("sub", "anonymous"))
    data = await file.read()
    if len(data) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="file exceeds 50MB limit")
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    try:
        # Fail fast on config gaps BEFORE accepting the document.
        await svc.verify_embedding()
    except KnowledgeUnavailable as exc:
        raise _unavailable(exc)

    filename = file.filename or "document"

    async def _ingest():
        try:
            await svc.ingest_file(filename=filename, data=data)
        except Exception:  # noqa: BLE001 — recorded on the card by the service
            logger.warning("knowledge: background ingest failed", exc_info=True)

    _schedule_task(_ingest(), name=f"knowledge.ingest:{filename}")
    return {"accepted": True, "filename": filename, "status": "processing"}


@router.get("/documents")
async def list_documents(auth: dict = Depends(require_auth)):
    svc = get_knowledge_service(auth.get("sub", "anonymous"))
    return {"documents": await svc.list_documents()}


@router.delete("/documents/{doc_id}")
async def delete_document(
    doc_id: str = Path(...), auth: dict = Depends(require_auth),
):
    svc = get_knowledge_service(auth.get("sub", "anonymous"))
    ok = await svc.delete_document(doc_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"document not found: {doc_id}")
    return {"deleted": doc_id}


@router.post("/search")
async def search_knowledge(
    req: SearchRequest, auth: dict = Depends(require_auth),
):
    svc = get_knowledge_service(auth.get("sub", "anonymous"))
    try:
        hits = await svc.search(req.query, top_k=req.top_k)
    except KnowledgeUnavailable as exc:
        raise _unavailable(exc)
    return {"hits": hits, "total": len(hits)}


# ── continuous collection sources ────────────────────────────────────


@router.get("/sources")
async def list_knowledge_sources(auth: dict = Depends(require_auth)):
    return {"sources": load_sources(auth.get("sub", "anonymous"))}


@router.post("/sources")
async def save_knowledge_source(
    req: SourceRequest, auth: dict = Depends(require_auth),
):
    if req.type not in SOURCE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"type must be one of {list(SOURCE_TYPES)}",
        )
    try:
        from croniter import croniter

        croniter(req.schedule)
    except (ValueError, KeyError):
        raise HTTPException(
            status_code=400, detail=f"invalid cron schedule: {req.schedule!r}",
        )
    source = upsert_source(auth.get("sub", "anonymous"), req.model_dump())
    return {"source": source}


@router.delete("/sources/{source_id}")
async def delete_knowledge_source(
    source_id: str = Path(...), auth: dict = Depends(require_auth),
):
    if not delete_source(auth.get("sub", "anonymous"), source_id):
        raise HTTPException(status_code=404, detail=f"source not found: {source_id}")
    return {"deleted": source_id}


@router.post("/sources/{source_id}/run")
async def run_knowledge_source(
    source_id: str = Path(...), auth: dict = Depends(require_auth),
):
    username = auth.get("sub", "anonymous")
    svc = get_knowledge_service(username)
    try:
        await svc.verify_embedding()  # fail fast before scheduling the run
    except KnowledgeUnavailable as exc:
        raise _unavailable(exc)
    source = next(
        (s for s in load_sources(username) if s.get("id") == source_id), None,
    )
    if source is None:
        raise HTTPException(status_code=404, detail=f"source not found: {source_id}")

    async def _run():
        try:
            await run_source(username, source)
        except Exception:  # noqa: BLE001 — recorded on the source
            logger.warning("knowledge: source run failed", exc_info=True)

    _schedule_task(_run(), name=f"knowledge.collect:{source_id}")
    return {"accepted": True, "source_id": source_id, "status": "running"}
