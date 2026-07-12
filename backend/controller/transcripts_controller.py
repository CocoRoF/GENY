"""Transcripts Controller — REST view over the InteractionEvent stream.

Cycle 20260430_3 Stage A — surfaces the per-session STM stream
(introduced in cycle 20260430_2) to the operator UI. The data is
*read-only*: this controller never writes to STM. ``record_message``
remains the single writer (invariant 5).

Three endpoints, all scoped to a session::

    GET /api/agents/{sid}/transcripts
        Page through the InteractionEvent stream. Filters: counterpart,
        kinds (csv), direction, since, cursor, limit.

    GET /api/agents/{sid}/transcripts/{event_id}
        Full payload + linked parent for a single event.

    GET /api/agents/{sid}/transcripts/counterparts
        Per-counterpart cards: id, role, event count, last_ts.

Each event is rendered through cycle 20260430_2 B's ``_summarise_event``
so the operator UI and the LLM-facing memory_inspect tools speak the
same schema. The detail endpoint mirrors ``memory_event`` for the same
reason.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from service.auth.auth_middleware import require_auth
from service.executor import get_agent_session_manager

logger = getLogger(__name__)

# Auth on the whole router (audit S2): transcript listings and event
# streams were unauthenticated, exposing every session's conversation.
router = APIRouter(
    prefix="/api/agents",
    tags=["transcripts"],
    dependencies=[Depends(require_auth)],
)


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class TranscriptEventSummary(BaseModel):
    event_id: str
    ts: Optional[str] = None
    kind: Optional[str] = None
    direction: Optional[str] = None
    counterpart_id: Optional[str] = None
    counterpart_role: Optional[str] = None
    summary: Optional[str] = None
    linked_event_id: Optional[str] = None
    status: Optional[str] = None
    files_written_count: Optional[int] = None
    tools_used_count: Optional[int] = None


class TranscriptListResponse(BaseModel):
    events: List[TranscriptEventSummary]
    next_cursor: Optional[str] = None
    has_more: bool = False
    total_estimate: int = Field(
        default=0,
        description="Total InteractionEvent count seen on the STM (excludes legacy lines).",
    )


class TranscriptEventDetail(BaseModel):
    event_id: str
    ts: Optional[str] = None
    kind: Optional[str] = None
    direction: Optional[str] = None
    counterpart_id: Optional[str] = None
    counterpart_role: Optional[str] = None
    linked_event_id: Optional[str] = None
    content: str = ""
    payload: Dict[str, Any] = Field(default_factory=dict)


class TranscriptDetailResponse(BaseModel):
    event: TranscriptEventDetail
    linked: Dict[str, Any] = Field(default_factory=dict)


class CounterpartCard(BaseModel):
    id: str
    role: Optional[str] = None
    events: int = 0
    last_ts: Optional[str] = None


class CounterpartListResponse(BaseModel):
    counterparts: List[CounterpartCard]


class ArtifactReadResponse(BaseModel):
    event_id: str
    path: str
    size_bytes: int
    truncated: bool
    content: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_session_or_404(session_id: str):
    """Return ``(agent, memory_manager)`` for the session or raise 404."""
    manager = get_agent_session_manager()
    agent = manager.get_agent(session_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    memory = getattr(agent, "_memory_manager", None) or getattr(
        agent, "memory_manager", None,
    )
    if memory is None:
        raise HTTPException(status_code=503, detail="Memory manager not initialised")
    return agent, memory


async def _astm_load_all(memory_manager) -> List[Any]:
    """Load all STM entries (async-native).

    Sprint 3 step 1 retired ``ShortTermMemory`` so the legacy
    ``mgr.short_term.load_all()`` path returns ``None`` and silently
    yields ``[]`` — that's why every transcripts endpoint returned
    empty data after the refactor. Now reaches for the manager's
    ``aload_all_stm`` (Step 7-1) first, with a sync ``load_all_stm``
    fallback for any pre-async caller.
    """
    try:
        aloader = getattr(memory_manager, "aload_all_stm", None)
        if callable(aloader):
            return list(await aloader() or [])
        loader = getattr(memory_manager, "load_all_stm", None)
        if callable(loader):
            return list(loader() or [])
        return []
    except Exception:
        logger.debug("transcripts: STM load_all failed", exc_info=True)
        return []


def _entry_meta(entry) -> Dict[str, Any]:
    meta = getattr(entry, "metadata", None)
    return meta if isinstance(meta, dict) else {}


def _ts_iso(entry) -> Optional[str]:
    ts = getattr(entry, "timestamp", None)
    if ts is None:
        return None
    try:
        return ts.isoformat()
    except Exception:
        return None


def _summarise_event_dict(entry, meta: Dict[str, Any]) -> Dict[str, Any]:
    """Backend mirror of cycle 20260430_2 B's ``_summarise_event``.

    Kept *here* (not imported) so the transcripts controller stays
    decoupled from the LLM tool module — they share schema, not
    code, on purpose. Any divergence is caught by the wire-shape
    test below.
    """
    content = getattr(entry, "content", "") or ""
    summary = _short_content_preview(content)
    payload = meta.get("payload") if isinstance(meta.get("payload"), dict) else {}
    out: Dict[str, Any] = {
        "event_id": meta.get("event_id"),
        "ts": _ts_iso(entry),
        "kind": meta.get("kind"),
        "direction": meta.get("direction"),
        "counterpart_id": meta.get("counterpart_id"),
        "counterpart_role": meta.get("counterpart_role"),
        "summary": summary,
    }
    if "linked_event_id" in meta and meta["linked_event_id"]:
        out["linked_event_id"] = meta["linked_event_id"]
    if isinstance(payload, dict):
        if payload.get("status"):
            out["status"] = payload["status"]
        if isinstance(payload.get("files_written"), list) and payload["files_written"]:
            out["files_written_count"] = len(payload["files_written"])
        if isinstance(payload.get("tools_used"), list) and payload["tools_used"]:
            out["tools_used_count"] = len(payload["tools_used"])
    return out


def _short_content_preview(content: str) -> str:
    if not content:
        return ""
    text = content.strip()
    if text.startswith("[") and "]" in text:
        close = text.find("]")
        if 0 < close < 30:
            text = text[close + 1:].lstrip()
    first = text.splitlines()[0] if text else ""
    return first[:160]


def _detailed_event_dict(entry, meta: Dict[str, Any]) -> Dict[str, Any]:
    payload = meta.get("payload") if isinstance(meta.get("payload"), dict) else {}
    return {
        "event_id": meta.get("event_id"),
        "ts": _ts_iso(entry),
        "kind": meta.get("kind"),
        "direction": meta.get("direction"),
        "counterpart_id": meta.get("counterpart_id"),
        "counterpart_role": meta.get("counterpart_role"),
        "linked_event_id": meta.get("linked_event_id"),
        "content": getattr(entry, "content", "") or "",
        "payload": payload,
    }


# ---------------------------------------------------------------------------
# Filtering
# ---------------------------------------------------------------------------


def _resolve_since_cutoff(entries: List[Any], since: str):
    """Same algorithm as ``memory_inspect_tools._resolve_since_cutoff`` —
    event_id first, ISO ts fallback."""
    if not since:
        return None
    target = since.strip()
    for entry in entries:
        meta = _entry_meta(entry)
        if meta.get("event_id") == target:
            return getattr(entry, "timestamp", None)
    try:
        from datetime import datetime
        return datetime.fromisoformat(target)
    except (TypeError, ValueError):
        return None


def _filter_events(
    entries: List[Any],
    *,
    counterpart: Optional[str],
    kinds: Optional[set],
    direction: Optional[str],
    since: Optional[str],
) -> List[Tuple[Any, Dict[str, Any]]]:
    """Return only entries that have an event_id and pass every filter.

    Result is in chronological order (oldest first); pagination is
    handled by the caller using a cursor strategy.
    """
    cutoff = _resolve_since_cutoff(entries, since) if since else None
    out: List[Tuple[Any, Dict[str, Any]]] = []
    for entry in entries:
        meta = _entry_meta(entry)
        if not meta.get("event_id"):
            continue
        if counterpart and meta.get("counterpart_id") != counterpart:
            continue
        if kinds is not None and meta.get("kind") not in kinds:
            continue
        if direction and meta.get("direction") != direction:
            continue
        if cutoff is not None:
            ts = getattr(entry, "timestamp", None)
            if ts is None or ts <= cutoff:
                continue
        out.append((entry, meta))
    return out


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get(
    "/{session_id}/transcripts",
    response_model=TranscriptListResponse,
)
async def list_transcripts(
    session_id: str = Path(..., description="Session id"),
    limit: int = Query(50, ge=1, le=200),
    cursor: Optional[str] = Query(
        None,
        description=(
            "event_id of the last event from a previous page; "
            "results start *after* this point."
        ),
    ),
    counterpart: Optional[str] = Query(
        None, description="Canonical counterpart_id to narrow by.",
    ),
    kinds: Optional[str] = Query(
        None,
        description=(
            "Comma-separated InteractionEvent kinds "
            "(e.g. 'tool_run_summary,task_result')."
        ),
    ),
    direction: Optional[str] = Query(
        None,
        regex=r"^(in|out|internal)$",
        description="One of in / out / internal.",
    ),
    since: Optional[str] = Query(
        None,
        description=(
            "Anchor — event_id from a prior call, or an ISO ts. "
            "Returns only events strictly after this point."
        ),
    ),
):
    """List InteractionEvents for *session_id* with optional filters."""
    _agent, memory = _resolve_session_or_404(session_id)
    entries = await _astm_load_all(memory)

    kind_set: Optional[set] = None
    if kinds:
        kind_set = {k.strip() for k in kinds.split(",") if k.strip()}

    filtered = _filter_events(
        entries,
        counterpart=counterpart,
        kinds=kind_set,
        direction=direction,
        since=since,
    )
    total_estimate = len(filtered)

    # Newest first for the timeline view; cursor walks from the most
    # recent backwards.
    filtered_desc = list(reversed(filtered))

    start_idx = 0
    if cursor:
        for idx, (_entry, meta) in enumerate(filtered_desc):
            if meta.get("event_id") == cursor:
                start_idx = idx + 1
                break

    page = filtered_desc[start_idx:start_idx + limit]
    events = [_summarise_event_dict(entry, meta) for entry, meta in page]

    next_cursor: Optional[str] = None
    has_more = (start_idx + limit) < len(filtered_desc)
    if has_more and events:
        next_cursor = events[-1].get("event_id")

    return {
        "events": events,
        "next_cursor": next_cursor,
        "has_more": has_more,
        "total_estimate": total_estimate,
    }


@router.get(
    "/{session_id}/transcripts/counterparts",
    response_model=CounterpartListResponse,
)
async def list_counterparts(
    session_id: str = Path(..., description="Session id"),
):
    """Per-counterpart summary cards (id, role, count, last_ts)."""
    _agent, memory = _resolve_session_or_404(session_id)
    entries = await _astm_load_all(memory)

    by_id: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        meta = _entry_meta(entry)
        if not meta.get("event_id"):
            continue
        cp_id = meta.get("counterpart_id")
        if not cp_id:
            continue
        slot = by_id.get(cp_id)
        ts = _ts_iso(entry)
        if slot is None:
            by_id[cp_id] = {
                "id": cp_id,
                "role": meta.get("counterpart_role"),
                "events": 1,
                "last_ts": ts,
            }
        else:
            slot["events"] += 1
            if ts and (slot.get("last_ts") is None or ts > slot["last_ts"]):
                slot["last_ts"] = ts
            # Prefer the most recent role label for display.
            if meta.get("counterpart_role"):
                slot["role"] = meta.get("counterpart_role")

    cards = sorted(
        by_id.values(),
        key=lambda c: (c.get("last_ts") or ""),
        reverse=True,
    )
    return {"counterparts": cards}


_DEFAULT_ARTIFACT_BYTES = 65_536       # 64 KB
_MAX_ARTIFACT_BYTES = 262_144          # 256 KB


@router.get(
    "/{session_id}/transcripts/{event_id}/artifact",
    response_model=ArtifactReadResponse,
)
async def get_transcript_artifact(
    session_id: str = Path(..., description="Recording session id"),
    event_id: str = Path(..., description="Event whose payload listed the file"),
    path: str = Query(
        ...,
        description=(
            "Relative path under the counterpart session's working "
            "directory. Must appear in the event's payload.files_written."
        ),
    ),
    max_bytes: int = Query(
        _DEFAULT_ARTIFACT_BYTES, ge=1, le=_MAX_ARTIFACT_BYTES,
    ),
):
    """Read a file the paired counterpart wrote during a remembered run.

    Same guardrails as the LLM-facing ``memory_artifact`` tool —
    declared-in-payload, no absolute paths, no ``..`` segments,
    workspace-bound resolve, byte cap. Operator view: the caller
    is the *recording* session (whose STM holds the event), and the
    file lives under the *counterpart* session's working dir.
    """
    _agent, memory = _resolve_session_or_404(session_id)
    entries = await _astm_load_all(memory)

    target_meta: Dict[str, Any] = {}
    for entry in entries:
        meta = _entry_meta(entry)
        if meta.get("event_id") == event_id:
            target_meta = meta
            break
    if not target_meta:
        raise HTTPException(status_code=404, detail=f"Event not found: {event_id}")

    payload = target_meta.get("payload") if isinstance(target_meta.get("payload"), dict) else {}
    listed = list(payload.get("files_written") or [])
    if path not in listed:
        raise HTTPException(
            status_code=400,
            detail="path is not declared in this event's payload.files_written",
        )

    from pathlib import Path as _Path
    rel = _Path(path)
    if rel.is_absolute() or any(part == ".." for part in rel.parts):
        raise HTTPException(status_code=400, detail="path is not a safe relative path")

    counterpart_id = target_meta.get("counterpart_id")
    if not counterpart_id:
        raise HTTPException(
            status_code=400,
            detail="event has no counterpart_id; cannot resolve workspace",
        )

    manager = get_agent_session_manager()
    target_session = manager.get_agent(counterpart_id)
    if target_session is None and hasattr(manager, "resolve_session"):
        target_session = manager.resolve_session(counterpart_id)
    if target_session is None:
        raise HTTPException(
            status_code=404,
            detail=f"counterpart session not available: {counterpart_id}",
        )
    working_dir = (
        getattr(target_session, "_working_dir", None)
        or getattr(target_session, "storage_path", None)
        or ""
    )
    if not working_dir:
        raise HTTPException(
            status_code=400,
            detail="counterpart session has no working directory",
        )

    try:
        base = _Path(working_dir).resolve(strict=False)
        full = (base / rel).resolve(strict=False)
        full.relative_to(base)
    except (OSError, ValueError):
        raise HTTPException(
            status_code=400, detail="path resolves outside the workspace",
        )

    if not full.exists() or not full.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")

    try:
        size = full.stat().st_size
        with open(full, "rb") as f:
            blob = f.read(max_bytes)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"file read failed: {exc}")

    truncated = size > max_bytes
    try:
        text = blob.decode("utf-8")
    except UnicodeDecodeError:
        text = blob.decode("utf-8", errors="replace")

    return {
        "event_id": event_id,
        "path": path,
        "size_bytes": size,
        "truncated": truncated,
        "content": text,
    }


@router.get(
    "/{session_id}/transcripts/{event_id}",
    response_model=TranscriptDetailResponse,
)
async def get_transcript_event(
    session_id: str = Path(...),
    event_id: str = Path(...),
):
    """Full payload for a single InteractionEvent + linked parent summary."""
    _agent, memory = _resolve_session_or_404(session_id)
    entries = await _astm_load_all(memory)

    target_entry: Optional[Any] = None
    target_meta: Dict[str, Any] = {}
    for entry in entries:
        meta = _entry_meta(entry)
        if meta.get("event_id") == event_id:
            target_entry = entry
            target_meta = meta
            break
    if target_entry is None:
        raise HTTPException(status_code=404, detail=f"Event not found: {event_id}")

    event = _detailed_event_dict(target_entry, target_meta)

    linked: Dict[str, Any] = {}
    parent_id = target_meta.get("linked_event_id")
    if parent_id:
        parent_entry: Optional[Any] = None
        parent_meta: Dict[str, Any] = {}
        for entry in entries:
            meta = _entry_meta(entry)
            if meta.get("event_id") == parent_id:
                parent_entry = entry
                parent_meta = meta
                break
        if parent_entry is not None:
            linked["parent"] = _summarise_event_dict(parent_entry, parent_meta)
        else:
            linked["parent"] = {"event_id": parent_id, "missing": True}

    return {"event": event, "linked": linked}
