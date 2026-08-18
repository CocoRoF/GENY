"""
Memory Controller — REST API for structured memory management.

All endpoints are scoped to a session via ``/api/agents/{session_id}/memory``
and call the executor's ``MemoryProvider`` directly. The legacy host-side
``SessionMemoryManager`` facade is no longer touched here — we go through
the provider's typed handles (``stm()`` / ``ltm()`` / ``notes()`` /
``vector()`` / ``index()``) for every operation.
"""

import json
import re
from logging import getLogger
from pathlib import Path as FsPath
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import FileResponse

from pydantic import BaseModel, Field

from service.auth.auth_middleware import require_auth

from service.executor import get_agent_session_manager

logger = getLogger(__name__)

router = APIRouter(prefix="/api/agents", tags=["memory"])


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
    links_to: Optional[List[str]] = None


class LinkNotesRequest(BaseModel):
    source_filename: str
    target_filename: str


class SearchRequest(BaseModel):
    query: str
    max_results: int = 10
    category: Optional[str] = None
    tag: Optional[str] = None


# ============================================================================
# Helpers
# ============================================================================

def _get_provider(session_id: str):
    """Return the live `MemoryProvider` for a session, raising 404 when
    the session doesn't exist or hasn't initialised the provider yet.
    """
    agent_manager = get_agent_session_manager()
    agent = agent_manager.get_agent(session_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    provider = getattr(agent, "memory_provider", None)
    if provider is None:
        raise HTTPException(status_code=503, detail="Memory provider not initialized")
    return provider


def _get_provider_and_memory_dir(session_id: str):
    """Return ``(provider, memory_dir)`` for the session.

    ``memory_dir`` is the on-disk root for the session's notes/index.
    Used by routes that need the dms shard helpers in
    ``service.memory.note_utils`` (which deep-walk
    ``<memory_dir>/dms/`` to produce rows the executor's flat scan
    misses).
    """
    agent_manager = get_agent_session_manager()
    agent = agent_manager.get_agent(session_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    provider = getattr(agent, "memory_provider", None)
    if provider is None:
        raise HTTPException(status_code=503, detail="Memory provider not initialized")
    mgr = getattr(agent, "memory_manager", None) or getattr(
        agent, "_memory_manager", None,
    )
    memory_dir = (
        getattr(mgr, "_memory_dir", None) if mgr is not None else None
    )
    if memory_dir is None:
        # Fallback: storage_path/memory — matches SessionMemoryManager.__init__.
        storage = getattr(agent, "storage_path", None) or getattr(
            agent, "_storage_path", None,
        )
        if storage is not None:
            from pathlib import Path
            memory_dir = Path(storage) / "memory"
    return provider, memory_dir


def _importance_value(importance: str):
    """Coerce a string importance into the executor's ``Importance``
    enum; falls back to ``MEDIUM`` for unknown values.
    """
    from geny_executor.memory.provider import Importance

    try:
        return Importance(str(importance).lower())
    except ValueError:
        return Importance.MEDIUM


# ============================================================================
# Endpoints — Index & Stats
# ============================================================================

@router.get("/{session_id}/memory")
async def get_memory_index(request: Request, session_id: str = Path(...)):
    """Return the in-memory index snapshot + simple counts.

    The on-disk root ``_index.json`` is a *bounded* folder-tree summary
    (executor 1.21.0). For per-note metadata callers must drill into a
    category shard; this endpoint returns the in-memory ``snapshot()``
    payload (`files` / `tag_map` / `link_graph`) for backwards
    compatibility with existing UI consumers.
    """
    from service.memory.note_utils import aget_index_snapshot_with_dms
    provider, memory_dir = _get_provider_and_memory_dir(session_id)
    snap = await aget_index_snapshot_with_dms(provider, memory_dir)
    files = snap.get("files") or {}
    return {
        "index": snap if files or "files" in snap else {
            "files": {}, "tag_map": {}, "total_files": 0, "total_chars": 0,
        },
        "stats": {
            "total_files": int(snap.get("total_files", len(files)) or 0),
            "total_chars": int(snap.get("total_chars", 0) or 0),
        },
    }


@router.get("/{session_id}/memory/stats")
async def get_memory_stats(request: Request, session_id: str = Path(...)):
    """Memory statistics — totals + per-category counts."""
    from service.memory.note_utils import aget_index_snapshot_with_dms
    provider, memory_dir = _get_provider_and_memory_dir(session_id)
    snap = await aget_index_snapshot_with_dms(provider, memory_dir)
    files = snap.get("files") or {}
    by_cat: Dict[str, int] = {}
    for entry in files.values():
        cat = entry.get("category") or "root"
        by_cat[cat] = by_cat.get(cat, 0) + 1
    return {
        "total_files": int(snap.get("total_files", len(files)) or 0),
        "total_chars": int(snap.get("total_chars", 0) or 0),
        "categories": by_cat,
    }


@router.get("/{session_id}/memory/tags")
async def get_memory_tags(request: Request, session_id: str = Path(...)):
    """All tags in use + their note counts."""
    provider = _get_provider(session_id)
    counts = await provider.index().tag_counts()
    return {"tags": counts}


@router.get("/{session_id}/memory/graph/around")
async def memory_graph_around(
    request: Request,
    session_id: str = Path(...),
    node: List[str] = Query(default_factory=list, description="seed note ids"),
    day: Optional[str] = Query(None, description="seed with a day's notes"),
    kind: Optional[str] = Query(None),
    depth: int = Query(1, ge=1, le=3),
    max_nodes: int = Query(300, ge=1, le=2000),
):
    """The graph around a selection, bounded.

    The whole-vault graph is not a view — it is a download: 5,384 nodes and
    4.3 MB of JSON for one screen, every time the tab is opened. This asks
    the same question at the scale a screen is read at, and says so when it
    had to stop (``truncated``).

    Seeds are note ids, or every note on a ``day`` — which is what the
    sidebar has in hand when a day is expanded.
    """
    provider = _get_provider(session_id)
    catalog = _vault_catalog(provider)
    if catalog is None:
        raise HTTPException(status_code=501, detail="No catalogue for this store")
    seeds = list(node)
    if day:
        rows = await catalog.catalog_page(day=day, kind=kind, limit=max_nodes)
        seeds += [r["id"] for r in rows]
    if not seeds:
        return {"nodes": [], "edges": [], "truncated": False}
    out = await catalog.neighbourhood(seeds, depth=depth, max_nodes=max_nodes)
    # The index stores importance as a ranking WEIGHT; a reader colouring by
    # importance needs the LABEL. Deriving it here — next to the module that
    # defines the scale — keeps clients from carrying a second copy of the
    # mapping, which is the copy that drifts. (A client that read the weight
    # as a label is exactly what broke the graph tab on 2026-08-18.)
    from service.memory.synapse_handle import importance_label

    for node in out.get("nodes", []):
        node["importance_label"] = importance_label(node.get("importance"))
    return out


@router.get("/{session_id}/memory/graph")
async def get_memory_graph(request: Request, session_id: str = Path(...)):
    """Knowledge graph snapshot — the WHOLE vault.

    Kept for compatibility and for small vaults. On a real one it is a
    download rather than a view (5,384 nodes / 4.3 MB measured), so callers
    that render a screen should ask ``/memory/graph/around`` with a seed.

    Uses the shared ``build_graph_from_index`` projector — the SAME builder the
    user/curated Opsidian graphs use — so every surface renders identically and
    returns the rich ``MemoryGraphResponse`` shape the UI expects (the old thin
    ``nodes:[filename]`` shape mismatched ``MemoryGraphNode[]``). Edges: wikilink
    + de-clumped IDF-tag now; any executor-derived semantic edges (Phase 2) flow
    through automatically once the snapshot carries an ``edges`` list.
    """
    from service.memory.note_utils import build_graph_from_index, fetch_provider_edges
    provider = _get_provider(session_id)
    try:
        snapshot = await provider.index().snapshot()
    except Exception:  # noqa: BLE001
        snapshot = {}
    snapshot = snapshot or {}
    idx: Dict[str, Any] = {"files": snapshot.get("files", {}) or {}}
    edges = await fetch_provider_edges(provider)
    if edges is not None:
        idx["edges"] = edges
    elif snapshot.get("edges"):
        idx["edges"] = snapshot["edges"]
    return build_graph_from_index(idx)


@router.get("/{session_id}/memory/summary")
async def get_memory_summary(request: Request, session_id: str = Path(...)):
    """The session's compressed-first view: the rolling DIGEST (always-injected
    Stage-2 L1) + the durable EVERGREEN (always-injected pinned critical).

    The rolling digest lives at ``transcripts/summary.md`` — outside the
    ``memory/`` note tree the other endpoints read — so it is otherwise invisible
    in Opsidian. This surfaces both compressed tiers for the viewer.
    """
    provider = _get_provider(session_id)
    digest = ""
    evergreen = ""
    try:
        digest = (await provider.stm().read_summary()) or ""
    except Exception:  # noqa: BLE001
        digest = ""
    try:
        evergreen = (
            await provider.notes().load_pinned(category="critical", max_chars=8000)
        ) or ""
    except Exception:  # noqa: BLE001
        evergreen = ""
    return {
        "digest": digest,
        "evergreen": evergreen,
        "has_digest": bool(digest.strip()),
        "has_evergreen": bool(evergreen.strip()),
    }


# ============================================================================
# Endpoints — CRUD
# ============================================================================

def _vault_catalog(provider):
    """The index handle, when it can answer catalogue questions.

    Returns None for stores without the API — the caller then falls back to
    the note-walking path, which is correct but expensive.
    """
    vector = provider.vector() if hasattr(provider, "vector") else None
    return vector if vector is not None and hasattr(vector, "catalog_counts") else None


@router.get("/{session_id}/memory/overview")
async def memory_overview(
    request: Request,
    session_id: str = Path(...),
    kind: Optional[str] = Query(None, description="한 범주로 좁히기"),
):
    """How much is in the vault, and on which days — nothing more.

    The first thing a sidebar needs is a number, and the note store answers
    that by parsing every file (3.2s and 4.8MB of bodies held, measured on a
    5,384-note vault). The index already carries the metadata, so this is two
    GROUP BYs and no bodies at all.

    The day buckets are what the sidebar expands into; the notes themselves
    are not fetched until a day is opened.
    """
    provider = _get_provider(session_id)
    catalog = _vault_catalog(provider)
    if catalog is None:
        raise HTTPException(
            status_code=501,
            detail="This session's memory store cannot answer catalogue queries",
        )
    kinds = await catalog.catalog_counts(by="kind")
    days = await catalog.catalog_counts(by="day", kind=kind)
    return {
        "total": sum(n for _k, n in kinds) if kind is None
        else sum(n for _d, n in days),
        "kinds": [{"kind": k or "note", "count": n} for k, n in kinds],
        "days": [{"day": d, "count": n} for d, n in days if d],
    }


@router.get("/{session_id}/memory/day/{day}")
async def memory_day(
    request: Request,
    session_id: str = Path(...),
    day: str = Path(..., description="YYYY-MM-DD"),
    kind: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """One day's notes — metadata only.

    Opening a day in the sidebar costs a read proportional to that day, not
    to the vault. Bodies arrive when a note is opened, through
    ``/memory/files/{filename}``.
    """
    provider = _get_provider(session_id)
    catalog = _vault_catalog(provider)
    if catalog is None:
        raise HTTPException(status_code=501, detail="No catalogue for this store")
    rows = await catalog.catalog_page(day=day, kind=kind, limit=limit,
                                      offset=offset)
    return {
        "day": day,
        "notes": [
            {
                "id": r["id"],
                "filename": r["id"].rsplit("/", 1)[-1],
                "category": r["kind"],
                "title": r["title"],
                "updated_at": r["updated_at"],
                "char_count": r["text_len"],
                "pinned": r["pinned"],
            }
            for r in rows
        ],
        "limit": limit,
        "offset": offset,
        "has_more": len(rows) == limit,
    }


@router.get("/{session_id}/memory/files")
async def list_memory_files(
    request: Request,
    session_id: str = Path(...),
    category: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List memory files with optional filters. Uses the
    progressive-disclosure ``IndexHandle.list_notes`` API — bounded
    by ``limit``/``offset`` so the response stays small even on a
    vault with thousands of notes.
    """
    provider = _get_provider(session_id)
    summaries = await provider.index().list_notes(
        category=category, tag=tag, limit=limit, offset=offset,
    )
    total = len(summaries)
    catalog = _vault_catalog(provider)
    if catalog is not None:
        try:
            counts = await catalog.catalog_counts(by="kind", kind=category)
            total = sum(n for _k, n in counts)
        except Exception:  # noqa: BLE001 — a count must not fail the listing
            logger.debug("catalog count unavailable", exc_info=True)
    return {
        "files": [
            {
                "filename": s.filename,
                "title": s.title,
                "category": s.category,
                "tags": list(s.tags),
                "importance": s.importance,
                "char_count": s.char_count,
                "modified": s.modified,
                "first_paragraph": s.first_paragraph,
            }
            for s in summaries
        ],
        # `total` used to be len(summaries) — the PAGE size, which made a
        # full page indistinguishable from a full vault and left the sidebar
        # unable to show a count without fetching everything.
        "total": total,
        "returned": len(summaries),
        "limit": limit,
        "offset": offset,
        "has_more": len(summaries) == limit,
    }


@router.get("/{session_id}/memory/files/{filename:path}")
async def read_memory_file(
    request: Request,
    session_id: str = Path(...),
    filename: str = Path(...),
):
    """Read a single memory file (frontmatter metadata + body)."""
    provider = _get_provider(session_id)
    note = await provider.notes().read(filename)
    if note is None:
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")
    return {
        "filename": note.ref.filename,
        "title": note.title,
        "body": note.body,
        "category": note.category,
        "tags": list(note.tags or []),
        "importance": (
            note.importance.value if hasattr(note.importance, "value") else str(note.importance)
        ),
        "frontmatter": dict(note.frontmatter or {}),
        "links_to": list(note.links_out or []),
        "linked_from": list(note.links_in or []),
        "created": note.created_at.isoformat() if note.created_at else "",
        "modified": note.updated_at.isoformat() if note.updated_at else "",
        "metadata": dict(note.metadata or {}),
        "interaction": {
            "event_id": note.event_id,
            "linked_event_id": note.linked_event_id,
            "kind": note.kind,
            "direction": note.direction,
            "counterpart_id": note.counterpart_id,
            "counterpart_role": note.counterpart_role,
            "session_id": note.session_id,
        },
    }


# ── Binary attachments (observation frames etc.) ────────────────────

# Only image types are served — the memory tree also holds .md notes and
# index files that must never leave through this endpoint.
_ATTACHMENT_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

# Bare-filename shape (observation ids are hex + extension). Also keeps
# glob metacharacters out of the rglob pattern below.
_ATTACHMENT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _find_memory_attachment(memory_dir: FsPath, filename: str) -> Optional[FsPath]:
    """Locate *filename* anywhere under the session's memory tree.

    Notes embed attachments by bare name (Obsidian shortest-path
    convention: ``![[<id>.jpg]]``) while observation frames live
    date-bucketed at ``memory/observations/<YYYY-MM-DD>/<id>.jpg`` —
    so resolution is a filename search, not a sibling lookup. Traversal
    is blocked by the name whitelist + a containment check on the
    resolved path.
    """
    name = FsPath(filename).name
    if not _ATTACHMENT_NAME_RE.match(name):
        return None
    if FsPath(name).suffix.lower() not in _ATTACHMENT_MIME:
        return None
    base = memory_dir.resolve()
    try:
        for candidate in sorted(memory_dir.rglob(name)):
            if not candidate.is_file():
                continue
            resolved = candidate.resolve()
            if not resolved.is_relative_to(base):
                continue  # symlink escaping the vault
            return resolved
    except OSError:
        return None
    return None


_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _resolve_attachment_memory_dir(session_id: str) -> Optional[FsPath]:
    """Locate a session's on-disk memory dir for SERVING static attachments.

    Unlike :func:`_get_provider_and_memory_dir` this must NOT require a live
    agent — screen-observation frames belong to whichever session recorded
    them, and the user browses historical notes long after that session has
    stopped. Prefer the live agent's authoritative dir when present, otherwise
    derive ``<storage_root>/<session_id>/memory`` so old frames still resolve.
    The session id is validated (safe leaf only) and the endpoint's containment
    check keeps traversal out.
    """
    try:
        agent = get_agent_session_manager().get_agent(session_id)
        if agent is not None:
            mgr = getattr(agent, "memory_manager", None) or getattr(
                agent, "_memory_manager", None
            )
            md = getattr(mgr, "_memory_dir", None) if mgr is not None else None
            if md:
                return FsPath(md)
            storage = getattr(agent, "storage_path", None) or getattr(
                agent, "_storage_path", None
            )
            if storage:
                return FsPath(storage) / "memory"
    except Exception:  # noqa: BLE001 — live lookup is best-effort
        logger.debug("live memory dir lookup failed for %s", session_id, exc_info=True)

    if not _SESSION_ID_RE.match(session_id):
        return None
    try:
        from service.utils.platform import DEFAULT_STORAGE_ROOT

        return FsPath(DEFAULT_STORAGE_ROOT) / session_id / "memory"
    except Exception:  # noqa: BLE001
        return None


@router.get("/{session_id}/memory/attachments/{filename}")
async def get_memory_attachment(
    request: Request,
    session_id: str = Path(...),
    filename: str = Path(...),
):
    """Serve a binary attachment referenced by a memory note (e.g. a
    screen-observation frame) as raw bytes, so ``![[<id>.jpg]]`` embeds
    can render in the web UI. Images only; 404 for anything else. Works for
    historical (stopped) sessions too — static frames must not require a live
    agent."""
    memory_dir = _resolve_attachment_memory_dir(session_id)
    if memory_dir is None or not memory_dir.is_dir():
        raise HTTPException(status_code=404, detail="Memory dir unavailable")
    found = _find_memory_attachment(FsPath(memory_dir), filename)
    if found is None:
        raise HTTPException(
            status_code=404, detail=f"Attachment not found: {filename}",
        )
    return FileResponse(
        str(found),
        media_type=_ATTACHMENT_MIME[found.suffix.lower()],
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/{session_id}/memory/files/{filename:path}/outline")
async def read_memory_outline(
    request: Request,
    session_id: str = Path(...),
    filename: str = Path(...),
):
    """Return the markdown heading tree of a single note. Step 3 of
    the progressive-disclosure read chain (categories → notes →
    outline → section).
    """
    provider = _get_provider(session_id)
    outline = await provider.index().read_outline(filename)
    if outline is None:
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")

    def _node_to_dict(n) -> Dict[str, Any]:
        return {
            "level": n.level,
            "heading": n.heading,
            "line_start": n.line_start,
            "line_end": n.line_end,
            "children": [_node_to_dict(c) for c in (n.children or [])],
        }

    return {
        "filename": outline.filename,
        "title": outline.title,
        "headings": [_node_to_dict(h) for h in outline.headings],
    }


@router.get("/{session_id}/memory/files/{filename:path}/sections/{heading}")
async def read_memory_section(
    request: Request,
    session_id: str = Path(...),
    filename: str = Path(...),
    heading: str = Path(...),
):
    """Return the body of a single section by heading. Step 4 of the
    progressive-disclosure chain.
    """
    provider = _get_provider(session_id)
    body = await provider.index().read_section(filename, heading)
    if body is None:
        raise HTTPException(
            status_code=404,
            detail=f"Section not found: {filename} / {heading}",
        )
    return {"filename": filename, "heading": heading, "body": body}


@router.post("/{session_id}/memory/files")
async def create_memory_file(
    request: Request,
    session_id: str = Path(...),
    req: WriteNoteRequest = ...,
    auth: dict = Depends(require_auth),
):
    """Create a new structured memory note via ``provider.notes().write``."""
    from geny_executor.memory.provider import NoteDraft

    provider = _get_provider(session_id)
    draft = NoteDraft(
        title=req.title,
        body=req.content,
        importance=_importance_value(req.importance),
        tags=list(req.tags),
        category=req.category,
        metadata={"source": req.source} if req.source else {},
    )
    meta = await provider.notes().write(draft)
    return {"filename": meta.ref.filename, "message": "Note created successfully"}


@router.put("/{session_id}/memory/files/{filename:path}")
async def update_memory_file(
    request: Request,
    session_id: str = Path(...),
    filename: str = Path(...),
    req: UpdateNoteRequest = ...,
    auth: dict = Depends(require_auth),
):
    """Update an existing memory note."""
    from geny_executor.memory.provider import NotePatch

    provider = _get_provider(session_id)
    patch = NotePatch(
        body=req.content,
        tags=list(req.tags) if req.tags is not None else None,
        importance=_importance_value(req.importance) if req.importance is not None else None,
    )
    try:
        await provider.notes().update(filename, patch)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")
    return {"filename": filename, "message": "Note updated successfully"}


@router.delete("/{session_id}/memory/files/{filename:path}")
async def delete_memory_file(
    request: Request,
    session_id: str = Path(...),
    filename: str = Path(...),
    auth: dict = Depends(require_auth),
):
    """Delete a memory note."""
    provider = _get_provider(session_id)
    ok = await provider.notes().delete(filename)
    if not ok:
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")
    return {"message": "Note deleted successfully"}


# ============================================================================
# Endpoints — Search
# ============================================================================

@router.get("/{session_id}/memory/search")
async def search_memory(
    request: Request,
    session_id: str = Path(...),
    q: str = Query(..., min_length=1),
    max_results: int = Query(10, ge=1, le=50),
    category: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    counterpart: Optional[str] = Query(
        None,
        description=(
            "Narrow InteractionEvent hits to a specific ``counterpart_id``. "
            "Non-event memories (LTM notes / curated knowledge) pass through."
        ),
    ),
    kinds: Optional[str] = Query(
        None,
        description=(
            "Comma-separated InteractionEvent kinds — e.g. "
            "'tool_run_summary,task_result'. Non-event memories pass through."
        ),
    ),
):
    """Keyword search across notes (importance + category boost)."""
    provider = _get_provider(session_id)
    chunks = await provider.notes().search(q, limit=max_results)

    kind_set = {k.strip() for k in kinds.split(",") if k.strip()} if kinds else None
    filtered = _apply_interaction_event_filters(
        chunks, counterpart=counterpart, kinds=kind_set,
    )
    if category:
        filtered = [c for c in filtered if (c.metadata or {}).get("category") == category]
    if tag:
        needle = tag.lower()
        filtered = [
            c for c in filtered
            if needle in {str(t).lower() for t in (c.metadata or {}).get("tags", [])}
        ]

    return {
        "query": q,
        "results": [
            {
                "key": c.key,
                "content": c.content,
                "source": c.source,
                "relevance_score": c.relevance_score,
                "metadata": dict(c.metadata or {}),
            }
            for c in filtered
        ],
        "total": len(filtered),
        "filters": {
            "counterpart": counterpart,
            "kinds": sorted(kind_set) if kind_set else None,
            "category": category,
            "tag": tag,
        },
    }


def _apply_interaction_event_filters(
    chunks,
    *,
    counterpart: Optional[str],
    kinds: Optional[set],
):
    """Narrow only InteractionEvent hits.

    A chunk is treated as an InteractionEvent hit when its metadata
    carries an ``event_id``. Non-event hits (LTM notes / curated
    knowledge / vector hits without an event_id) pass through every
    filter so the durable knowledge layer never disappears just
    because the user added an event filter.
    """
    if not counterpart and not kinds:
        return list(chunks)
    out = []
    for c in chunks:
        meta = c.metadata or {}
        event_id = meta.get("event_id")
        if event_id:
            if counterpart and meta.get("counterpart_id") != counterpart:
                continue
            if kinds is not None and meta.get("kind") not in kinds:
                continue
        out.append(c)
    return out


@router.post("/{session_id}/memory/search")
async def search_memory_post(
    request: Request,
    session_id: str = Path(...),
    req: SearchRequest = ...,
    auth: dict = Depends(require_auth),
):
    """Search memory (POST variant for complex queries)."""
    provider = _get_provider(session_id)
    chunks = await provider.notes().search(req.query, limit=req.max_results)
    return {
        "query": req.query,
        "results": [
            {
                "key": c.key,
                "content": c.content,
                "source": c.source,
                "relevance_score": c.relevance_score,
                "metadata": dict(c.metadata or {}),
            }
            for c in chunks
        ],
        "total": len(chunks),
    }


# ============================================================================
# Endpoints — Links
# ============================================================================

@router.post("/{session_id}/memory/links")
async def create_memory_link(
    request: Request,
    session_id: str = Path(...),
    req: LinkNotesRequest = ...,
    auth: dict = Depends(require_auth),
):
    """Create a wikilink between two notes."""
    provider = _get_provider(session_id)
    ok = await provider.notes().link(req.source_filename, req.target_filename)
    if not ok:
        raise HTTPException(status_code=400, detail="Failed to create link")
    return {"message": "Link created successfully"}


# ============================================================================
# Endpoints — Maintenance
# ============================================================================

@router.post("/{session_id}/memory/reindex")
async def reindex_memory(
    request: Request,
    session_id: str = Path(...),
    auth: dict = Depends(require_auth),
):
    """Force a full rebuild of the memory index."""
    from service.memory.note_utils import aget_index_snapshot_with_dms
    provider, memory_dir = _get_provider_and_memory_dir(session_id)
    await provider.index().rebuild()
    # ``rebuild()`` clobbers the dms shard the same way ``snapshot()``
    # does (both fan out via ``_write_hierarchical_sidecars
    # (category=None)``). Restore + splice via the helper.
    snap = await aget_index_snapshot_with_dms(provider, memory_dir)
    return {
        "message": "Reindex complete",
        "total_files": int(snap.get("total_files", 0) or 0),
    }


@router.post("/{session_id}/memory/migrate")
async def migrate_memory(
    session_id: str = Path(...),
    auth: dict = Depends(require_auth),
):
    """Legacy migration endpoint — retired. Sessions land directly in
    the executor-owned layout from boot.
    """
    return {
        "message": "Migration retired — sessions use the executor layout from boot.",
        "summary": "no changes",
    }


# ============================================================================
# Endpoints — Categories (progressive disclosure step 1)
# ============================================================================

@router.get("/{session_id}/memory/categories")
async def list_memory_categories(
    request: Request,
    session_id: str = Path(...),
):
    """Step 1 of the progressive-disclosure read chain: every
    category folder + file count + description.
    """
    provider = _get_provider(session_id)
    cats = await provider.index().list_categories()
    return {"categories": cats}


# ============================================================================
# Endpoints — Promote (Session → Global)
# ============================================================================

@router.post("/{session_id}/memory/promote")
async def promote_to_global(
    session_id: str = Path(...),
    req: dict = ...,
    auth: dict = Depends(require_auth),
):
    """Promote a session memory note to global memory."""
    filename = req.get("filename")
    if not filename:
        raise HTTPException(status_code=400, detail="filename is required")
    agent_manager = get_agent_session_manager()
    agent = agent_manager.get_agent(session_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    mm = agent.memory_manager
    if mm is None:
        raise HTTPException(status_code=503, detail="Memory manager not initialized")
    from service.memory.global_memory import get_global_memory_manager
    gmm = get_global_memory_manager()
    global_fn = await gmm.apromote(mm, filename, session_id=session_id)
    if global_fn is None:
        raise HTTPException(status_code=404, detail=f"Failed to promote: {filename}")
    return {"message": "Note promoted to global memory", "global_filename": global_fn}


# ============================================================================
# Endpoints — Global Memory
# ============================================================================

# Auth on the whole router (audit S2): global memory read/list/create/
# update/delete/search were all unauthenticated — a full read + poison +
# delete channel into the personal knowledge base that feeds every agent
# turn. A router-level dependency gates every route at once.
global_router = APIRouter(
    prefix="/api/memory/global",
    tags=["global-memory"],
    dependencies=[Depends(require_auth)],
)


@global_router.get("")
async def get_global_index():
    """Get the global memory index and stats."""
    from service.memory.global_memory import get_global_memory_manager
    gmm = get_global_memory_manager()
    idx = await gmm.aget_index()
    stats = await gmm.aget_stats()
    return {
        "index": idx or {"files": {}, "tag_map": {}, "total_files": 0, "total_chars": 0},
        "stats": stats,
    }


@global_router.get("/files")
async def list_global_files(
    category: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
):
    """List global memory files."""
    from service.memory.global_memory import get_global_memory_manager
    gmm = get_global_memory_manager()
    notes = await gmm.alist_notes(category=category, tag=tag)
    return {"files": notes, "total": len(notes)}


@global_router.get("/files/{filename:path}")
async def read_global_file(filename: str = Path(...)):
    """Read a global memory file."""
    from service.memory.global_memory import get_global_memory_manager
    gmm = get_global_memory_manager()
    result = await gmm.aread_note(filename)
    if result is None:
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")
    return result


@global_router.post("/files")
async def create_global_file(req: WriteNoteRequest = ...):
    """Create a new global memory note."""
    from service.memory.global_memory import get_global_memory_manager
    gmm = get_global_memory_manager()
    filename = await gmm.awrite_note(
        title=req.title,
        content=req.content,
        category=req.category,
        tags=req.tags,
        importance=req.importance,
        source=req.source,
    )
    if filename is None:
        raise HTTPException(status_code=500, detail="Failed to create global note")
    return {"filename": filename, "message": "Global note created"}


@global_router.put("/files/{filename:path}")
async def update_global_file(
    filename: str = Path(...),
    req: UpdateNoteRequest = ...,
):
    """Update a global memory note."""
    from service.memory.global_memory import get_global_memory_manager
    gmm = get_global_memory_manager()
    ok = await gmm.aupdate_note(
        filename, body=req.content, tags=req.tags,
        importance=req.importance,
    )
    if not ok:
        raise HTTPException(status_code=404, detail=f"Update failed: {filename}")
    return {"message": "Global note updated"}


@global_router.delete("/files/{filename:path}")
async def delete_global_file(filename: str = Path(...)):
    """Delete a global memory note."""
    from service.memory.global_memory import get_global_memory_manager
    gmm = get_global_memory_manager()
    ok = await gmm.adelete_note(filename)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Delete failed: {filename}")
    return {"message": "Global note deleted"}


@global_router.get("/search")
async def search_global(
    q: str = Query(..., min_length=1),
    max_results: int = Query(5, ge=1, le=20),
):
    """Search global memory."""
    from service.memory.global_memory import get_global_memory_manager
    gmm = get_global_memory_manager()
    results = await gmm.asearch(q, max_results=max_results)
    return {"query": q, "results": results, "total": len(results)}
