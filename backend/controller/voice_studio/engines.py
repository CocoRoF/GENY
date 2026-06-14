"""
Voice Studio engine endpoints.

- ``GET  /api/voice-studio/engines``        — Compatibility Matrix payload.
- ``POST /api/voice-studio/engines/default`` — persist the default engine
  (mirrored into ``tts_general_config.provider`` so the chat path stays
  in sync).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from service.auth.auth_middleware import require_auth
from service.voice_studio.engine_registry import (
    get_default_engine_name,
    list_engine_cards,
    set_default_engine_name,
)

router = APIRouter()


@router.get("/engines")
async def list_engines() -> dict:
    cards = await list_engine_cards()
    return {
        "engines": [c.to_dict() for c in cards],
        "default": get_default_engine_name(),
    }


class SetDefaultRequest(BaseModel):
    name: str = Field(..., min_length=1)


@router.post("/engines/default")
async def set_default(body: SetDefaultRequest, auth: dict = Depends(require_auth)) -> dict:
    cards = await list_engine_cards()
    valid = {c.id for c in cards}
    if body.name not in valid:
        raise HTTPException(
            status_code=400,
            detail=f"unknown engine '{body.name}' (registered: {sorted(valid)})",
        )
    set_default_engine_name(body.name)
    return {"ok": True, "default": body.name}
