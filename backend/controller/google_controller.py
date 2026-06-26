"""Google Workspace connection API (OAuth 2.0 authorization-code flow).

    GET    /api/google/status      -> { has_client, connected }
    PUT    /api/google/client      -> save client_id / client_secret
    GET    /api/google/auth-url    -> { auth_url, redirect_uri }  (frontend opens it)
    GET    /api/google/callback    -> Google redirects here; exchanges code (PUBLIC)
    POST   /api/google/disconnect  -> clear the stored refresh token

Device flow was dropped: Google's device flow rejects Workspace scopes
(Gmail/Calendar/Drive/Tasks → invalid_scope). The authorization-code flow needs a
public https redirect URI, which the deployment's domain provides. The frontend
passes its own ``window.location.origin + /api/google/callback`` as the redirect
URI (so it always matches the domain the user is on); that exact URI must also be
registered in the Google Cloud "Web application" OAuth client.
"""

from __future__ import annotations

import json
from logging import getLogger
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from controller.auth_controller import require_auth
from service import google as google_oauth

logger = getLogger(__name__)

router = APIRouter(prefix="/api/google", tags=["google"])


class ClientRequest(BaseModel):
    client_id: str
    client_secret: str


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


@router.get("/auth-url")
async def auth_url(redirect_uri: str, _auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    """Build the Google consent URL. ``redirect_uri`` is supplied by the frontend
    (its own origin + /api/google/callback) and must be registered in the OAuth
    client. Returns it back so the UI can show exactly what to register."""
    try:
        return google_oauth.build_auth_url(redirect_uri.strip())
    except ValueError as e:
        raise HTTPException(412, detail={"code": "google.client_not_set", "reason": str(e)})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, detail={"code": "google.auth_url_failed", "reason": str(e)})


@router.get("/callback")
async def callback(code: str = "", state: str = "", error: str = "") -> HTMLResponse:
    """Google redirects the user's browser here after consent. PUBLIC (a top-level
    browser navigation carries no Geny auth header) — the CSRF ``state`` we minted
    in /auth-url is what authenticates the callback. Exchanges the code, stores the
    refresh token, then signals the opener window and closes."""
    if error:
        result = {"status": "error", "error": error}
    elif not code:
        result = {"status": "error", "error": "no_code"}
    else:
        try:
            result = google_oauth.exchange_code(code, state)
        except Exception as e:  # noqa: BLE001
            logger.warning("Google callback exchange error: %s", e)
            result = {"status": "error", "error": str(e)}

    ok = result.get("status") == "connected"
    msg = "✅ Google 연결이 완료되었습니다. 이 창은 닫아도 됩니다." if ok \
        else f"❌ 연결 실패: {result.get('error', 'unknown')}"
    payload = json.dumps({"type": "google-oauth", "ok": ok, "error": result.get("error", "")})
    close_ms = 1000 if ok else 6000
    html = (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>Google 연결</title></head>"
        "<body style=\"font-family:system-ui,sans-serif;padding:2.5rem;text-align:center;"
        "background:#0b0b0f;color:#e5e7eb\">"
        f"<p style='font-size:1.05rem'>{msg}</p>"
        "<script>"
        f"try{{if(window.opener)window.opener.postMessage({payload},'*');}}catch(e){{}}"
        f"setTimeout(function(){{window.close();}},{close_ms});"
        "</script></body></html>"
    )
    return HTMLResponse(html)


@router.post("/disconnect")
async def disconnect(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    google_oauth.disconnect()
    return {"ok": True}
