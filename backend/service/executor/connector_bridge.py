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

import base64
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


class DesktopGlanceTool(ConnectorCapabilityTool):
    """Capture a fresh frame of the user's screen via the connector, caption it
    with the vision LLM, and return the caption text (the agent can't read raw
    bytes). Read-only; uses the existing screen-observation caption path WITHOUT
    firing the proactive [USER_OBSERVATION] trigger (no cooldown-bypass spam)."""

    async def execute(self, input: Dict[str, Any], context: ToolContext) -> ToolResult:
        reg = get_connector_registry()
        conn = reg.get(context.session_id)
        if conn is None:
            return ToolResult(content="connector offline — no desktop session is connected", is_error=True)
        if "screen_capture" not in conn.accepted_capabilities:
            return ToolResult(content="screen capture is not available on this connector", is_error=True)
        try:
            payload = await conn.capability_call("screen_capture", input, "agent desktop glance", timeout=30.0)
        except Exception as exc:
            return ToolResult(content=f"connector transport error: {exc}", is_error=True)
        if not isinstance(payload, dict) or not payload.get("ok"):
            msg = (payload or {}).get("error") or ("denied by the user" if (payload or {}).get("denied") else "capture failed")
            return ToolResult(content=str(msg), is_error=True)
        result = payload.get("result") or {}
        b64 = result.get("image_b64")
        if not b64:
            return ToolResult(content="connector returned no image", is_error=True)
        mime = result.get("mime", "image/jpeg")
        label = result.get("source_name") or "screen"
        try:
            raw = base64.b64decode(b64.split(",", 1)[-1])  # tolerate a data: URL prefix
            from service.vtuber.screen_observation import _caption_image

            caption, source = await _caption_image(raw, mime_type=mime)
        except Exception as exc:
            return ToolResult(content=f"caption failed: {exc}", is_error=True)
        if caption:
            return ToolResult(content=f"[desktop glance — {label}] {caption}")
        return ToolResult(content=f"[desktop glance — {label}] (no caption available; vision {source})")


class DesktopScreenshotTool(ConnectorCapabilityTool):
    """Capture the user's screen and return the IMAGE for the model to SEE
    (vision) — unlike desktop_glance which returns a text caption. The connector
    captures at native resolution (``full_res``) so the image's pixel coordinates
    match the screen, letting desktop_click target what the model sees.

    Requires a vision-capable path: on claude_code_cli the mcp__geny__ bridge
    forwards the image content part to the model. Returns image content blocks
    (see mcp_bridge_controller._to_mcp_content)."""

    async def execute(self, input: Dict[str, Any], context: ToolContext) -> ToolResult:
        reg = get_connector_registry()
        conn = reg.get(context.session_id)
        if conn is None:
            return ToolResult(content="connector offline — no desktop session is connected", is_error=True)
        if "screen_capture" not in conn.accepted_capabilities:
            return ToolResult(content="screen capture is not available on this connector", is_error=True)
        args: Dict[str, Any] = {"full_res": True}
        if input.get("source_id"):
            args["source_id"] = input["source_id"]
        try:
            payload = await conn.capability_call("screen_capture", args, "agent screenshot", timeout=30.0)
        except Exception as exc:
            return ToolResult(content=f"connector transport error: {exc}", is_error=True)
        if not isinstance(payload, dict) or not payload.get("ok"):
            msg = (payload or {}).get("error") or ("denied by the user" if (payload or {}).get("denied") else "capture failed")
            return ToolResult(content=str(msg), is_error=True)
        result = payload.get("result") or {}
        b64 = result.get("image_b64")
        if not b64:
            return ToolResult(content="connector returned no image", is_error=True)
        mime = result.get("mime", "image/jpeg")
        w, h = result.get("width"), result.get("height")
        label = result.get("source_name") or "screen"
        data = b64.split(",", 1)[-1] if isinstance(b64, str) and b64.startswith("data:") else b64
        dims = f"{w}×{h}" if w and h else "the shown size"
        note = (
            f"[screenshot — {label}, {dims} px] This is the user's primary screen right now. "
            "To click something, call desktop_click with the pixel coordinates AS SEEN IN THIS IMAGE "
            "(top-left is 0,0)."
        )
        return ToolResult(content=[
            {"type": "text", "text": note},
            {"type": "image", "data": data, "mime_type": mime},
        ])


