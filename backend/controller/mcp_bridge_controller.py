"""Internal MCP bridge endpoint for the Claude Code CLI tool wrap.

Phase I of the Phase-I plan (docs/llm-backend-upgrade-plan/
12_phase_i_claude_code_mcp_wrap.md). When a session pins
``claude_code_cli`` as the Stage 6 provider, ``agent_session_manager``
synthesises a per-session MCP config that points the CLI at the
``geny_mcp_bridge.py`` stdio subprocess. That bridge proxies every
MCP JSON-RPC call back to **this** endpoint, which dispatches into
Geny's existing tool registry.

End-to-end flow:

  LLM (inside claude) → tool_use(mcp__geny__<name>)
       │
       ▼
  Claude Code CLI calls the MCP server registered as "geny"
       │
       ▼
  geny_mcp_bridge.py (stdio subprocess spawned by the CLI)
       │ HTTP POST /api/internal/mcp/{session_id}/rpc
       │ Authorization: Bearer <ephemeral token>
       ▼
  This controller → tool_loader.get_tool(name).arun(**input) → result
       │
       ▼
  HTTP response → bridge stdout → CLI → LLM next turn

Auth: ephemeral bearer token minted at session create time. The
``agent_session_manager`` writes ``mcp_bridge_token`` into the
session record. ``require_mcp_bridge_auth`` validates it on every
RPC. Tokens never leave the host process — they are passed to the
bridge subprocess via env var by the CLI launcher.

Phase 2 will layer permission rules + audit / cost telemetry on
this endpoint. Phase 1 ships the wire so the LLM can actually call
Geny tools.
"""

from __future__ import annotations

import json
import logging
import secrets
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Path
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/internal/mcp", tags=["mcp-bridge"])


# ─── Protocol shapes ────────────────────────────────────────────


class JsonRpcRequest(BaseModel):
    """Subset of MCP / JSON-RPC 2.0 request we care about."""

    jsonrpc: str = "2.0"
    id: Optional[int | str] = None
    method: str
    params: Optional[Dict[str, Any]] = None


class JsonRpcResponse(BaseModel):
    """JSON-RPC 2.0 response envelope."""

    jsonrpc: str = "2.0"
    id: Optional[int | str] = None
    result: Optional[Dict[str, Any]] = None
    error: Optional[Dict[str, Any]] = None


_PROTOCOL_VERSION = "2024-11-05"
_SERVER_NAME = "geny"
_SERVER_VERSION = "1.0.0"


# ─── Token utilities ────────────────────────────────────────────


def mint_bridge_token() -> str:
    """256-bit hex token. Stored on the session record at creation."""
    return secrets.token_hex(32)


