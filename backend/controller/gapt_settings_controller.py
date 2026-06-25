"""GAPT settings proxy — manage a connected GAPT instance's settings from Geny.

When GAPT is connected (``GET /api/gapt/status`` → running), Geny's Settings UI
shows a **GAPT** category. These endpoints proxy GAPT's own runtime-mutable
provider settings (primarily **Cloudflare**, plus LLM-backend health + a routing
readiness probe) through the shared :class:`GaptClient`, which already handles
GAPT's single-admin cookie auth + error normalization. Geny adds nothing but its
own auth gate + a 412 when GAPT isn't configured.

Boot-time GAPT env settings (Caddy domains/ports/secrets) are NOT mutable over
GAPT's API and are intentionally not exposed here; ``/diagnose`` surfaces the
relevant read-only routing state.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from service.auth.auth_middleware import require_auth
from service.gapt.client import GaptApiError, get_gapt_client

logger = getLogger(__name__)

router = APIRouter(prefix="/api/gapt/settings", tags=["gapt-settings"])

_CF = "/_gapt/api/providers/cloudflare"


def _gapt():
    """The shared GAPT client, or 412 when GAPT isn't configured."""
    gc = get_gapt_client()
    if not gc.configured:
        raise HTTPException(
            status_code=412,
            detail={"code": "gapt.not_configured", "reason": "GAPT_BASE_URL is not set"},
        )
    return gc


async def _proxy(method: str, path: str, *, json: Any = None) -> Any:
    """Call a GAPT endpoint, mapping its errors to clean HTTP responses."""
    gc = _gapt()
    try:
        return await gc.request(method, path, json=json)
    except GaptApiError as exc:
        # Surface GAPT's own status/code/reason rather than a generic 500.
        raise HTTPException(
            status_code=exc.status or 502,
            detail={"code": exc.code or "gapt.error", "reason": exc.reason or str(exc)},
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — network / unexpected
        logger.warning("GAPT settings proxy %s %s failed: %s", method, path, exc, exc_info=True)
        raise HTTPException(
            status_code=502,
            detail={"code": "gapt.unreachable", "reason": str(exc)},
        )


# ── Cloudflare ────────────────────────────────────────────────────────


class PutCloudflareRequest(BaseModel):
    """Mirror of GAPT's PutCloudflareConfigRequest (api_token write-only)."""

    api_token: str | None = None
    config: Dict[str, Any]


@router.get("/cloudflare")
async def get_cloudflare(_auth: dict = Depends(require_auth)) -> Any:
    """Current Cloudflare provider config (no token) + verified_at."""
    return await _proxy("GET", _CF)


@router.put("/cloudflare")
async def put_cloudflare(body: PutCloudflareRequest, _auth: dict = Depends(require_auth)) -> Any:
    """Set/replace the token + account/zone/tunnel/domain selection."""
    return await _proxy("PUT", _CF, json=body.model_dump(exclude_none=True))


@router.delete("/cloudflare")
async def delete_cloudflare(_auth: dict = Depends(require_auth)) -> Any:
    """Clear the Cloudflare config + remove the stored token."""
    return await _proxy("DELETE", _CF)


@router.post("/cloudflare/verify")
async def verify_cloudflare(body: Dict[str, Any] | None = None, _auth: dict = Depends(require_auth)) -> Any:
    """Round-trip the token + discover accounts/zones/tunnels (drives dropdowns)."""
    return await _proxy("POST", f"{_CF}/verify", json=body or {})


@router.get("/cloudflare/tunnel/snapshot")
async def tunnel_snapshot(_auth: dict = Depends(require_auth)) -> Any:
    """Current ingress + inferred tunnel mode (remote_managed/local_config)."""
    return await _proxy("GET", f"{_CF}/tunnel/snapshot")


@router.post("/cloudflare/tunnel/ensure-wildcard")
async def ensure_wildcard(body: Dict[str, Any] | None = None, _auth: dict = Depends(require_auth)) -> Any:
    """Idempotently upsert the `*.<domain>` wildcard ingress."""
    return await _proxy("POST", f"{_CF}/tunnel/ensure-wildcard", json=body or {})


@router.get("/cloudflare/cert/status")
async def cert_status(_auth: dict = Depends(require_auth)) -> Any:
    """Wildcard cert state + Cloudflare dashboard deep-links."""
    return await _proxy("GET", f"{_CF}/cert/status")


@router.post("/cloudflare/cert/enable-total-tls")
async def enable_total_tls(body: Dict[str, Any] | None = None, _auth: dict = Depends(require_auth)) -> Any:
    """Enable Cloudflare Total TLS (issues edge certs for `*.<domain>`)."""
    return await _proxy("POST", f"{_CF}/cert/enable-total-tls", json=body or {})


# ── Routing readiness + LLM health (read-only) ────────────────────────


@router.get("/diagnose")
async def diagnose(_auth: dict = Depends(require_auth)) -> Any:
    """End-to-end routing/tunnel/cert readiness preflight (the traffic-light)."""
    return await _proxy("GET", "/_gapt/api/preview/diagnose")


@router.get("/llm-health")
async def llm_health(_auth: dict = Depends(require_auth)) -> Any:
    """GAPT's per-provider LLM backend readiness (ok/missing/expired/unreachable)."""
    return await _proxy("GET", "/_gapt/api/llm-backends/health")
