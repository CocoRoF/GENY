"""
STT Controller — diagnostic + on-demand transcription endpoint.

The whiteboard audio capture flow (W2) auto-transcribes via the
post-capture hook, so end users rarely hit this endpoint directly.
It exists for:

  1. Operator sanity checks ("is whisper-stt up?") — POST a small
     wav and see if the body comes back populated.
  2. The optional ``whiteboard_transcribe`` agent tool (W4) which
     re-transcribes an attachment on demand and reaches this code
     path via the internal client (not via HTTP).
  3. Future frontend re-transcribe button on a voice note.

The endpoint deliberately mirrors the shape of the underlying vLLM
service (file + optional language + optional model override) and
returns a :class:`TranscriptionResult` JSON.

Best-effort throughout: WhisperClient catches every external failure
and surfaces it as a 200 with ``source: "unavailable"`` + ``error``.
That keeps the diagnostic semantics ("did we reach the service?")
clear from operational failures ("the service answered but refused
this audio").
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from service.auth.auth_middleware import require_auth
from service.stt.whisper_client import get_whisper_client

logger = getLogger(__name__)

router = APIRouter(prefix="/api/stt", tags=["stt"])


# ── Same per-file upload safety as whiteboard_controller ──────────────


_MAX_AUDIO_BYTES = 50 * 1024 * 1024  # 50 MB — long-form audio room

_ALLOWED_AUDIO_TYPES: frozenset[str] = frozenset(
    {
        "audio/webm",
        "audio/ogg",
        "audio/mpeg",
        "audio/mp3",
        "audio/mp4",
        "audio/m4a",
        "audio/x-m4a",
        "audio/wav",
        "audio/x-wav",
        "audio/wave",
        "audio/flac",
        # Some browsers send video container for MediaRecorder webm
        # output. vLLM's librosa decoder still extracts audio fine.
        "video/webm",
        "application/octet-stream",
    }
)


def _is_allowed_audio(content_type: Optional[str]) -> bool:
    if not content_type:
        return True
    primary = content_type.split(";")[0].strip().lower()
    return primary in _ALLOWED_AUDIO_TYPES


# ── Endpoints ─────────────────────────────────────────────────────────


@router.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    """Transcribe an audio upload via the in-cluster Whisper service.

    Returns JSON with the canonical :class:`TranscriptionResult`
    fields. Operational failures (whisper-stt down, timeout, etc.)
    come back with HTTP 200 + ``source: "unavailable"`` so the
    frontend can branch on ``source`` instead of HTTP status.
    """
    if not _is_allowed_audio(file.content_type):
        raise HTTPException(
            status_code=415,
            detail=f"unsupported content type: {file.content_type!r}",
        )

    # Bounded read — mirror whiteboard_controller pattern.
    chunks: list[bytes] = []
    received = 0
    while True:
        chunk = await file.read(64 * 1024)
        if not chunk:
            break
        received += len(chunk)
        if received > _MAX_AUDIO_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"upload exceeds {_MAX_AUDIO_BYTES} bytes",
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise HTTPException(status_code=400, detail="uploaded file is empty")

    client = get_whisper_client()
    result = await client.atranscribe(
        data,
        filename=file.filename or "audio.webm",
        language=language or None,
    )
    return {
        "text": result.text,
        "language": result.language,
        "duration_seconds": result.duration_seconds,
        "source": result.source,
        "error": result.error,
    }


@router.get("/health")
async def health(auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    """Lightweight reachability probe for the Whisper service.

    Sends a tiny silent-byte transcribe so we exercise the actual
    code path (HTTP pool + auth + endpoint shape) rather than just
    pinging a separate health URL. Returns the resulting source +
    error so operators can quickly see *why* it's down.
    """
    # A 1-byte payload won't decode to anything useful, but it
    # roundtrips the HTTP stack and lets us detect "service is
    # there but rejects malformed audio" vs "service is unreachable".
    client = get_whisper_client()
    result = await client.atranscribe(b"\x00", filename="probe.bin")
    reachable = result.source in ("whisper",) or (
        result.source == "unavailable"
        and result.error
        and "HTTP " in str(result.error)
    )
    return {
        "reachable": reachable,
        "source": result.source,
        "error": result.error,
    }
