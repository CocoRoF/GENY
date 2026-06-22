"""GAPT integration status API.

Lets the frontend detect whether the GAPT platform is wired up + reachable, so
it can conditionally show the GAPT button in the header and route to its UI.

- GET /api/gapt/status — {configured, running, base_url, ui_path}
"""

import time
from logging import getLogger
from typing import Any, Dict

from fastapi import APIRouter, Depends

from service.auth.auth_middleware import require_auth
from service.gapt.client import get_gapt_client

logger = getLogger(__name__)

router = APIRouter(prefix="/api/gapt", tags=["gapt"])

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
    }
