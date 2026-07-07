"""
User Opsidian Controller — REST API for the personal knowledge vault.

Provides endpoints for browsing, searching, creating, updating, and
deleting structured notes in a user's personal Opsidian vault.

All endpoints require authentication and are scoped to the current user
via ``/api/opsidian/*``.
"""
from logging import getLogger
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from service.auth.auth_middleware import require_auth

logger = getLogger(__name__)

router = APIRouter(prefix="/api/opsidian", tags=["user-opsidian"])


def _schedule_note_index(username: str, filename: str, title: str, text: str) -> None:
    """Fire-and-forget: embed a user-created/edited note into the knowledge
    index so the agent's opsidian_search finds it semantically — the same
    treatment uploads/connectors get. Best-effort; never blocks the write."""
    async def _run():
        try:
            from service.knowledge import get_knowledge_service

            await get_knowledge_service(username).index_note(
                filename=filename, title=title, text=text,
            )
        except Exception:  # noqa: BLE001
            logger.debug("opsidian: note index skipped", exc_info=True)

    try:
        from service.whiteboard._task_tracker import schedule as _schedule_task

        _schedule_task(_run(), name=f"opsidian.note_index:{filename}")
    except Exception:  # noqa: BLE001
        logger.debug("opsidian: note index scheduling skipped", exc_info=True)


def _schedule_note_remove(username: str, filename: str) -> None:
    async def _run():
        try:
            from service.knowledge import get_knowledge_service

            await get_knowledge_service(username).remove_note(filename)
        except Exception:  # noqa: BLE001
            logger.debug("opsidian: note vector removal skipped", exc_info=True)

    try:
        from service.whiteboard._task_tracker import schedule as _schedule_task

        _schedule_task(_run(), name=f"opsidian.note_remove:{filename}")
    except Exception:  # noqa: BLE001
        logger.debug("opsidian: note removal scheduling skipped", exc_info=True)


# ============================================================================
# Request / Response Models
# ============================================================================

class WriteNoteRequest(BaseModel):
    title: str
    content: str
    category: str = "topics"
    tags: List[str] = Field(default_factory=list)
    importance: str = "medium"
    source: str = "user"
    links_to: List[str] = Field(default_factory=list)


class UpdateNoteRequest(BaseModel):
    content: Optional[str] = None
    tags: Optional[List[str]] = None
    importance: Optional[str] = None
    category: Optional[str] = None


class LinkNotesRequest(BaseModel):
    source_filename: str
    target_filename: str


# ============================================================================
# Helper
# ============================================================================

def _get_manager(username: str):
    """Get the UserOpsidianManager for the authenticated user."""
    from service.memory.user_opsidian import get_user_opsidian_manager
    return get_user_opsidian_manager(username)


# ============================================================================
# Endpoints — Index & Stats
# ============================================================================

@router.get("")
async def get_opsidian_index(auth: dict = Depends(require_auth)):
    """Get the user's Opsidian index and stats."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    idx = await mgr.aget_index()
    stats = await mgr.aget_stats()
    return {
        "index": idx or {"files": {}, "tag_map": {}, "total_files": 0, "total_chars": 0},
        "stats": stats,
        "username": username,
    }


@router.get("/stats")
async def get_opsidian_stats(auth: dict = Depends(require_auth)):
    """Get user Opsidian statistics."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    return await mgr.aget_stats()


@router.get("/graph")
async def get_opsidian_graph(auth: dict = Depends(require_auth)):
    """Get link graph data for visualization."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    return await mgr.aget_graph()


@router.get("/tags")
async def get_opsidian_tags(auth: dict = Depends(require_auth)):
    """Get all tags and their file counts."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    idx = await mgr.aget_index()
    if idx is None:
        return {"tags": {}}
    return {"tags": idx.get("tag_map", {})}


# ============================================================================
# Endpoints — CRUD
# ============================================================================

@router.get("/files")
async def list_opsidian_files(
    category: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    auth: dict = Depends(require_auth),
):
    """List files in the user's Opsidian vault."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    notes = await mgr.alist_notes(category=category, tag=tag)
    return {"files": notes, "total": len(notes)}


@router.get("/files/{filename:path}")
async def read_opsidian_file(
    filename: str = Path(...),
    auth: dict = Depends(require_auth),
):
    """Read a single note from the user's vault."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    result = await mgr.aread_note(filename)
    if result is None:
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")
    return result


