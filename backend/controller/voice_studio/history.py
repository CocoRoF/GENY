"""
Voice Studio synthesis history endpoints.

- ``GET    /api/voice-studio/synth/history``         — recent rows (cap 20)
- ``GET    /api/voice-studio/synth/history/{id}/audio`` — stream stored WAV
- ``POST   /api/voice-studio/synth/history/{id}/replay`` — same params + same seed
- ``DELETE /api/voice-studio/synth/history/{id}``    — remove a row + its audio
"""

from __future__ import annotations

import json
from logging import getLogger
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response

from service.auth.auth_middleware import require_auth
from service.voice_studio.history_store import get_history_store
from service.voice_studio.synthesis_preview import PreviewParams

router = APIRouter()
logger = getLogger(__name__)

_MIME_BY_FORMAT = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "ogg": "audio/ogg",
    "pcm": "application/octet-stream",
}


@router.get("/synth/history")
async def list_history() -> dict:
    store = get_history_store()
    items = [row.to_dict() for row in store.list_recent()]
    return {"items": items, "count": len(items)}


@router.get("/synth/history/{id}/audio")
async def stream_history_audio(id: str) -> FileResponse:
    store = get_history_store()
    path = store.audio_path(id)
    if not path:
        raise HTTPException(status_code=404, detail=f"history id not found: {id}")
    return FileResponse(
        str(path),
        media_type="audio/wav",
        headers={"Cache-Control": "private, max-age=60"},
    )


@router.delete("/synth/history/{id}")
async def delete_history(id: str, auth: dict = Depends(require_auth)) -> dict:
    store = get_history_store()
    ok = store.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"history id not found: {id}")
    return {"ok": True}


@router.post("/synth/history/{id}/replay")
async def replay_history(id: str, auth: dict = Depends(require_auth)) -> Response:
    """Re-synthesize using the stored parameters (seed included).

    Returns ``audio/<fmt>`` bytes with the same ``X-VoiceStudio-*``
    headers as the original ``/synth/preview`` route. Does NOT itself
    insert a new history row — the caller can trigger ``synth/preview``
    again if they want fresh history.
    """
    store = get_history_store()
    row = store.get(id)
    if not row:
        raise HTTPException(status_code=404, detail=f"history id not found: {id}")

    try:
        stored_params = json.loads(row["params_json"])
    except Exception as e:
        logger.exception("voice-studio history replay: bad params_json")
        raise HTTPException(status_code=500, detail=f"bad stored params: {e}") from e

    try:
        params = PreviewParams.model_validate(stored_params)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"stored params invalid: {e}") from e

    from service.vtuber.tts.tts_service import get_tts_service

    engine = get_tts_service().get_engine("omnivoice")
    if engine is None:
        raise HTTPException(status_code=503, detail="OmniVoice engine not registered")

    try:
        result = await engine.synthesize_preview(params)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("voice-studio history replay synth failed")
        raise HTTPException(status_code=502, detail=f"replay failed: {e}") from e

    return Response(
        content=result.audio_bytes,
        media_type=_MIME_BY_FORMAT.get(params.audio_format, "application/octet-stream"),
        headers={
            "X-VoiceStudio-Sample-Rate": str(result.sample_rate),
            "X-VoiceStudio-RTF": f"{result.rtf:.4f}",
            "X-VoiceStudio-Seed-Used": str(result.seed_used) if result.seed_used is not None else "",
            "X-VoiceStudio-Duration-Seconds": f"{result.duration:.4f}",
            "X-VoiceStudio-Engine": "omnivoice",
        },
    )
