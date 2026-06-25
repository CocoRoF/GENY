"""Cross-service settings sync — provider-key propagation control.

Geny is the source of truth for shared provider API keys; they auto-propagate to
connected sister services (GAPT vault, geny-avatar config) on change. These
endpoints expose an explicit "Sync now" (re-push everything) + a target-status
read for the Settings UI.
"""

from logging import getLogger
from typing import Any, Dict

from fastapi import APIRouter, Depends

from service.auth.auth_middleware import require_auth
from service.sync.provider_key_sync import sync_all, sync_targets_status

logger = getLogger(__name__)

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.get("/targets")
async def get_sync_targets(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    """Which sync targets are wired (no network probe)."""
    return {"targets": sync_targets_status()}


@router.post("/provider-keys")
async def sync_provider_keys(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    """Re-push every currently-set provider key to all connected targets."""
    results = await sync_all()
    return {"ok": True, "results": results}
