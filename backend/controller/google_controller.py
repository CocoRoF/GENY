"""Google Workspace connection API (OAuth device flow).

    GET    /api/google/status      -> { has_client, connected }
    PUT    /api/google/client      -> save client_id / client_secret
    POST   /api/google/connect     -> start device flow (returns user_code + url)
    POST   /api/google/poll        -> poll once { device_code } -> { status }
    POST   /api/google/disconnect  -> clear the stored refresh token

The frontend "Google" card: enter the OAuth client → Connect (show code + url) →
poll until connected. Once connected, the native google_* tools (Gmail/Calendar/
Drive/Tasks) become available in sessions (progressive disclosure).
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from controller.auth_controller import require_auth
from service import google as google_oauth

logger = getLogger(__name__)

router = APIRouter(prefix="/api/google", tags=["google"])


class ClientRequest(BaseModel):
    client_id: str
    client_secret: str


class PollRequest(BaseModel):
    device_code: str


@router.get("/status")
async def status(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    return {
        "has_client": google_oauth.has_client(),
        "connected": google_oauth.is_connected(),
    }


@router.put("/client")
async def set_client(req: ClientRequest, _auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    from service.config import get_config_manager

    get_config_manager().update_config("google", {
        "client_id": req.client_id.strip(),
        "client_secret": req.client_secret.strip(),
    })
    return {"ok": True, "has_client": google_oauth.has_client()}


@router.post("/connect")
async def connect(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    try:
        return google_oauth.start_device_flow()
    except ValueError as e:
        raise HTTPException(412, detail={"code": "google.client_not_set", "reason": str(e)})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, detail={"code": "google.device_flow_failed", "reason": str(e)})


@router.post("/poll")
async def poll(req: PollRequest, _auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    return google_oauth.poll_once(req.device_code)


@router.post("/disconnect")
async def disconnect(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    google_oauth.disconnect()
    return {"ok": True}
