"""
``POST /api/voice-studio/synth/preview``.

Voice Studio Synthesize card backend. Forwards the user-supplied
parameter surface (text + mode + emotion + advanced) to OmniVoice via
:meth:`OmniVoiceEngine.synthesize_preview` and streams the resulting
audio back with informative ``X-VoiceStudio-*`` headers.

Distinct from the chat-path ``/api/tts/agents/{sid}/speak`` family —
this route does NOT apply adaptive ``num_step`` or implicit emotion
mapping; the user already dialled the values in.
"""

from __future__ import annotations

from logging import getLogger

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from service.voice_studio.synthesis_preview import PreviewParams

router = APIRouter()
logger = getLogger(__name__)

_MIME_BY_FORMAT = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "ogg": "audio/ogg",
    "pcm": "application/octet-stream",
}


@router.post("/synth/preview")
async def synth_preview(params: PreviewParams) -> Response:
    from service.vtuber.tts.tts_service import get_tts_service

    engine = get_tts_service().get_engine("omnivoice")
    if engine is None:
        raise HTTPException(status_code=503, detail="OmniVoice engine not registered")

    try:
        result = await engine.synthesize_preview(params)
    except ValueError as e:
        # User-facing validation errors (missing instruct on design,
        # profile without ref on clone, OmniVoice disabled).
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("voice-studio synth/preview failed")
        raise HTTPException(status_code=502, detail=f"synth/preview failed: {e}") from e

    # Best-effort: append to history. A failure here must not block the
    # synthesis response — the user still gets their audio.
    history_id: str = ""
    try:
        from service.voice_studio.history_store import get_history_store

        history_id = get_history_store().insert(
            text=params.text,
            profile=params.profile,
            engine="omnivoice",
            mode=params.mode,
            seed=result.seed_used,
            params=params.model_dump(exclude_none=True),
            audio_bytes=result.audio_bytes,
            duration_seconds=result.duration,
            rtf=result.rtf,
            sample_rate=result.sample_rate,
        )
    except Exception:
        logger.warning("voice-studio history insert failed", exc_info=True)

    return Response(
        content=result.audio_bytes,
        media_type=_MIME_BY_FORMAT.get(params.audio_format, "application/octet-stream"),
        headers={
            "X-VoiceStudio-Sample-Rate": str(result.sample_rate),
            "X-VoiceStudio-RTF": f"{result.rtf:.4f}",
            "X-VoiceStudio-Seed-Used": str(result.seed_used) if result.seed_used is not None else "",
            "X-VoiceStudio-Duration-Seconds": f"{result.duration:.4f}",
            "X-VoiceStudio-Engine": "omnivoice",
            "X-VoiceStudio-History-Id": history_id,
        },
    )
