"""MCP Connectors API — enable/configure ecosystem connectors from the UI.

    GET  /api/connectors            -> catalog + per-connector {enabled, configured} (no secrets)
    GET  /api/connectors/{id}       -> one connector's field values (secrets masked)
    PUT  /api/connectors/{id}       -> { enabled, values: {field: value} }

A configured + enabled connector's MCP server is injected into sessions
(progressive disclosure) so its tools appear. See service.mcp_connectors.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from controller.auth_controller import require_auth
from service.mcp_connectors import CATALOG_BY_ID, catalog_status, ensure_registered

logger = getLogger(__name__)

router = APIRouter(prefix="/api/connectors", tags=["connectors"])


class ConnectorUpdate(BaseModel):
    enabled: bool = False
    values: Dict[str, Any] = Field(default_factory=dict)


def _mask(v: str) -> str:
    if not v:
        return ""
    return "••••" + v[-4:] if len(v) > 4 else "••••"


@router.get("")
async def list_connectors(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    return {"connectors": catalog_status()}


@router.get("/{connector_id}")
async def get_connector(connector_id: str, _auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    ensure_registered()
    c = CATALOG_BY_ID.get(connector_id)
    if c is None:
        raise HTTPException(404, detail={"code": "connector.not_found", "reason": connector_id})
    from service.config import get_config_manager

    mgr = get_config_manager()
    cls = mgr.get_registered_config_classes().get(c.config_name)
    cfg = mgr.load_config(cls) if cls else None
    out: Dict[str, Any] = {"id": c.id, "enabled": bool(getattr(cfg, "enabled", False)), "values": {}}
    for f in c.fields:
        val = getattr(cfg, f.name, "") if cfg else ""
        out["values"][f.name] = _mask(val) if f.secure else val
    return out


@router.put("/{connector_id}")
async def update_connector(
    connector_id: str, req: ConnectorUpdate, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    ensure_registered()
    c = CATALOG_BY_ID.get(connector_id)
    if c is None:
        raise HTTPException(404, detail={"code": "connector.not_found", "reason": connector_id})
    from service.config import get_config_manager

    # Only persist known fields; skip masked placeholders (unchanged secrets).
    payload: Dict[str, Any] = {"enabled": bool(req.enabled)}
    for f in c.fields:
        if f.name in req.values:
            v = req.values[f.name]
            if isinstance(v, str) and v.startswith("••••"):
                continue  # masked → keep stored value
            payload[f.name] = v
    get_config_manager().update_config(c.config_name, payload)
    return {"ok": True, "id": c.id}
