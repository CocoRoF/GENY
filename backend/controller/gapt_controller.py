"""GAPT integration status API.

Lets the frontend detect whether the GAPT platform is wired up + reachable, so
it can conditionally show the GAPT button in the header and route to its UI.

- GET /api/gapt/status — {configured, running, base_url, ui_path}
- GET /api/gapt/sso   — establish a GAPT browser session (login bypass), then the
                        SPA opens already-authenticated. Toggle via GENY_GAPT_SSO_BYPASS.
"""

import os
import time
from logging import getLogger
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from service.auth.auth_middleware import require_auth
from service.gapt.client import GaptApiError, get_gapt_client

logger = getLogger(__name__)

router = APIRouter(prefix="/api/gapt", tags=["gapt"])


def _sso_bypass_enabled() -> bool:
    """Single sign-on bypass: an authenticated Geny user opens GAPT without a
    second login. ON by default; set GENY_GAPT_SSO_BYPASS=false to require GAPT's
    own login (e.g. when GAPT is exposed independently of Geny)."""
    return os.getenv("GENY_GAPT_SSO_BYPASS", "true").strip().lower() in ("1", "true", "yes", "on")

# The frontend polls this; cache the health probe briefly so we don't hit
# gapt-server on every poll across every open tab.
_cache: Dict[str, Any] = {"t": 0.0, "running": False}
_TTL_S = 5.0


@router.get("/status")
async def gapt_status(auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    """Is GAPT configured (GAPT_BASE_URL set) and answering /health?"""
    client = get_gapt_client()
    configured = client.configured
    if configured:
        now = time.monotonic()
        if now - _cache["t"] > _TTL_S:
            _cache["running"] = await client.health()
            _cache["t"] = now
        running = bool(_cache["running"])
    else:
        running = False
    return {
        "configured": configured,
        "running": running,
        "base_url": client.base_url if configured else "",
        # Served same-origin via nginx (/_gapt → gapt-caddy). The SPA lives
        # under /_gapt/app/.
        "ui_path": "/_gapt/app/",
        "sso_bypass": _sso_bypass_enabled(),
    }


@router.get("/sso")
async def gapt_sso(
    request: Request,
    response: Response,
    _auth: dict = Depends(require_auth),
) -> Dict[str, Any]:
    """Establish a GAPT browser session for the authenticated Geny user.

    With SSO bypass ON (default), the caller (already authenticated in Geny) gets
    a GAPT session cookie set on this same origin — so opening the GAPT SPA
    (/_gapt/app/) skips GAPT's own login. The frontend fetches this (with the Geny
    bearer), then navigates to ``ui_path``. With bypass OFF, no cookie is set and
    GAPT shows its own login.
    """
    ui_path = "/_gapt/app/"
    if not _sso_bypass_enabled():
        return {"bypass": False, "ui_path": ui_path}
    client = get_gapt_client()
    if not client.configured:
        raise HTTPException(
            status_code=412,
            detail={"code": "gapt.not_configured", "reason": "GAPT_BASE_URL is not set"},
        )
    try:
        cookies = await client.issue_browser_session()
    except GaptApiError as exc:
        raise HTTPException(
            status_code=exc.status or 502,
            detail={"code": exc.code or "gapt.error", "reason": exc.reason or str(exc)},
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"code": "gapt.unreachable", "reason": str(exc)})
    secure = request.url.scheme == "https"
    for name, value in cookies:
        # Same-origin as /_gapt (nginx), so the browser sends it on GAPT requests.
        response.set_cookie(
            key=name, value=value, path="/",
            httponly=True, secure=secure, samesite="lax",
        )
    return {"bypass": True, "ui_path": ui_path, "established": [n for n, _ in cookies]}
