"""
VTuber screen-observation API.

The frontend (V3 "Screen sharing for VTuber" toggle) periodically
captures a frame from the user's screen-share stream and POSTs it
here. The backend persists the image into the live session's storage
path, auto-captions it via the vision LLM, and conditionally fires a
``[USER_OBSERVATION]`` trigger so the persona can comment.

Hard guards on the upload boundary mirror the whiteboard endpoint:
  * MIME allow-list (PNG / JPEG / WebP).
  * Size ceiling.
  * Streamed read with bounded buffer.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from service.auth.auth_middleware import require_auth
from service.vtuber.screen_observation import save_and_maybe_trigger

logger = getLogger(__name__)

router = APIRouter(prefix="/api/vtuber/screen-observation", tags=["vtuber-screen"])


_MAX_BYTES = 6 * 1024 * 1024  # 6 MB — generous for a 1080p PNG, prevents OOM.
_ALLOWED: frozenset[str] = frozenset({
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
})


def _allowed(content_type: Optional[str]) -> bool:
    if not content_type:
        return False
    primary = content_type.split(";")[0].strip().lower()
    return primary in _ALLOWED


@router.post("/upload")
async def upload_screen_observation(
    session_id: str = Form(...),
    file: UploadFile = File(...),
    force_trigger: bool = Form(False),
    auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    """Persist one screen-share frame to the session's observations
    directory and (subject to the per-session cooldown) fire the
    ``[USER_OBSERVATION]`` trigger.

    Form fields:
      * ``session_id`` — required. Must match a live VTuber session
        owned by the caller. Without a live session the call is a
        404 — the screenshot has nowhere to land.
      * ``file`` — PNG / JPEG / WebP, ≤ 6 MB.
      * ``force_trigger`` — when true, bypasses the cooldown. Wired
        to the frontend "Show Now" button.

    Returns the ``ObservationResult`` dict including
    ``trigger_fired`` so the frontend can show "VTuber will react in
    a moment…" vs "saved to memory (next reaction in N min)".
    """
    if not _allowed(file.content_type):
        raise HTTPException(
            status_code=415,
            detail=f"unsupported content type: {file.content_type!r}",
        )

    chunks: list[bytes] = []
    received = 0
    while True:
        chunk = await file.read(64 * 1024)
        if not chunk:
            break
        received += len(chunk)
        if received > _MAX_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"upload exceeds {_MAX_BYTES} bytes",
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise HTTPException(status_code=400, detail="uploaded file is empty")

    sid = (session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id required")

    mime = (file.content_type or "image/png").split(";")[0].strip().lower()
    result = await save_and_maybe_trigger(
        session_id=sid,
        image_bytes=data,
        mime_type=mime,
        force_trigger=bool(force_trigger),
    )

    if result.skipped_reason == "session_not_found":
        raise HTTPException(
            status_code=404,
            detail="session not running — open the VTuber tab before sharing",
        )

    return result.to_dict()
