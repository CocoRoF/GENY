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
_SERVER_VERSION = "1.1.0"


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
    ``input_schema`` to MCP's ``inputSchema`` field naming.

    Notes:
      * The legacy ``agent._allowed_tools`` filter was removed in PR #1
        (Phase A2) — nothing in Geny ever set the attribute, so the
        gate was a no-op that suggested a filter that wasn't there.
        The single source of truth for tool exposure is the env
        manifest's ``tools.external`` (consumed at pipeline build
        time); the MCP bridge intentionally advertises everything
        registered with the loader and lets dispatch decide whether
        a given call is honoured.
      * Schemas come straight from the tool — ``BaseTool``'s schema
        generator now hides host-injected params (``session_id``)
        and sets ``additionalProperties: False``, so the
        registered schema is already LLM-safe.
    """
    from service.executor.agent_session_manager import get_agent_session_manager

    manager = get_agent_session_manager()
    loader = getattr(manager, "_tool_loader", None)
    if loader is None:
        return []

    tools: List[Dict[str, Any]] = []
    for name in loader.get_all_names():
        tool = loader.get_tool(name)
        if tool is None:
            continue
        description = getattr(tool, "description", "") or ""
        # Geny ``BaseTool`` exposes JSON-Schema params either as a
        # ``parameters`` dict (legacy) or an ``input_schema`` dict
        # (newer). Adapt to MCP's ``inputSchema`` field.
        schema: Dict[str, Any] = (
            getattr(tool, "input_schema", None)
            or getattr(tool, "parameters", None)
            or {"type": "object", "properties": {}, "additionalProperties": False}
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
    permission / audit machinery. Hardened in PR #1:
      * Host-injected params (``session_id``) overwrite whatever the
        LLM supplied — the registered schema hides them from the LLM
        in the first place, so any value reaching here is hallucinated
        and must not displace the trusted caller's session id.
      * Tools that raise :class:`~tools.base.ToolError` get a clean
        user-facing message with ``isError: True`` — no class names,
        no tracebacks.
      * Tools that return ``{"error": "..."}`` JSON strings (the
        legacy soft-failure pattern used by ``blog_agent_*``) are
        promoted to ``isError: True`` instead of the silent success
        envelope that previously surfaced as
        ``isError: false`` + error-text content. That envelope was
        the root cause of the "맡겼어, 잠깐만" / nothing happens
        symptom reported on the claude_code_cli backend.
      * Unexpected exceptions still set ``isError: True`` but the
        ``text`` field is sanitised (full detail goes to logger).
    """
    from service.executor.agent_session_manager import get_agent_session_manager
    from tools.base import INJECTED_PARAM_NAMES, ToolError

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
    # Strip any host-injected param names the LLM may have hallucinated.
    # The registered schema hides these from the LLM, but a misbehaving
    # client could still smuggle one through — never honour it.
    for hidden in INJECTED_PARAM_NAMES:
        call_input.pop(hidden, None)

    # Now inject from the trusted session context. Probe the signature
    # once per call (cheap; tool resolution is the hot path, not this).
    try:
        import inspect

        fn = getattr(tool, "arun", None) or getattr(tool, "run", None)
        if fn is not None:
            sig = inspect.signature(fn)
            accepts_sid = "session_id" in sig.parameters or any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
            )
            if accepts_sid:
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
    except ToolError as exc:
        logger.info("mcp_bridge: tool '%s' raised ToolError: %s", name, exc.user_message)
        return {
            "content": [{"type": "text", "text": exc.user_message}],
            "isError": True,
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "mcp_bridge: tool '%s' raised: %s", name, exc, exc_info=True,
        )
        return {
            "content": [{"type": "text", "text": _sanitize_exception_message(name, exc)}],
            "isError": True,
        }

    if isinstance(result, str):
        text = result
    else:
        try:
            text = json.dumps(result, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            text = str(result)

    is_err = _detect_legacy_error_envelope(text)
    return {"content": [{"type": "text", "text": text}], "isError": is_err}


def _detect_legacy_error_envelope(text: str) -> bool:
    """Return True iff ``text`` parses to a dict with an ``error`` key.

    Mirrors :func:`tool_bridge._detect_legacy_error_envelope` — same
    detector for the MCP path. Catches the legacy
    ``json.dumps({"error": "..."})`` soft-failure that
    ``blog_agent_*`` and similar tools historically used. Once those
    holdouts migrate to :class:`ToolError`, this helper can be
    retired; until then it prevents the silent-success envelope from
    reaching the LLM.
    """
    s = text.lstrip()
    if not s.startswith("{"):
        return False
    try:
        body = json.loads(s)
    except (ValueError, json.JSONDecodeError):
        return False
    return isinstance(body, dict) and "error" in body


def _sanitize_exception_message(tool_name: str, exc: BaseException) -> str:
    """Produce a clean, LLM-safe message for an unexpected exception.

    Python class names, module paths, and method names are noise for
    the LLM and a footgun for ops (they hint at internals to anyone
    poking at the surface). The operator-facing detail lives in
    ``logger.warning`` at the call site; the LLM only ever sees this
    short string.
    """
    msg = str(exc)
    if "got an unexpected keyword argument" in msg:
        return f"Tool '{tool_name}' rejected an unknown argument."
    if "missing" in msg and "required positional argument" in msg:
        return f"Tool '{tool_name}' was called without a required argument."
    return f"Tool '{tool_name}' failed: {type(exc).__name__}"


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
        # Advertise the version *we* support. The MCP spec is explicit
        # that the server picks the protocol version; previous revisions
        # echoed back the client's value, which meant the server claimed
        # support for anything the client asked for and then 404'd on
        # the methods that version actually requires.
        client_requested = params.get("protocolVersion")
        logger.info(
            "mcp_bridge: initialize session=%s client_requested=%s client_caps=%s",
            session_id, client_requested, params.get("capabilities"),
        )
        return JsonRpcResponse(
            id=request.id,
            result={
                "protocolVersion": _PROTOCOL_VERSION,
                "capabilities": {
                    "tools": {"listChanged": False},
                    # We advertise empty resources/prompts so clients
                    # that probe these surfaces (Claude Code CLI 2.1+
                    # does) see a coherent "yes, supported but empty"
                    # answer rather than method-not-found errors.
                    "resources": {"listChanged": False, "subscribe": False},
                    "prompts": {"listChanged": False},
                    "logging": {},
                },
                "serverInfo": {"name": _SERVER_NAME, "version": _SERVER_VERSION},
            },
        )

    if method == "notifications/initialized":
        # Notification — no response body required by spec, but the
        # bridge always awaits a response. Return an empty success.
        return JsonRpcResponse(id=request.id, result={})

    # Probe surfaces newer Claude Code CLI versions hit during capability
    # discovery. We don't actually expose resources / prompts / logging
    # changes (yet), but a coherent empty answer keeps the CLI logs
    # quiet and avoids a noisy retry loop.
    if method == "resources/list":
        return JsonRpcResponse(id=request.id, result={"resources": []})
    if method == "resources/templates/list":
        return JsonRpcResponse(id=request.id, result={"resourceTemplates": []})
    if method == "prompts/list":
        return JsonRpcResponse(id=request.id, result={"prompts": []})
    if method == "logging/setLevel":
        # Accept silently — we don't route MCP log levels to anything.
        return JsonRpcResponse(id=request.id, result={})
    if method == "completion/complete":
        # No completion surface; return an empty completion list so
        # the CLI just shows no autocomplete suggestions.
        return JsonRpcResponse(
            id=request.id,
            result={"completion": {"values": [], "total": 0, "hasMore": False}},
        )
    if method == "ping":
        # MCP ping → empty result is the spec answer.
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
        # claude_code_cli sessions (the executor's accumulator strips
        # ``tool_use`` blocks from the terminal response so the
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
