"""
``GET / PUT /api/voice-studio/settings/omnivoice-defaults`` —
read/write the subset of ``OmniVoiceConfig`` that the Synthesize card's
Advanced panel uses as its initial values.

The fields here mirror what :class:`SynthesizeCard` actually pulls in;
omnivoice-server-side env (``OMNIVOICE_DEFAULT_NUM_STEP``, etc.) stays
untouched — those are the floor that backend forwards if the request
omits a field. This endpoint controls the **UI defaults** that pre-fill
the Advanced panel.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from service.auth.auth_middleware import require_auth

router = APIRouter()


class OmniVoiceDefaults(BaseModel):
    num_step: int = Field(..., ge=1, le=128)
    guidance_scale: float = Field(..., ge=0.0, le=10.0)
    speed: float = Field(..., gt=0.0, le=4.0)
    duration_seconds: float = Field(..., ge=0.0, le=120.0)
    denoise: bool
    audio_format: Literal["wav", "mp3", "ogg", "pcm"]


def _load_cfg():  # type: ignore[no-untyped-def]
    from service.config.manager import get_config_manager
    from service.config.sub_config.tts.omnivoice_config import OmniVoiceConfig

    return get_config_manager(), OmniVoiceConfig


@router.get("/settings/omnivoice-defaults")
async def get_omnivoice_defaults() -> OmniVoiceDefaults:
    mgr, OmniVoiceConfig = _load_cfg()
    cfg = mgr.load_config(OmniVoiceConfig)
    return OmniVoiceDefaults(
        num_step=cfg.num_step,
        guidance_scale=cfg.guidance_scale,
        speed=cfg.speed,
        duration_seconds=cfg.duration_seconds,
        denoise=cfg.denoise,
        audio_format=cfg.audio_format,
    )


@router.put("/settings/omnivoice-defaults")
async def put_omnivoice_defaults(
    body: OmniVoiceDefaults, auth: dict = Depends(require_auth)
) -> OmniVoiceDefaults:
    mgr, OmniVoiceConfig = _load_cfg()
    cfg = mgr.load_config(OmniVoiceConfig)
    cfg.num_step = body.num_step
    cfg.guidance_scale = body.guidance_scale
    cfg.speed = body.speed
    cfg.duration_seconds = body.duration_seconds
    cfg.denoise = body.denoise
    cfg.audio_format = body.audio_format
    if not mgr.save_config(cfg):
        raise HTTPException(status_code=500, detail="failed to persist OmniVoiceConfig")
    return body
