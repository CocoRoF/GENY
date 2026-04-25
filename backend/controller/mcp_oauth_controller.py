"""MCP OAuth + URI controller (G10.2 / G10.3).

Two endpoints:

- POST /api/agents/{id}/mcp/servers/{name}/auth/start →
  Start OAuth authorization for a server. Returns the URL the
  operator opens in a browser. The executor's ``OAuthFlow`` runs a
  local callback server; once the operator finishes consent the
  token lands in the credential store and the server transitions
  out of NEEDS_AUTH on its next reconnect.

- GET /api/mcp/resources?uri=mcp://server/path →
  Resolve an ``mcp://`` URI to the actual resource content via the
  attached MCPManager.

Both depend on the executor 1.0 surface. Each endpoint returns 409
when the manager doesn't expose the relevant method, so older host
pins degrade gracefully instead of 500.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from controller.auth_controller import require_auth

logger = getLogger(__name__)

agent_oauth_router = APIRouter(prefix="/api/agents", tags=["mcp"])
mcp_resource_router = APIRouter(prefix="/api/mcp", tags=["mcp"])


def _resolve_pipeline(session_id: str):
    # Local import to avoid circular: agent_controller imports from auth.
    from controller import agent_controller as ac

    agent = ac.agent_manager.get_agent(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    pipeline = getattr(agent, "_pipeline", None)
    if pipeline is None:
        raise HTTPException(
            status_code=409,
            detail=f"Session {session_id} has no built pipeline yet",
        )
    return pipeline


def _resolve_manager(session_id: str):
    pipeline = _resolve_pipeline(session_id)
    manager = getattr(pipeline, "_mcp_manager", None) or getattr(
        pipeline, "mcp_manager", None
    )
    if manager is None:
        raise HTTPException(
            status_code=409,
            detail=f"Session {session_id} pipeline has no MCPManager attached",
        )
    return manager


# ── G10.2: OAuth start ─────────────────────────────────────────────


class OAuthStartResponse(BaseModel):
    session_id: str
    server: str
    authorize_url: str = Field(..., description="Open this URL in the operator browser to consent")


@agent_oauth_router.post(
    "/{session_id}/mcp/servers/{name}/auth/start",
    response_model=OAuthStartResponse,
    summary="Start OAuth authorization for an MCP server",
)
async def oauth_start(
    session_id: str = Path(...),
    name: str = Path(...),
    auth: dict = Depends(require_auth),
):
    """Dispatches to ``MCPManager.start_oauth(server_name)`` (or the
    equivalent low-level OAuthFlow.authorize call). Returns the
    authorization URL — the operator opens it in a browser.

    The executor's OAuthFlow binds a local HTTP callback server,
    waits for the consent redirect, and writes the token into the
    attached credential store (G10.1). Once the token lands, the
    server transitions out of NEEDS_AUTH on the next connect.
    """
    manager = _resolve_manager(session_id)

    # Try a few common method names — the executor surface settled
    # late in the 1.0 cycle. Fall through to OAuthFlow direct as a
    # last resort.
    for attr in ("start_oauth", "authorize", "begin_oauth"):
        starter = getattr(manager, attr, None)
        if callable(starter):
            try:
                result = starter(name)
                if hasattr(result, "__await__"):
                    result = await result
            except Exception as exc:
                raise HTTPException(status_code=400, detail=f"oauth start failed: {exc}")
            url = getattr(result, "authorize_url", None) or (
                result if isinstance(result, str) else None
            )
            if not url:
                raise HTTPException(
                    status_code=500,
                    detail=f"{attr} returned no authorize_url",
                )
            return OAuthStartResponse(session_id=session_id, server=name, authorize_url=url)

    raise HTTPException(
        status_code=409,
        detail="MCPManager has no OAuth start hook — geny-executor < 1.0 or transport without OAuth support",
    )


# ── G10.3: mcp:// URI resolution ───────────────────────────────────


class MCPResourceResponse(BaseModel):
    uri: str
    server: str
    resource_id: str
    content: Any = Field(..., description="Resource content as returned by the MCP server")
    mime_type: Optional[str] = None


@mcp_resource_router.get(
    "/resources",
    response_model=MCPResourceResponse,
    summary="Resolve an mcp:// URI to a resource",
)
async def resolve_mcp_uri(
    uri: str = Query(..., description="mcp://server/path URI"),
    session_id: Optional[str] = Query(
        None,
        description="Session id to resolve through. When omitted, uses any session whose manager knows the server.",
    ),
    auth: dict = Depends(require_auth),
):
    """Parse an ``mcp://`` URI and read the resource via
    ``MCPManager.read_resource`` (or equivalent).

    For session_id-aware operation: pass the session id whose
    pipeline holds the manager. Without session_id we walk every
    live session — first match wins. Useful for the frontend's URI
    click handler when the link doesn't carry a session context.
    """
    try:
        from geny_executor.tools.mcp.uri import is_mcp_uri, parse_mcp_uri
    except ImportError:
        raise HTTPException(
            status_code=409, detail="geny_executor.tools.mcp.uri unavailable"
        )

    if not is_mcp_uri(uri):
        raise HTTPException(status_code=400, detail=f"Not an mcp:// URI: {uri}")
    server, resource_id = parse_mcp_uri(uri)

    if session_id:
        manager = _resolve_manager(session_id)
    else:
        # Walk live sessions for any manager that knows ``server``.
        from controller import agent_controller as ac

        manager = None
        for sess_id in ac.agent_manager.list_session_ids() if hasattr(ac.agent_manager, "list_session_ids") else []:
            try:
                mgr = _resolve_manager(sess_id)
            except HTTPException:
                continue
            configs = getattr(mgr, "_configs", None) or getattr(mgr, "configs", None)
            if isinstance(configs, dict) and server in configs:
                manager = mgr
                break
        if manager is None:
            raise HTTPException(
                status_code=404,
                detail=f"No live session knows MCP server '{server}'",
            )

    reader = getattr(manager, "read_resource", None) or getattr(manager, "fetch_resource", None)
    if not callable(reader):
        raise HTTPException(
            status_code=409,
            detail="MCPManager has no read_resource hook — geny-executor < 1.0",
        )
    try:
        result = reader(server, resource_id)
        if hasattr(result, "__await__"):
            result = await result
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"read_resource failed: {exc}")

    content: Any = result
    mime_type: Optional[str] = None
    if isinstance(result, dict):
        content = result.get("content", result)
        mime_type = result.get("mime_type") or result.get("mimeType")

    return MCPResourceResponse(
        uri=uri,
        server=server,
        resource_id=resource_id,
        content=content,
        mime_type=mime_type,
    )