@router.post("/files")
async def create_opsidian_file(
    req: WriteNoteRequest,
    auth: dict = Depends(require_auth),
):
    """Create a new note in the user's vault."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    filename = await mgr.awrite_note(
        title=req.title,
        content=req.content,
        category=req.category,
        tags=req.tags,
        importance=req.importance,
        source=req.source,
        links_to=req.links_to,
    )
    if filename is None:
        raise HTTPException(status_code=500, detail="Failed to create note")
    _schedule_note_index(username, filename, req.title, req.content)
    return {"filename": filename, "message": "Note created successfully"}


@router.put("/files/{filename:path}")
async def update_opsidian_file(
    req: UpdateNoteRequest,
    filename: str = Path(...),
    auth: dict = Depends(require_auth),
):
    """Update an existing note in the user's vault."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    ok = await mgr.aupdate_note(
        filename, body=req.content, tags=req.tags, importance=req.importance, category=req.category,
    )
    if not ok:
        raise HTTPException(status_code=404, detail=f"Update failed: {filename}")
    # Re-embed the edited note (title unchanged here → derive from leaf).
    _schedule_note_index(username, filename, filename.split("/")[-1], req.content or "")
    return {"filename": filename, "message": "Note updated successfully"}


@router.delete("/files/{filename:path}")
async def delete_opsidian_file(
    filename: str = Path(...),
    auth: dict = Depends(require_auth),
):
    """Delete a note from the user's vault."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    ok = await mgr.adelete_note(filename)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Delete failed: {filename}")
    _schedule_note_remove(username, filename)
    return {"message": "Note deleted successfully"}


class BatchDeleteFilesRequest(BaseModel):
    filenames: List[str] = Field(default_factory=list)


@router.post("/files/batch-delete")
async def batch_delete_opsidian_files(
    payload: BatchDeleteFilesRequest,
    auth: dict = Depends(require_auth),
):
    """Delete N notes from the user's vault in one request.

    Backs the Opsidian sidebar multi-select UX. Per-filename outcomes
    are returned so the frontend can surface "deleted 9 / 10" when
    one of the names was already gone (race with another tab) or
    points at a path that no longer resolves.

    Empty input → no-op with zero counters; never 4xx for "nothing
    to delete" so the client can call this even when the user's
    selection turned out to be empty after a confirm dialog.
    """
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)

    # Dedupe + drop empties so a stray "" in the payload doesn't try
    # to delete the vault root.
    targets: list[str] = []
    seen: set[str] = set()
    for raw in payload.filenames:
        name = (raw or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        targets.append(name)

    outcomes: list[dict] = []
    deleted = 0
    for name in targets:
        try:
            ok = await mgr.adelete_note(name)
        except Exception:  # noqa: BLE001
            ok = False
        outcomes.append({"filename": name, "deleted": bool(ok)})
        if ok:
            deleted += 1

    return {
        "requested": len(targets),
        "deleted": deleted,
        "outcomes": outcomes,
    }


# ============================================================================
# Endpoints — Search
# ============================================================================

@router.get("/search")
async def search_opsidian(
    q: str = Query(..., min_length=1),
    max_results: int = Query(10, ge=1, le=50),
    auth: dict = Depends(require_auth),
):
    """Search across the user's personal notes."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    results = await mgr.asearch(q, max_results=max_results)
    return {"query": q, "results": results, "total": len(results)}


# ============================================================================
# Endpoints — Links & Reindex
# ============================================================================

@router.post("/links")
async def create_opsidian_link(
    req: LinkNotesRequest,
    auth: dict = Depends(require_auth),
):
    """Create a wikilink between two notes."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    ok = await mgr.acreate_link(req.source_filename, req.target_filename)
    if not ok:
        raise HTTPException(status_code=404, detail="Failed to create link")
    return {"message": "Link created"}


@router.post("/reindex")
async def reindex_opsidian(auth: dict = Depends(require_auth)):
    """Rebuild the full index from disk."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    total = await mgr.areindex()
    return {"message": "Reindex complete", "total_files": total}
