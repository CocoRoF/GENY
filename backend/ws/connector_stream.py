"""``/ws/connector/{session_id}`` — the connector side of the capability bridge.

The desktop connector opens this socket per session, sends a ``hello`` with its
native capabilities, and thereafter the server can push ``capability_call``
frames (from a running agent's ConnectorCapabilityTool) and receive
``capability_result`` frames back.

Security: this socket can drive the user's machine, so it requires a real
authenticated user — it refuses anonymous connections even when no AuthService
is configured (unlike the read paths' no-DB fallback).
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from service.auth.auth_middleware import ws_auth_or_close
from service.executor.connector_registry import ConnectorConnection, get_connector_registry

router = APIRouter()
logger = logging.getLogger(__name__)


@router.websocket("/ws/connector/{session_id}")
async def connector_ws(websocket: WebSocket, session_id: str) -> None:
    auth = await ws_auth_or_close(websocket)
    if auth is None:
        return
    # Actuation-capable socket → never allow the anonymous no-DB fallback.
    if (auth.payload or {}).get("sub") in (None, "", "anonymous"):
        logger.warning("[ConnectorWS:%s] refused anonymous", session_id[:8])
        await websocket.close(code=4401)
        return

    await websocket.accept(subprotocol=auth.subprotocol)
    registry = get_connector_registry()
    conn: ConnectorConnection | None = None
    try:
        # Handshake: first frame must be hello{capabilities:[...]}. It may also
        # carry mcp_catalog — the connector's local MCP servers + tool schemas —
        # which we register as first-class session tools.
        hello = json.loads(await websocket.receive_text())
        caps = hello.get("capabilities", []) if isinstance(hello, dict) else []
        conn = ConnectorConnection(websocket, caps)
        if isinstance(hello, dict) and isinstance(hello.get("mcp_catalog"), list):
            conn.mcp_catalog = hello["mcp_catalog"]
        registry.register(session_id, conn)
        await websocket.send_json(
            {"type": "ready", "data": {"session_id": session_id, "accepted_capabilities": list(conn.accepted_capabilities)}}
        )
        logger.info("[ConnectorWS:%s] ready caps=%s", session_id[:8], sorted(conn.accepted_capabilities))
        if conn.mcp_catalog:
            _sync_mcp_tools(session_id, conn.mcp_catalog)

        # Receiver loop — the ONLY place this socket is read. capability_call
        # sends happen concurrently from tool tasks (guarded by a send lock).
        while True:
            try:
                msg = json.loads(await websocket.receive_text())
            except json.JSONDecodeError:
                continue
            mtype = msg.get("type")
            if mtype == "capability_result":
                data = msg.get("data") or {}
                rid = data.get("request_id")
                if rid:
                    conn.resolve_result(rid, data)
            elif mtype == "mcp_catalog":
                # Catalog refresh — servers (re)connected or tool lists changed.
                catalog = (msg.get("data") or {}).get("catalog")
                if isinstance(catalog, list):
                    conn.mcp_catalog = catalog
                    _sync_mcp_tools(session_id, catalog)
            elif mtype == "heartbeat":
                await websocket.send_json({"type": "heartbeat", "ts": msg.get("ts")})
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("[ConnectorWS:%s] error", session_id[:8])
    finally:
        if conn is not None:
            registry.unregister(session_id, conn)
            _clear_mcp_tools(session_id)
        logger.info("[ConnectorWS:%s] closed", session_id[:8])


def _sync_mcp_tools(session_id: str, catalog: list) -> None:
    """Register the catalog as first-class tools — never break the WS on it."""
    try:
        from service.executor.connector_mcp_tools import sync_session

        sync_session(session_id, catalog)
    except Exception:  # noqa: BLE001
        logger.exception("[ConnectorWS:%s] mcp catalog sync failed", session_id[:8])


def _clear_mcp_tools(session_id: str) -> None:
    try:
        from service.executor.connector_mcp_tools import clear_session

        clear_session(session_id)
    except Exception:  # noqa: BLE001
        logger.debug("[ConnectorWS:%s] mcp clear failed", session_id[:8], exc_info=True)
