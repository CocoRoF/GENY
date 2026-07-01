"""Connector capability registry — the server side of the inverse-MCP bridge.

A running agent turn (via a ConnectorCapabilityTool) calls
``registry.get(session_id).capability_call(...)`` which sends a
``capability_call`` frame down the session's live connector WebSocket and
awaits the matching ``capability_result`` (correlated by ``request_id``).

This mirrors the executor's PipelineResumeRequester future-correlation, but on
a SEPARATE id namespace from HITL (``request_id`` here vs ``HITLRequest.token``
for /hitl/resume) — the two must never be conflated.

Fail-closed: a dropped connector resolves every pending future with a transport
error so an executor turn never hangs.
"""

from __future__ import annotations

import asyncio
import secrets
from typing import Any, Dict, Optional


class ConnectorConnection:
    """One live connector WebSocket for a session + its pending calls."""

    def __init__(self, websocket: Any, accepted_capabilities: Any) -> None:
        self._ws = websocket
        self.accepted_capabilities = set(accepted_capabilities or [])
        self._pending: Dict[str, "asyncio.Future[dict]"] = {}
        # Serialize sends — concurrent tool calls must not interleave frames on
        # one socket (concurrent receive lives only in the WS handler loop).
        self._send_lock = asyncio.Lock()

    async def capability_call(
        self, tool: str, args: Any, reason: str = "", timeout: float = 30.0
    ) -> dict:
        request_id = secrets.token_urlsafe(16)
        fut: "asyncio.Future[dict]" = asyncio.get_event_loop().create_future()
        self._pending[request_id] = fut
        try:
            async with self._send_lock:
                await self._ws.send_json(
                    {
                        "type": "capability_call",
                        "data": {"request_id": request_id, "tool": tool, "args": args, "reason": reason},
                    }
                )
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(request_id, None)

    def resolve_result(self, request_id: str, payload: dict) -> None:
        fut = self._pending.get(request_id)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    def cancel_all(self, reason: str = "connector disconnected") -> None:
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(ConnectionError(reason))
        self._pending.clear()


class ConnectorRegistry:
    """One connection per session (single-admin; last-writer-wins on reconnect)."""

    def __init__(self) -> None:
        self._conns: Dict[str, ConnectorConnection] = {}

    def register(self, session_id: str, conn: ConnectorConnection) -> None:
        old = self._conns.get(session_id)
        if old is not None and old is not conn:
            old.cancel_all("replaced by a new connector connection")
        self._conns[session_id] = conn

    def unregister(self, session_id: str, conn: Optional[ConnectorConnection] = None) -> None:
        cur = self._conns.get(session_id)
        if cur is not None and (conn is None or cur is conn):
            cur.cancel_all()
            self._conns.pop(session_id, None)

    def get(self, session_id: str) -> Optional[ConnectorConnection]:
        # Exact match: the session the desktop connector attached to.
        conn = self._conns.get(session_id)
        if conn is not None:
            return conn
        # Delegated sub-agents run under a DERIVED id that keeps the parent
        # session as a prefix — the owned companion is "{parent}-subagent" and a
        # one-shot sub-worker is "{parent}-{type}-{uuid}". The desktop is the
        # user's, attached to the PARENT overlay session, so route the sub-agent's
        # capability call to the parent's connector. Longest matching prefix wins
        # (handles nested delegation). O(n) over the few live connectors.
        best: Optional[ConnectorConnection] = None
        best_len = -1
        for sid, c in self._conns.items():
            if session_id.startswith(sid + "-") and len(sid) > best_len:
                best, best_len = c, len(sid)
        return best

    def has(self, session_id: str) -> bool:
        return session_id in self._conns


_registry: Optional[ConnectorRegistry] = None


def get_connector_registry() -> ConnectorRegistry:
    """Process-wide singleton — the WS handler (via app.state) and the executor
    capability Tool (via this getter) MUST resolve the same instance."""
    global _registry
    if _registry is None:
        _registry = ConnectorRegistry()
    return _registry
