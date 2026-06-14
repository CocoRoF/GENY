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
        # Handshake: first frame must be hello{capabilities:[...]}.
        hello = json.loads(await websocket.receive_text())
        caps = hello.get("capabilities", []) if isinstance(hello, dict) else []
        conn = ConnectorConnection(websocket, caps)
        registry.register(session_id, conn)
        await websocket.send_json(
            {"type": "ready", "data": {"session_id": session_id, "accepted_capabilities": list(conn.accepted_capabilities)}}
        )
        logger.info("[ConnectorWS:%s] ready caps=%s", session_id[:8], sorted(conn.accepted_capabilities))

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
            elif mtype == "heartbeat":
                await websocket.send_json({"type": "heartbeat", "ts": msg.get("ts")})
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("[ConnectorWS:%s] error", session_id[:8])
    finally:
        if conn is not None:
            registry.unregister(session_id, conn)
        logger.info("[ConnectorWS:%s] closed", session_id[:8])
