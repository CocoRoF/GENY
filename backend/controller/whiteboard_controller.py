"""
Whiteboard Controller — Phase 0.

Surfaces the whiteboard ingest endpoints under ``/api/opsidian/*``:

  * ``POST /api/opsidian/captures``       — accept a CaptureEvent (multipart
    or JSON), persist any attachment, write an Inbox draft note, and
    append the audit log.
  * ``GET  /api/opsidian/captures``       — recent captures from the audit
    log (newest first).
  * ``GET  /api/opsidian/attachments/...``— stream a stored attachment.
  * ``DELETE /api/opsidian/captures/{id}``— remove the draft note + any
    attachment that captured it.

In P0 the auth path is session-cookie / bearer (the existing
``require_auth`` middleware).  ``_resolve_user_for_capture`` is
written as an adapter so that a future browser-extension ingest token
can plug in without touching call sites — see docs §11.6.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import uuid
from datetime import datetime, timezone
from logging import getLogger
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from service.auth.auth_middleware import require_auth
from service.whiteboard.spotlight_store import (
    DEFAULT_TTL_MINUTES,
    get_spotlight_store,
)
from service.whiteboard.types import (
    CaptureEvent,
    CapturePayload,
    parse_capture_type,
)


logger = getLogger(__name__)

router = APIRouter(prefix="/api/opsidian", tags=["whiteboard"])


# ── Auth adapter (extension hook — docs §11.6) ────────────────────────


async def _resolve_user_for_capture(request: Request) -> Dict[str, Any]:
    """Resolve the acting user for whiteboard ingest.

    Accepts the same session-cookie / bearer auth as everything else in
    P0 via :func:`require_auth`.  A future ``X-Geny-Ingest-Token``
    header can be added here to authorise a browser-extension client
    without a session cookie — the surrounding code paths must NOT
    grow their own auth logic; this adapter is the single seam.
    """
    # Future-extension seam:
    # ingest_token = request.headers.get("X-Geny-Ingest-Token")
    # if ingest_token:
    #     return resolve_ingest_token(ingest_token)
    return await require_auth(request)


# ── Pydantic models ───────────────────────────────────────────────────


class CapturePayloadIn(BaseModel):
    inline_text: Optional[str] = None
    attachment_path: Optional[str] = None
    inline_base64: Optional[str] = None
    ref_url: Optional[str] = None


class CaptureCreateRequest(BaseModel):
    """JSON-only capture (no binary upload).

    Used by clipboard-text / link / future plugin sources where the
    payload fits in a JSON body. Binary captures arrive as multipart
    on the same endpoint via ``Form`` + ``File`` parameters.
    """

    type: str = Field(..., description="One of CaptureType")
    source: str = Field("manual", description="Logical source of the capture")
    payload: CapturePayloadIn = Field(default_factory=CapturePayloadIn)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    session_id: Optional[str] = None
    title: Optional[str] = Field(None, description="Optional override for the draft note title")
    suggested_filename: Optional[str] = Field(
        None, description="Hint for the attachment filename when uploading binary"
    )


class CaptureCreatedResponse(BaseModel):
    capture_id: str
    draft_note_filename: str
    attachment_path: Optional[str] = None
    # Set when ``auto_spotlight=true`` was passed on the upload — the
    # post-capture hook was awaited synchronously, the resulting
    # spotlight item id is returned so the caller knows the
    # ``[USER_SHARED]`` trigger has already been queued for this
    # session. Absent on the default fire-and-forget path.
    spotlight_item_id: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────


def _get_manager(username: str):
    from service.memory.user_opsidian import get_user_opsidian_manager
    return get_user_opsidian_manager(username)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_CONTENT_TYPE_TO_EXT: Dict[str, str] = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "video/webm": "webm",
    "video/mp4": "mp4",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "application/json": "json",
    "application/octet-stream": "bin",  # generic binaries OK
}

# Hard ceiling for a single multipart capture upload. Big enough to
# fit a 4K screenshot, an audio memo, or a small PDF; small enough
# to keep an accidental drag-drop or malicious request from OOMing
# the worker. Override via env if a host genuinely needs more.
_MAX_UPLOAD_BYTES = int(os.environ.get("GENY_WHITEBOARD_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))


def _ext_for_content_type(content_type: Optional[str], fallback: str = "bin") -> str:
    if not content_type:
        return fallback
    primary = content_type.split(";")[0].strip().lower()
    return _CONTENT_TYPE_TO_EXT.get(primary, fallback)


def _is_allowed_content_type(content_type: Optional[str]) -> bool:
    """Hard allow-list for capture uploads.

    Anything outside ``_CONTENT_TYPE_TO_EXT`` is rejected. This stops
    a hostile client from posting executable binaries / shell scripts
    to the user's vault under an accidental MIME label. Empty /
    missing content_type is treated as ``application/octet-stream``
    (allowed) so plain ``file_drop`` of unlabelled binaries still
    works for the user's own data.
    """
    if not content_type:
        return True
    primary = content_type.split(";")[0].strip().lower()
    return primary in _CONTENT_TYPE_TO_EXT


def _default_title_for(capture_type: str, *, when: Optional[datetime] = None) -> str:
    ts = (when or datetime.now(timezone.utc)).strftime("%Y-%m-%d %H:%M:%S")
    pretty = {
        "screenshot": "Screen capture",
        "image": "Image",
        "audio": "Audio memo",
        "drawing": "Drawing",
        "text": "Text capture",
        "link": "Saved link",
        "file": "File",
        "code": "Code snippet",
    }.get(capture_type, "Capture")
    return f"{pretty} {ts}"


def _build_inbox_body(event: CaptureEvent) -> str:
    """Compose the markdown body for a fresh inbox draft note."""
    lines: List[str] = []
    if event.payload.attachment_path:
        rel = event.payload.attachment_path
        leaf = os.path.basename(rel)
        lines.append(f"![[{leaf}]]")
        lines.append("")
    if event.payload.ref_url:
        lines.append(f"<{event.payload.ref_url}>")
        lines.append("")
    if event.payload.inline_text:
        lines.append(event.payload.inline_text.strip())
        lines.append("")
    return "\n".join(lines).rstrip() or "_(empty capture)_"


def _persist_capture(
    *,
    username: str,
    session_id: Optional[str],
    capture_type: str,
    source: str,
    metadata: Dict[str, Any],
    payload: CapturePayload,
    title_override: Optional[str],
    run_hook_sync: bool = False,
) -> CaptureEvent:
    """Persist the capture to the user's vault and return the event.

    Common path used by both JSON and multipart variants. Always:
      1. Generates a capture_id.
      2. Writes the inbox draft note via UserOpsidianManager.
      3. Appends to ``_captures.jsonl``.
    """
    capture_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc)
    event = CaptureEvent(
        capture_id=capture_id,
        type=parse_capture_type(capture_type),  # raises ValueError → HTTP 400 in caller
        source=source or "manual",
        payload=payload,
        user_id=username,
        metadata=dict(metadata or {}),
        session_id=session_id,
        created_at=now,
    )

    mgr = _get_manager(username)
    title = (title_override or "").strip() or _default_title_for(event.type, when=now)
    body = _build_inbox_body(event)

    attachments_meta: List[str] = []
    if event.payload.attachment_path:
        attachments_meta.append(event.payload.attachment_path)

    # Persist as a markdown note in the inbox/ category. We use the
    # standard UserOpsidianManager.write_note path so the resulting
    # file participates in the regular index/search/graph paths.
    #
    # No auto-applied tags or low-importance flag here: the inbox
    # category itself already conveys "raw capture", and forcing
    # `capture` / `unrefined` chips on every note added visual noise
    # to the editor without giving the user any new affordance.
    # `source` carries the originating capture source for filtering
    # later (e.g. "capture:screen_capture" vs "capture:clipboard_paste").
    draft_filename = mgr.write_note(
        title=title,
        content=body,
        category="inbox",
        tags=[],
        importance="medium",
        source=f"capture:{event.source}",
    )
    if not draft_filename:
        # Fallback: synthesise a filename so the audit log still has
        # something to point at, even if the index write failed. This
        # avoids losing the binary that was just stored.
        draft_filename = f"inbox/capture-{capture_id[:8]}.md"

    log_entry = {
        "capture_id": capture_id,
        "ts": _utc_now_iso(),
        "username": username,
        "session_id": session_id,
        "type": event.type,
        "source": event.source,
        "draft_note": draft_filename,
        "attachment_path": event.payload.attachment_path,
        "ref_url": event.payload.ref_url,
        "metadata": event.metadata,
    }
    mgr.append_capture_log(log_entry)

    event.metadata.setdefault("draft_note", draft_filename)
    if attachments_meta:
        event.metadata.setdefault("attachments", attachments_meta)

    # P4 — fire the post-capture hook for this CaptureType (e.g.
    # the `_describe_image_hook` that captions screenshots). Best-
    # effort: a missing event loop or hook failure never blocks the
    # capture itself.
    #
    # V2 (voice-notes follow-up) — when *run_hook_sync* is True the
    # caller will dispatch the hook itself (via
    # :func:`_auto_spotlight_for_event`) and we skip the
    # fire-and-forget here so the two paths don't race for the same
    # note body.
    if not run_hook_sync:
        try:
            from service.whiteboard.post_capture_hook import fire_and_forget
            fire_and_forget(event, draft_filename)
        except Exception:  # noqa: BLE001
            logger.debug("post-capture hook dispatch failed", exc_info=True)
    return event


# ── Endpoints ─────────────────────────────────────────────────────────


@router.post("/captures", response_model=CaptureCreatedResponse)
async def create_capture_json(
    payload: CaptureCreateRequest,
    auth: dict = Depends(_resolve_user_for_capture),
):
    """JSON-only capture ingest (no binary).

    For text / link / clipboard-text captures. Binary uploads go
    through ``/captures/upload`` to keep the schemas clean.
    """
    username = auth.get("sub", "anonymous")
    capture_payload = CapturePayload(
        inline_text=payload.payload.inline_text,
        attachment_path=payload.payload.attachment_path,
        inline_base64=payload.payload.inline_base64,
        ref_url=payload.payload.ref_url,
    )
    if capture_payload.is_empty():
        raise HTTPException(status_code=400, detail="capture payload is empty")

    # If the client sent inline_base64, decode and persist it as an
    # attachment so we don't keep large base64 strings in JSONL.
    if capture_payload.inline_base64 and not capture_payload.attachment_path:
        try:
            data = base64.b64decode(capture_payload.inline_base64, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"invalid base64: {exc}") from exc
        ext = _ext_for_content_type(payload.metadata.get("content_type"), fallback="bin")
        mgr = _get_manager(username)
        rel_path = mgr.save_attachment(
            data,
            suggested_name=payload.suggested_filename,
            default_ext=ext,
        )
        capture_payload.inline_base64 = None
        capture_payload.attachment_path = rel_path

    try:
        event = _persist_capture(
            username=username,
            session_id=payload.session_id,
            capture_type=payload.type,
            source=payload.source,
            metadata=payload.metadata,
            payload=capture_payload,
            title_override=payload.title,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return CaptureCreatedResponse(
        capture_id=event.capture_id,
        draft_note_filename=str(event.metadata.get("draft_note") or ""),
        attachment_path=event.payload.attachment_path,
    )


async def _auto_spotlight_for_event(
    *,
    username: str,
    session_id: Optional[str],
    event: CaptureEvent,
    draft_note_filename: str,
) -> Optional[str]:
    """Run the post-capture hook synchronously and stage a Spotlight
    item for the resulting note so the VTuber sees a
    ``[USER_SHARED]`` trigger built from the transcript-bearing
    excerpt. Best-effort: an early hook failure (Whisper down, etc.)
    still surfaces a spotlight item — the excerpt will just lack the
    transcript line and the VTuber will react to the audio attachment
    alone.

    Used by the VTuber STT mode (V2): the user keeps the mic on,
    every detected utterance comes through ``/captures/upload`` with
    ``auto_spotlight=true``, and this function makes sure the
    audio + transcript reach the persona without the user clicking
    "Share with VTuber" between each sentence.
    """
    # 1. Dispatch the hook synchronously. Returns the same audit
    #    payload `dispatch_post_capture` produces; we don't use it
    #    directly — the side-effect of prepending the transcript to
    #    the draft note body is what we want.
    try:
        from service.whiteboard.post_capture_hook import (
            dispatch_post_capture,
        )
        await dispatch_post_capture(event, draft_note_filename)
    except Exception:  # noqa: BLE001
        logger.warning(
            "auto_spotlight: hook dispatch raised; falling back to "
            "no-transcript spotlight item",
            exc_info=True,
        )

    # 2. Build a SpotlightItem from the (now-updated) note. The
    #    helper pulls title/excerpt/wikilinks the way share_to_spotlight
    #    does, so the excerpt picks up the freshly-prepended
    #    ``> **Transcript (lang):**`` block automatically.
    try:
        title, excerpt, attachments = _excerpt_from_note(
            username, draft_note_filename, "user"
        )
    except Exception:  # noqa: BLE001
        logger.debug("auto_spotlight: excerpt read failed", exc_info=True)
        return None

    # No session → no agent to deliver USER_SHARED to. Persisting a
    # spotlight item without one is harmless (TTL cleans it up), but
    # we'd skip the trigger, so just bail with None.
    if not session_id:
        return None

    try:
        store = get_spotlight_store()
        item = store.add(
            user_id=username,
            session_id=session_id,
            source_filename=draft_note_filename,
            title=title,
            excerpt=excerpt,
            attachments=tuple(attachments) if attachments else (),
            # ttl_minutes left at the store default so VTuber STT
            # utterances expire on the same schedule as manual shares.
            pinned=False,
            capture_id=event.capture_id,
            note_kind="user",
            metadata={
                "source": "vtuber_stt_stream",
                "capture_source": event.source,
            },
        )
    except Exception:  # noqa: BLE001
        logger.warning("auto_spotlight: store.add failed", exc_info=True)
        return None

    try:
        from service.whiteboard.user_shared_trigger import (
            fire_user_shared_trigger_async,
        )
        fire_user_shared_trigger_async(item)
    except Exception:  # noqa: BLE001
        logger.debug("auto_spotlight: USER_SHARED dispatch failed", exc_info=True)

    return item.item_id


@router.post("/captures/upload", response_model=CaptureCreatedResponse)
async def create_capture_upload(
    file: UploadFile = File(...),
    type: str = Form(...),
    source: str = Form("manual"),
    title: Optional[str] = Form(None),
    session_id: Optional[str] = Form(None),
    metadata_json: Optional[str] = Form(None),
    inline_text: Optional[str] = Form(None),
    # V2 (voice-notes follow-up) — when true, the post-capture hook
    # is awaited synchronously and the new note is immediately added
    # to the caller's spotlight so the VTuber sees a ``[USER_SHARED]``
    # trigger built from the transcript-bearing excerpt. Used by the
    # frontend VTuber STT mode so each utterance reaches the persona
    # without the user manually clicking "Share with VTuber".
    auto_spotlight: bool = Form(False),
    auth: dict = Depends(_resolve_user_for_capture),
):
    """Multipart capture ingest (binary attachment + metadata).

    Hard guards on the upload boundary:

      * MIME allow-list (``_is_allowed_content_type``) — reject
        anything we don't already know how to extension-map.
      * Size ceiling (``_MAX_UPLOAD_BYTES``, default 25 MB) enforced
        by streaming into a bounded buffer; the request returns 413
        the moment the body exceeds the limit instead of OOMing
        the worker by buffering a 4 GB file in memory.
    """
    if not _is_allowed_content_type(file.content_type):
        raise HTTPException(
            status_code=415,
            detail=f"unsupported content type: {file.content_type!r}",
        )

    username = auth.get("sub", "anonymous")
    parsed_metadata: Dict[str, Any] = {}
    if metadata_json:
        try:
            parsed_metadata = json.loads(metadata_json)
            if not isinstance(parsed_metadata, dict):
                raise ValueError("metadata_json must encode an object")
        except (ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail=f"invalid metadata_json: {exc}") from exc

    # Stream-read with a hard cap. ``UploadFile.read(n)`` returns
    # at most n bytes; we keep reading until either the source is
    # drained (small file → fits) or we'd exceed the limit (return
    # 413 immediately, no buffer escalation).
    chunks: List[bytes] = []
    received = 0
    while True:
        chunk = await file.read(64 * 1024)
        if not chunk:
            break
        received += len(chunk)
        if received > _MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"upload exceeds limit of {_MAX_UPLOAD_BYTES} bytes"
                ),
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise HTTPException(status_code=400, detail="uploaded file is empty")

    ext = _ext_for_content_type(file.content_type, fallback="bin")
    mgr = _get_manager(username)
    rel_path = mgr.save_attachment(
        data,
        suggested_name=file.filename,
        default_ext=ext,
    )

    parsed_metadata.setdefault("content_type", file.content_type)
    parsed_metadata.setdefault("size_bytes", len(data))
    parsed_metadata.setdefault("original_filename", file.filename)

    capture_payload = CapturePayload(
        inline_text=inline_text,
        attachment_path=rel_path,
    )
    try:
        event = _persist_capture(
            username=username,
            session_id=session_id,
            capture_type=type,
            source=source,
            metadata=parsed_metadata,
            payload=capture_payload,
            title_override=title,
            run_hook_sync=auto_spotlight,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    spotlight_item_id: Optional[str] = None
    if auto_spotlight:
        draft_note_filename = str(event.metadata.get("draft_note") or "")
        if draft_note_filename:
            spotlight_item_id = await _auto_spotlight_for_event(
                username=username,
                session_id=session_id,
                event=event,
                draft_note_filename=draft_note_filename,
            )

    return CaptureCreatedResponse(
        capture_id=event.capture_id,
        draft_note_filename=str(event.metadata.get("draft_note") or ""),
        attachment_path=event.payload.attachment_path,
        spotlight_item_id=spotlight_item_id,
    )


@router.get("/captures")
async def list_recent_captures(
    limit: int = 50,
    auth: dict = Depends(_resolve_user_for_capture),
) -> Dict[str, Any]:
    """Return the most recent captures (newest first)."""
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    log_path = Path(mgr.vault_root) / "_captures.jsonl"
    items: List[Dict[str, Any]] = []
    if log_path.exists():
        try:
            text = log_path.read_text(encoding="utf-8")
        except OSError:
            text = ""
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except (ValueError, json.JSONDecodeError):
                continue
    items.reverse()
    return {"captures": items[: max(1, min(limit, 500))], "total": len(items)}


@router.get("/attachments/{rel_path:path}")
async def download_attachment(
    rel_path: str,
    auth: dict = Depends(_resolve_user_for_capture),
):
    """Stream a previously stored attachment.

    Hardened path-traversal handling:

      1. Reject any request whose ``rel_path`` contains a ``..``
         segment, a NUL byte, or an absolute path leading slash.
         This catches obvious payloads before we touch the FS at all.
      2. Resolve BOTH ``base_attachments_dir`` and ``target`` via
         ``Path.resolve()`` so symlinks inside or above the vault
         can't expand the escape window after the syntactic check.
      3. Use the resolved ``base / "_attachments"`` (NOT the raw
         vault root) as the containment check via
         ``target.relative_to(...)``. The previous code mixed
         resolved vs unresolved paths, which is the classic
         path-confusion footgun.
    """
    if not rel_path or "\x00" in rel_path:
        raise HTTPException(status_code=400, detail="invalid attachment path")
    # Forbid traversal segments before any FS work.
    cleaned = rel_path.replace("\\", "/").lstrip("/")
    if any(seg in ("", "..") for seg in cleaned.split("/")):
        raise HTTPException(status_code=400, detail="invalid attachment path")

    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    if cleaned.startswith("_attachments/"):
        target_rel = cleaned
    else:
        target_rel = f"_attachments/{cleaned}"

    try:
        attachments_base = (Path(mgr.vault_root) / "_attachments").resolve()
        target = (Path(mgr.vault_root) / target_rel).resolve()
    except (OSError, RuntimeError):
        raise HTTPException(status_code=400, detail="invalid attachment path")

    # `relative_to` raises ValueError if `target` isn't inside the
    # resolved attachments dir — the canonical containment check.
    try:
        target.relative_to(attachments_base)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid attachment path")

    if not target.is_file():
        raise HTTPException(status_code=404, detail="attachment not found")
    return FileResponse(path=str(target))


@router.delete("/captures/{capture_id}")
async def delete_capture(
    capture_id: str,
    auth: dict = Depends(_resolve_user_for_capture),
) -> Dict[str, Any]:
    """Delete a capture's draft note, attachment, and audit-log entry.

    Looks up the capture in the audit log to find the draft note and
    attachment, deletes both, and rewrites the JSONL log without that
    entry so subsequent ``GET /captures`` calls don't keep showing the
    discarded card.
    """
    username = auth.get("sub", "anonymous")
    mgr = _get_manager(username)
    log_path = Path(mgr.vault_root) / "_captures.jsonl"
    if not log_path.exists():
        raise HTTPException(status_code=404, detail="capture not found")

    kept_lines: List[str] = []
    found: Optional[Dict[str, Any]] = None
    try:
        for line in log_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                row = json.loads(stripped)
            except (ValueError, json.JSONDecodeError):
                # Preserve malformed lines unchanged so we don't lose
                # data on a third-party-edit accident.
                kept_lines.append(line)
                continue
            if row.get("capture_id") == capture_id:
                found = row
                continue  # drop this entry from the rewrite
            kept_lines.append(line)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="capture log unreadable") from exc

    if found is None:
        raise HTTPException(status_code=404, detail="capture not found")

    note_deleted = False
    attachment_deleted = False
    note_filename = found.get("draft_note")
    if note_filename:
        try:
            note_deleted = bool(mgr.delete_note(note_filename))
        except Exception:  # noqa: BLE001
            note_deleted = False
    attachment_path = found.get("attachment_path")
    if attachment_path:
        attachment_deleted = mgr.delete_attachment(attachment_path)

    # Rewrite the audit log without the deleted entry. Best-effort —
    # if disk write fails we still report the in-memory deletes; the
    # next reload will re-show the card but the binary itself is gone.
    try:
        log_path.write_text(
            ("\n".join(kept_lines) + ("\n" if kept_lines else "")),
            encoding="utf-8",
        )
    except OSError:
        logger.warning("delete_capture: failed to rewrite captures log", exc_info=True)

    return {
        "capture_id": capture_id,
        "note_deleted": note_deleted,
        "attachment_deleted": attachment_deleted,
    }


# ── ViewLedger inspection endpoint (low-stakes, P0 sanity) ────────────


@router.get("/views/stats")
async def get_view_stats(
    agent_id: Optional[str] = None,
    auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    """Aggregate counts from the user's ViewLedger.

    Phase 0 only exposes per-(user, agent) totals so we can verify the
    ledger is alive before P2 starts decorating tool results. Returns
    zeros when the ledger has not yet been populated.
    """
    from service.whiteboard.view_ledger import get_view_ledger

    username = auth.get("sub", "anonymous")
    ledger = get_view_ledger(username, agent_id)
    return ledger.stats()


# ── Spotlight (Phase 2a) ──────────────────────────────────────────────


class SpotlightShareRequest(BaseModel):
    """Spotlight-mode share only.

    For Library mode (long-term curated promotion) use the existing
    ``POST /api/curated/curate`` — Spotlight and Library are separate
    lifecycles per docs §4. The frontend can call both endpoints in
    sequence to express "share with both".
    """

    source_filename: str = Field(..., description="Note in user vault or curated knowledge")
    session_id: Optional[str] = None
    title: Optional[str] = None
    excerpt: Optional[str] = None
    attachments: List[str] = Field(default_factory=list)
    ttl_minutes: int = Field(DEFAULT_TTL_MINUTES, ge=1, le=720)
    pinned: bool = False
    note_kind: str = Field("user", description="'user' | 'curated'")
    capture_id: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


def _excerpt_from_note(username: str, source_filename: str, kind: str) -> Tuple[str, str, List[str]]:
    """Pull a (title, excerpt, attachments) tuple for the given note."""
    try:
        if kind == "curated":
            from service.memory.curated_knowledge import get_curated_knowledge_manager
            mgr = get_curated_knowledge_manager(username)
        else:
            from service.memory.user_opsidian import get_user_opsidian_manager
            mgr = get_user_opsidian_manager(username)
        note = mgr.read_note(source_filename) or {}
    except Exception:  # noqa: BLE001
        note = {}
    title = str(note.get("title") or source_filename)
    body = str(note.get("body") or "")
    excerpt = body.strip()[:400]
    # Pull `![[…]]` wikilink-attachments out of the body so the
    # spotlight item carries the same media references as the source.
    import re as _re
    attachments: List[str] = []
    for m in _re.finditer(r"!\[\[([^\]|]+)", body):
        attachments.append(m.group(1).strip())
    return (title, excerpt, attachments)


@router.post("/spotlight")
async def share_to_spotlight(
    payload: SpotlightShareRequest,
    auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    """Stage a Spotlight item — VTuber sees it on the next prompt build.

    Library-mode (long-term curated promotion) is a separate endpoint
    by design (different lifecycle, different storage). The frontend
    is expected to call ``POST /api/curated/curate`` for that.
    """
    username = auth.get("sub", "anonymous")

    title, excerpt, atts = _excerpt_from_note(
        username, payload.source_filename, payload.note_kind
    )
    title = (payload.title or title).strip()
    excerpt = (payload.excerpt or excerpt).strip()
    attachments = payload.attachments or atts

    store = get_spotlight_store()
    item = store.add(
        user_id=username,
        session_id=payload.session_id,
        source_filename=payload.source_filename,
        title=title,
        excerpt=excerpt,
        attachments=attachments,
        ttl_minutes=payload.ttl_minutes,
        pinned=payload.pinned,
        capture_id=payload.capture_id,
        note_kind=payload.note_kind,
        metadata=payload.metadata,
    )
    # Whiteboard P2b — fire one [USER_SHARED] trigger so the VTuber
    # acknowledges the share immediately. Best-effort: a trigger
    # failure never breaks the share itself; the user still sees
    # success and the SpotlightContextBlock will pick the item up
    # on the next turn either way.
    try:
        from service.whiteboard.user_shared_trigger import (
            fire_user_shared_trigger_async,
        )
        fire_user_shared_trigger_async(item)
    except Exception:  # noqa: BLE001
        logger.debug("USER_SHARED dispatch failed", exc_info=True)
    return {"item": item.to_dict()}


@router.get("/spotlight")
async def list_spotlight(
    session_id: Optional[str] = None,
    include_expired: bool = False,
    auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    username = auth.get("sub", "anonymous")
    store = get_spotlight_store()
    items = store.list(
        user_id=username,
        session_id=session_id,
        include_expired=include_expired,
    )
    return {
        "items": [item.to_dict() for item in items],
        "total": len(items),
    }


@router.delete("/spotlight/{item_id}")
async def unshare_spotlight(
    item_id: str,
    auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    username = auth.get("sub", "anonymous")
    store = get_spotlight_store()
    removed = store.remove(user_id=username, item_id=item_id)
    if not removed:
        raise HTTPException(status_code=404, detail="spotlight item not found")
    return {"removed": True, "item_id": item_id}


# ── Library — explicit user share (no quality gate) ─────────────────


class LibraryShareRequest(BaseModel):
    """Force-promote a User Opsidian note into Curated Knowledge.

    This bypasses the CurationEngine's quality threshold because the
    user is *explicitly* asking to share. The auto-curation pipeline
    (POST /api/curated/curate) keeps its threshold for *automated*
    promotion; this endpoint is for the "Share with VTuber → Library"
    button only.
    """

    source_filename: str
    note_kind: str = Field("user", description="'user' | 'curated'")
    extra_tags: List[str] = Field(default_factory=list)


@router.post("/library")
async def share_to_library(
    payload: LibraryShareRequest,
    auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    """Copy a note into Curated Knowledge directly.

    Reads the note from the user's vault, writes it through
    `CuratedKnowledgeManager.write_note`, and returns the resulting
    curated filename. No quality scoring, no LLM analysis — the
    user already decided.
    """
    username = auth.get("sub", "anonymous")

    # Load source note from User Opsidian.
    try:
        from service.memory.user_opsidian import get_user_opsidian_manager
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"opsidian unavailable: {exc}") from exc
    user_mgr = get_user_opsidian_manager(username)
    note = user_mgr.read_note(payload.source_filename)
    if note is None:
        raise HTTPException(
            status_code=404,
            detail=f"source note not found: {payload.source_filename}",
        )

    metadata = note.get("metadata") or {}
    title = str(note.get("title") or metadata.get("title") or payload.source_filename)
    body = str(note.get("body") or "")
    raw_tags = metadata.get("tags") or []
    tags = list({*[str(t) for t in raw_tags], *[str(t) for t in payload.extra_tags]})
    importance = str(metadata.get("importance") or "medium")

    # Promote into Curated.
    try:
        from service.memory.curated_knowledge import (
            get_curated_knowledge_manager,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"curated unavailable: {exc}") from exc
    curated_mgr = get_curated_knowledge_manager(username)
    if curated_mgr is None:
        raise HTTPException(status_code=503, detail="curated knowledge not initialised")

    # Pick a sensible curated category. ``inbox`` doesn't exist on
    # the curated side — coerce to ``topics`` so the note is
    # findable via knowledge_search.
    raw_category = str(metadata.get("category") or "topics")
    if raw_category in ("inbox", "root", "daily"):
        raw_category = "topics"

    try:
        curated_filename = curated_mgr.write_note(
            title=title,
            content=body,
            category=raw_category,
            tags=tags,
            importance=importance,
            source=f"share:user_library:{payload.source_filename}",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("library share write failed", exc_info=True)
        raise HTTPException(status_code=500, detail=f"write failed: {exc}") from exc

    if not curated_filename:
        raise HTTPException(status_code=500, detail="write returned empty filename")

    return {
        "success": True,
        "curated_filename": curated_filename,
        "title": title,
        "category": raw_category,
    }


# ── Organizer (Phase 5) ──────────────────────────────────────────────


class OrganizerRunRequest(BaseModel):
    strategies: Optional[List[str]] = Field(
        None, description="Subset of ORGANIZER_REGISTRY names; None = all"
    )


@router.post("/organizer/run")
async def organizer_run(
    payload: OrganizerRunRequest,
    auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    """Run the registered organizer strategies once and return the
    active suggestion list. Idempotent — repeated runs only add new
    suggestions (existing ones are deduped on strategy + filenames).
    """
    from service.whiteboard.organizer import (
        run_organizer_for_user,
    )

    username = auth.get("sub", "anonymous")
    suggestions = run_organizer_for_user(
        username, strategy_names=payload.strategies
    )
    return {
        "total": len(suggestions),
        "suggestions": [s.to_dict() for s in suggestions],
    }


@router.get("/organizer/suggestions")
async def organizer_list(
    auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    from service.memory.user_opsidian import get_user_opsidian_manager
    from service.whiteboard.organizer import list_active_suggestions

    username = auth.get("sub", "anonymous")
    mgr = get_user_opsidian_manager(username)
    items = list_active_suggestions(mgr.vault_root)
    return {
        "total": len(items),
        "suggestions": [s.to_dict() for s in items],
    }


class OrganizerDecisionRequest(BaseModel):
    cooldown_days: int = Field(30, ge=0, le=365)


@router.post("/organizer/suggestions/{suggestion_id}/accept")
async def organizer_accept(
    suggestion_id: str,
    payload: OrganizerDecisionRequest = OrganizerDecisionRequest(),
    auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    """Mark a suggestion as accepted.

    Phase 5 records the decision in the suggestion log; the actual
    *application* of the proposed action (group / merge / promote /
    archive) is intentionally a follow-up so the user has time to
    review the suggestion details first. The returned record carries
    the action so a future endpoint can replay it.
    """
    from service.memory.user_opsidian import get_user_opsidian_manager
    from service.whiteboard.organizer import update_status

    username = auth.get("sub", "anonymous")
    mgr = get_user_opsidian_manager(username)
    record = update_status(
        mgr.vault_root,
        suggestion_id,
        status="accepted",
        cooldown_days=payload.cooldown_days,
    )
    if record is None:
        raise HTTPException(status_code=404, detail="suggestion not found")
    return {"suggestion": record.to_dict()}


@router.post("/organizer/suggestions/{suggestion_id}/reject")
async def organizer_reject(
    suggestion_id: str,
    payload: OrganizerDecisionRequest = OrganizerDecisionRequest(),
    auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    from service.memory.user_opsidian import get_user_opsidian_manager
    from service.whiteboard.organizer import update_status

    username = auth.get("sub", "anonymous")
    mgr = get_user_opsidian_manager(username)
    record = update_status(
        mgr.vault_root,
        suggestion_id,
        status="rejected",
        cooldown_days=max(payload.cooldown_days, 30),
    )
    if record is None:
        raise HTTPException(status_code=404, detail="suggestion not found")
    return {"suggestion": record.to_dict()}
