"""Executor-side capability tools (inverse MCP).

A ConnectorCapabilityTool mirrors MCPToolAdapter 1:1, but instead of calling an
MCP server it sends a ``capability_call`` over the session's connector WebSocket
(via ConnectorRegistry) and awaits the ``capability_result``. The native work
runs on the user's machine (in the connector); the server only proxies.

Registered through a duck-typed AdhocToolProvider (list_names/get) beside
GenyToolProvider; ``manifest.tools.external`` selects which capabilities a
session actually exposes (so adding the provider is inert until a manifest opts
in). Subclasses the already-installed geny_executor Tool ABC — no executor
reinstall needed.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from geny_executor.tools.base import Tool, ToolCapabilities, ToolContext, ToolResult

from service.executor.connector_registry import get_connector_registry


class ConnectorCapabilityTool(Tool):
    def __init__(
        self,
        *,
        name: str,
        description: str,
        input_schema: Dict[str, Any],
        capability: str,
        read_only: bool = True,
        destructive: bool = False,
        reason: str = "",
        timeout: float = 30.0,
    ) -> None:
        self._name = name
        self._description = description
        self._schema = input_schema
        self._capability = capability
        self._read_only = read_only
        self._destructive = destructive
        self._reason = reason
        self._timeout = timeout

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def input_schema(self) -> Dict[str, Any]:
        return self._schema

    def capabilities(self, input: Dict[str, Any]) -> ToolCapabilities:
        # destructive → matrix auto-escalates to ASK under PLAN mode; read-only
        # tools may fan out concurrently.
        return ToolCapabilities(
            read_only=self._read_only,
            destructive=self._destructive,
            concurrency_safe=self._read_only and not self._destructive,
        )

    async def execute(self, input: Dict[str, Any], context: ToolContext) -> ToolResult:
        reg = get_connector_registry()
        conn = reg.get(context.session_id)
        if conn is None:
            return ToolResult(content="connector offline — no desktop session is connected", is_error=True)
        if self._capability not in conn.accepted_capabilities:
            return ToolResult(
                content=f"capability '{self._capability}' is not supported by this connector", is_error=True
            )
        try:
            payload = await conn.capability_call(self._capability, input, self._reason, timeout=self._timeout)
        except Exception as exc:  # transport / timeout — clean is_error, never raw
            return ToolResult(content=f"connector transport error: {exc}", is_error=True)
        if not isinstance(payload, dict) or not payload.get("ok"):
            msg = (payload or {}).get("error") or ("denied by the user" if (payload or {}).get("denied") else "capability failed")
            return ToolResult(content=str(msg), is_error=True)
        result = payload.get("result")
        content = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
        return ToolResult(content=content)


def _build_tools() -> Dict[str, ConnectorCapabilityTool]:
    """The capability tools advertised to sessions. Phase-4/6 tools land here."""
    return {
        "connector_ping": ConnectorCapabilityTool(
            name="connector_ping",
            description=(
                "Ping the user's desktop connector to confirm the capability bridge is live. "
                "Returns the connector's pong payload."
            ),
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            capability="ping",
            read_only=True,
            reason="capability-bridge health check",
            timeout=10.0,
        ),
    }


class ConnectorToolProvider:
    """Duck-typed AdhocToolProvider for connector capability tools."""

    def __init__(self) -> None:
        self._tools: Optional[Dict[str, ConnectorCapabilityTool]] = None

    def _ensure(self) -> Dict[str, ConnectorCapabilityTool]:
        if self._tools is None:
            self._tools = _build_tools()
        return self._tools

    def list_names(self) -> List[str]:
        return list(self._ensure().keys())

    def get(self, name: str) -> Optional[ConnectorCapabilityTool]:
        return self._ensure().get(name)
