"""geny-avatar integration — status + settings proxy.

Lets Geny detect a connected geny-avatar instance and manage its settings (the
image-gen provider keys) from Geny's Settings UI under an "Avatar" category. The
keys are Geny-owned (LLM/Media credentials, auto-synced); this surfaces the
avatar's live key status + a manual sync, and allows direct edits via the avatar's
config API. Connection is env-only (``GENY_AVATAR_BASE_URL``), mirroring GAPT.
"""

import time
from logging import getLogger
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from service.auth.auth_middleware import require_auth
from service.avatar.client import get_avatar_client

logger = getLogger(__name__)

router = APIRouter(prefix="/api/avatar", tags=["avatar"])

_cache: Dict[str, Any] = {"t": 0.0, "running": False}
_TTL_S = 5.0


def _avatar():
    ac = get_avatar_client()
    if not ac.configured:
        raise HTTPException(
            status_code=412,
            detail={"code": "avatar.not_configured", "reason": "GENY_AVATAR_BASE_URL is not set"},
        )
    return ac


@router.get("/status")
async def avatar_status(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    """Is geny-avatar configured (GENY_AVATAR_BASE_URL set) and answering?"""
    client = get_avatar_client()
    configured = client.configured
    running = False
    if configured:
        now = time.monotonic()
        if now - _cache["t"] > _TTL_S:
            _cache["running"] = await client.health()
            _cache["t"] = now
        running = bool(_cache["running"])
    return {"configured": configured, "running": running, "base_url": client.base_url if configured else ""}


@router.get("/settings/keys")
async def get_keys(_auth: dict = Depends(require_auth)) -> Any:
    """The avatar's current image-gen key status (masked previews, never raw)."""
    try:
        return await _avatar().get_config_keys()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"code": "avatar.unreachable", "reason": str(exc)})


class PutKeysRequest(BaseModel):
    set: Optional[Dict[str, str]] = None
    clear: Optional[List[str]] = None


@router.put("/settings/keys")
async def put_keys(body: PutKeysRequest, _auth: dict = Depends(require_auth)) -> Any:
    """Set/clear avatar keys directly (by avatar provider id: openai/gemini/falai/replicate)."""
    try:
        return await _avatar().put_config_keys(set_=body.set or None, clear=body.clear or None)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"code": "avatar.unreachable", "reason": str(exc)})