def require_mcp_bridge_auth(
    session_id: str = Path(..., description="Session UUID"),
    authorization: Optional[str] = Header(None),
) -> str:
    """Verify the ``Authorization: Bearer <token>`` header matches the
    session's persisted ``mcp_bridge_token``. Returns the session_id
    if valid; raises 401 otherwise.

    The token lives only inside the Geny process and the spawned
    claude / bridge subprocess's env. It never leaves the host."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="bearer token required")
    token = authorization[len("Bearer ") :].strip()
    if not token:
        raise HTTPException(status_code=401, detail="bearer token required")

    from service.executor.agent_session_manager import get_agent_session_manager

    manager = get_agent_session_manager()
    agent = manager.get_agent(session_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"session {session_id} not found")
    expected = getattr(agent, "_mcp_bridge_token", None)
    if not expected or not secrets.compare_digest(str(expected), token):
        raise HTTPException(status_code=401, detail="invalid bridge token")
    return session_id


# ─── Tool registry access ───────────────────────────────────────


def _list_session_tools(session_id: str) -> List[Dict[str, Any]]:
    """Return MCP-shaped tool descriptors for the session.

    Pulls from the shared ``ToolLoader`` on the agent manager (the
    same source ``s10_tool`` consults) and adapts each tool's
    ``input_schema`` to MCP's ``inputSchema`` field naming. Filters
    by the session's allowed-tool preset if available.
    """
    from service.executor.agent_session_manager import get_agent_session_manager

    manager = get_agent_session_manager()
    loader = getattr(manager, "_tool_loader", None)
    if loader is None:
        return []

    agent = manager.get_agent(session_id)
    allowed_set = None
    if agent is not None:
        # Session keeps the resolved allowed-tools list on
        # ``_allowed_tools`` (set by AgentSession.create from
        # tool preset / explicit allowlist). When present, gate
        # the MCP roster to that subset so the LLM only sees
        # what the session is supposed to call.
        explicit = getattr(agent, "_allowed_tools", None)
        if explicit:
            allowed_set = set(explicit)

    tools: List[Dict[str, Any]] = []
    for name in loader.get_all_names():
        if allowed_set is not None and name not in allowed_set:
            continue
        tool = loader.get_tool(name)
        if tool is None:
            continue
        description = getattr(tool, "description", "") or ""
        # Geny ``BaseTool`` exposes JSON-Schema params either as a
        # ``parameters`` dict (legacy) or a ``input_schema`` dict
        # (newer). Adapt to MCP's ``inputSchema`` field.
        schema: Dict[str, Any] = (
            getattr(tool, "input_schema", None)
            or getattr(tool, "parameters", None)
            or {"type": "object", "properties": {}}
        )
        tools.append(
            {
                "name": name,
                "description": description if isinstance(description, str) else str(description),
                "inputSchema": schema,
            }
        )
    return tools


async def _execute_tool(
    session_id: str, name: str, arguments: Dict[str, Any]
) -> Dict[str, Any]:
    """Execute a Geny tool by name. Returns an MCP-shaped result.

    Mirrors the dispatch s10_tool performs minus the per-stage
    permission / audit machinery (Phase 2 wires those in). Tools
    that accept a ``session_id`` kwarg get it injected so VTuber↔
    Sub-Worker messaging tools work.
    """
    from service.executor.agent_session_manager import get_agent_session_manager

    manager = get_agent_session_manager()
    loader = getattr(manager, "_tool_loader", None)
    if loader is None:
        raise HTTPException(status_code=500, detail="tool loader not available")

    tool = loader.get_tool(name)
    if tool is None:
        return {
            "content": [{"type": "text", "text": f"Tool '{name}' not found"}],
            "isError": True,
        }

    call_input = dict(arguments or {})
    # Best-effort session_id injection — same logic as
    # ``_GenyToolAdapter._probe_session_id_support``. Many tools
    # accept ``session_id`` kwarg (e.g. messaging tools that key
    # on the caller). Inject only when the signature accepts it
    # so we don't break stricter tools.
    try:
        import inspect

        fn = getattr(tool, "arun", None) or getattr(tool, "run", None)
        if fn is not None:
            sig = inspect.signature(fn)
            accepts_sid = "session_id" in sig.parameters or any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
            )
            if accepts_sid and "session_id" not in call_input:
                call_input["session_id"] = session_id
    except (TypeError, ValueError):
        pass

    try:
        if hasattr(tool, "arun"):
            result = await tool.arun(**call_input)
        elif hasattr(tool, "run"):
            import asyncio

            run_fn = tool.run
            if asyncio.iscoroutinefunction(run_fn):
                result = await run_fn(**call_input)
            else:
                result = await asyncio.to_thread(lambda: run_fn(**call_input))
        else:
            return {
                "content": [
                    {"type": "text", "text": f"Tool '{name}' has no run/arun method"},
                ],
                "isError": True,
            }
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "mcp_bridge: tool '%s' raised: %s", name, exc, exc_info=True,
        )
        return {
            "content": [{"type": "text", "text": f"Tool error: {exc}"}],
            "isError": True,
        }

    text = result if isinstance(result, str) else None
    if text is None:
        try:
            text = json.dumps(result, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            text = str(result)
    return {"content": [{"type": "text", "text": text}], "isError": False}


# ─── RPC dispatcher ─────────────────────────────────────────────


def _err(code: int, message: str) -> Dict[str, Any]:
    return {"code": code, "message": message}


@router.post(
    "/{session_id}/rpc",
    response_model=JsonRpcResponse,
    response_model_exclude_none=True,  # JSON-RPC 2.0: result XOR error, never both
)
async def mcp_rpc(
    request: JsonRpcRequest,
    session_id: str = Path(..., description="Session UUID"),
    _: str = Depends(require_mcp_bridge_auth),
) -> JsonRpcResponse:
    """MCP JSON-RPC entry point. Bridge subprocess POSTs every
    incoming method here; we return the JSON-RPC response.

    Implements the subset of MCP the Claude Code CLI needs:
      - ``initialize`` — handshake.
      - ``notifications/initialized`` — ack (no response body).
      - ``tools/list`` — return the session's Geny tool schemas.
      - ``tools/call`` — dispatch a tool by name.

    Anything else returns JSON-RPC ``method-not-found`` (-32601).
    The bridge translates that into MCP-spec errors back to the CLI.
    """
    method = request.method
    params = request.params or {}

    if method == "initialize":
        # Echo back the client's requested protocol version when present
        # so we can handshake against whatever Claude Code CLI 2.1.x
        # ships with — the MCP spec lets the server pick, but echoing
        # the client's choice is the maximally-compatible path.
        client_version = str(params.get("protocolVersion") or _PROTOCOL_VERSION)
        logger.info(
            "mcp_bridge: initialize session=%s client_protocolVersion=%s client_caps=%s",
            session_id, client_version, params.get("capabilities"),
        )
        return JsonRpcResponse(
            id=request.id,
            result={
                "protocolVersion": client_version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": _SERVER_NAME, "version": _SERVER_VERSION},
            },
        )

    if method == "notifications/initialized":
        # Notification — no response body required by spec, but the
        # bridge always awaits a response. Return an empty success.
        return JsonRpcResponse(id=request.id, result={})

    if method == "tools/list":
        try:
            tools = _list_session_tools(session_id)
        except Exception as exc:  # noqa: BLE001
            logger.error("mcp_bridge: tools/list failed: %s", exc, exc_info=True)
            return JsonRpcResponse(id=request.id, error=_err(-32603, str(exc)))
        # Phase-I diagnostic: log what we are about to advertise. Helps
        # confirm whether the spawned ``claude`` sees a populated tool
        # surface or an empty list (the "ghost delegation" symptom).
        logger.info(
            "mcp_bridge: tools/list session=%s returning %d tools: %s",
            session_id, len(tools), [t.get("name") for t in tools],
        )
        return JsonRpcResponse(id=request.id, result={"tools": tools})

    if method == "tools/call":
        name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        logger.info(
            "mcp_bridge: tools/call session=%s name=%s arg_keys=%s",
            session_id, name, list(arguments.keys()) if isinstance(arguments, dict) else type(arguments).__name__,
        )
        if not name:
            return JsonRpcResponse(
                id=request.id, error=_err(-32602, "missing tool name"),
            )

        # Tool display in Geny session log. Geny's Stage 10 no-ops for
        # claude_code_cli sessions (the executor's accumulator strip
        # in ``llm_patches.py`` removes ``tool_use`` blocks so the
        # downstream pipeline doesn't re-dispatch CLI-handled tools);
        # without an explicit emit here the session log would be
        # silent about the actual tool work the CLI does via MCP.
        # Emitting from the bridge keeps the display semantically
        # correct — the tool DID dispatch from this entry point with
        # exactly these arguments — and ties the success/failure
        # marker to the *real* outcome of the dispatch instead of
        # Stage 10's ghost dispatch attempt.
        display_tool_name = f"mcp__geny__{name}"
        _log = None
        try:
            from service.logging.session_logger import get_session_logger

            _log = get_session_logger(session_id, create_if_missing=False)
            if _log is not None:
                _log.log_tool_use(
                    tool_name=display_tool_name,
                    tool_input=arguments if isinstance(arguments, dict) else {},
                    tool_id=str(request.id) if request.id is not None else None,
                )
        except Exception:  # noqa: BLE001
            # Logging must never break dispatch — but record at debug
            # level so misconfiguration shows up in operator logs.
            logger.debug(
                "mcp_bridge: session_logger.log_tool_use failed for %s",
                display_tool_name, exc_info=True,
            )
            _log = None

        import time as _time
        _t0 = _time.monotonic()
        try:
            result = await _execute_tool(session_id, name, arguments)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "mcp_bridge: tools/call '%s' failed: %s", name, exc, exc_info=True,
            )
            if _log is not None:
                try:
                    _log.log_tool_result(
                        tool_name=display_tool_name,
                        tool_id=str(request.id) if request.id is not None else None,
                        result=str(exc)[:500],
                        is_error=True,
                        duration_ms=int((_time.monotonic() - _t0) * 1000),
                    )
                except Exception:  # noqa: BLE001
                    pass
            return JsonRpcResponse(id=request.id, error=_err(-32603, str(exc)))

        # Surface the tool result to the session log so the UI shows
        # success + duration + a short content preview, mirroring how
        # the Anthropic API path renders Stage 10 dispatches.
        if _log is not None:
            try:
                _result_text = None
                if isinstance(result, dict):
                    is_error_flag = bool(result.get("isError", False))
                    contents = result.get("content") or []
                    if isinstance(contents, list):
                        for c in contents:
                            if isinstance(c, dict) and c.get("type") == "text":
                                _result_text = str(c.get("text", ""))
                                break
                else:
                    is_error_flag = False
                _log.log_tool_result(
                    tool_name=display_tool_name,
                    tool_id=str(request.id) if request.id is not None else None,
                    result=_result_text,
                    is_error=is_error_flag,
                    duration_ms=int((_time.monotonic() - _t0) * 1000),
                )
            except Exception:  # noqa: BLE001
                logger.debug(
                    "mcp_bridge: session_logger.log_tool_result failed for %s",
                    display_tool_name, exc_info=True,
                )

        return JsonRpcResponse(id=request.id, result=result)

    return JsonRpcResponse(
        id=request.id, error=_err(-32601, f"method not found: {method}"),
    )