def _build_tools() -> Dict[str, ConnectorCapabilityTool]:
    """The capability tools advertised to sessions. ``manifest.tools.external``
    selects which a given session actually exposes."""
    tools: Dict[str, ConnectorCapabilityTool] = {
        # ── bridge health ──
        "connector_ping": ConnectorCapabilityTool(
            name="connector_ping",
            description="Ping the user's desktop connector to confirm the capability bridge is live.",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            capability="ping",
            read_only=True,
            reason="capability-bridge health check",
            timeout=10.0,
        ),
        # ── Phase 4: desktop awareness (read-only) ──
        "desktop_glance": DesktopGlanceTool(
            name="desktop_glance",
            description=(
                "Look at the user's screen right now: captures a frame and returns a description "
                "of what is visible. Use when the user refers to what's on their screen."
            ),
            input_schema={
                "type": "object",
                "properties": {"source_id": {"type": "string", "description": "Optional capture source id from desktop_window_list; defaults to the primary screen."}},
                "additionalProperties": False,
            },
            capability="screen_capture",
            read_only=True,
            reason="agent desktop glance",
            timeout=30.0,
        ),
        "desktop_window_list": ConnectorCapabilityTool(
            name="desktop_window_list",
            description="List the user's open windows and screens (titles + capture source ids).",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            capability="window_list",
            read_only=True,
            reason="agent enumerates windows",
            timeout=10.0,
        ),
        "desktop_screenshot": DesktopScreenshotTool(
            name="desktop_screenshot",
            description=(
                "Take a screenshot of the user's screen and SEE it (the image is returned to you). "
                "Use this to look at the screen before clicking — read what's shown and pick pixel "
                "coordinates for desktop_click. Prefer this over desktop_glance when you need to act."
            ),
            input_schema={
                "type": "object",
                "properties": {"source_id": {"type": "string", "description": "Optional capture source id; defaults to the primary screen."}},
                "additionalProperties": False,
            },
            capability="screen_capture",
            read_only=True,
            reason="agent screenshot",
            timeout=30.0,
        ),
        # ── Phase 6: guarded actuation (destructive → ASK/HITL + connector master switch) ──
        "desktop_open_app": ConnectorCapabilityTool(
            name="desktop_open_app",
            description="Open an application or URL/path on the user's desktop.",
            input_schema={
                "type": "object",
                "properties": {"target": {"type": "string", "description": "App name, file path, or URL to open."}},
                "required": ["target"],
                "additionalProperties": False,
            },
            capability="open_app",
            read_only=False,
            destructive=True,
            reason="agent opens an app",
            timeout=20.0,
        ),
        "desktop_clipboard_write": ConnectorCapabilityTool(
            name="desktop_clipboard_write",
            description="Write text to the user's clipboard.",
            input_schema={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
                "additionalProperties": False,
            },
            capability="clipboard_write",
            read_only=False,
            destructive=True,
            reason="agent writes the clipboard",
            timeout=10.0,
        ),
        "desktop_type": ConnectorCapabilityTool(
            name="desktop_type",
            description="Type text at the user's current keyboard focus (native input synthesis).",
            input_schema={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
                "additionalProperties": False,
            },
            capability="type",
            read_only=False,
            destructive=True,
            reason="agent types on the user's machine",
            timeout=20.0,
        ),
        "desktop_key": ConnectorCapabilityTool(
            name="desktop_key",
            description="Press a key or chord (e.g. 'enter', 'ctrl+s') on the user's machine.",
            input_schema={
                "type": "object",
                "properties": {"keys": {"type": "string", "description": "e.g. 'enter' or 'ctrl+s'"}},
                "required": ["keys"],
                "additionalProperties": False,
            },
            capability="key",
            read_only=False,
            destructive=True,
            reason="agent presses keys",
            timeout=15.0,
        ),
        "desktop_click": ConnectorCapabilityTool(
            name="desktop_click",
            description="Move the mouse and click at absolute screen coordinates.",
            input_schema={
                "type": "object",
                "properties": {
                    "x": {"type": "integer"},
                    "y": {"type": "integer"},
                    "button": {"type": "string", "enum": ["left", "right", "middle"], "default": "left"},
                },
                "required": ["x", "y"],
                "additionalProperties": False,
            },
            capability="click",
            read_only=False,
            destructive=True,
            reason="agent clicks on the user's machine",
            timeout=15.0,
        ),
        "desktop_scroll": ConnectorCapabilityTool(
            name="desktop_scroll",
            description="Scroll the mouse wheel at the current cursor position. Positive `amount` scrolls DOWN, negative UP (in wheel steps).",
            input_schema={
                "type": "object",
                "properties": {"amount": {"type": "integer", "description": "wheel steps; positive = down, negative = up"}},
                "required": ["amount"],
                "additionalProperties": False,
            },
            capability="scroll",
            read_only=False,
            destructive=True,
            reason="agent scrolls the user's screen",
            timeout=10.0,
        ),
        # ── Local MCP proxy (Phase 4): the connector hosts MCP clients to the
        #    user's LOCAL MCP servers; these two tools discover + call them. ──
        "local_mcp_list": ConnectorCapabilityTool(
            name="local_mcp_list",
            description=(
                "List the user's LOCAL MCP servers and their tools (hosted by the desktop connector). "
                "Call this first to discover what local MCP tools are available, then use local_mcp_call. "
                "Returns [{name, connected, error?, tools:[{name, description, inputSchema}]}]."
            ),
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            capability="mcp_list",
            read_only=True,
            reason="agent lists local MCP tools",
            timeout=30.0,
        ),
        "local_mcp_call": ConnectorCapabilityTool(
            name="local_mcp_call",
            description=(
                "Call a tool on one of the user's LOCAL MCP servers (via the desktop connector). "
                "Use local_mcp_list first to find the server name, tool name, and its input schema. "
                "`args` is the tool's arguments object."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "server": {"type": "string", "description": "MCP server name from local_mcp_list."},
                    "tool": {"type": "string", "description": "Tool name on that server."},
                    "args": {"type": "object", "description": "Arguments object for the tool.", "default": {}},
                },
                "required": ["server", "tool"],
                "additionalProperties": False,
            },
            capability="mcp_call",
            read_only=False,
            destructive=True,
            reason="agent calls a local MCP tool",
            timeout=120.0,
        ),
    }
    return tools


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
