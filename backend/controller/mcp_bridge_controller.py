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


def _describe_tool(name: str, tool: Any) -> Dict[str, Any]:
    """MCP-shaped descriptor for one tool."""
    description = getattr(tool, "description", "") or ""
    # Geny ``BaseTool`` exposes params as ``parameters`` (legacy) or
    # ``input_schema`` (newer). Adapt to MCP's ``inputSchema``.
    schema: Dict[str, Any] = (
        getattr(tool, "input_schema", None)
        or getattr(tool, "parameters", None)
        or {"type": "object", "properties": {}, "additionalProperties": False}
    )
    return {
        "name": name,
        "description": description if isinstance(description, str) else str(description),
        "inputSchema": schema,
    }


async def _session_runtime(session_id: str):
    """Resolve the LIVE session's (tool_registry, env_controller, sandbox).

    This is what makes ``env`` / ``forge_tool`` / ``save_pack`` and session-scoped
    tools (forged tools, per-env packs) reachable from claude_code_cli: they live
    on the session's pipeline — NOT the global loader — and need the env
    controller + sandbox in their ToolContext. Returns ``(None, None, None)`` when
    no live session (the caller falls back to the global loader)."""
    try:
        from service.executor.agent_session_manager import get_agent_session_manager

        # NON-BLOCKING get_agent — NOT ensure_session_live. The bridge runs
        # INSIDE a live turn (the spawned CLI POSTs tools/list); ensure_session_live
        # takes the per-session rehydrate lock + can rebuild → deadlocks/stalls the
        # turn (CLI hangs waiting for its tool list → 0.0s). The agent is already
        # live here, so get_agent is correct + safe.
        manager = get_agent_session_manager()
        agent = manager.get_agent(session_id)
        if agent is None:
            return None, None, None, None
        pipeline = getattr(agent, "_pipeline", None)
        registry = getattr(pipeline, "_tool_registry", None) if pipeline is not None else None
        env = getattr(pipeline, "environment", None) if pipeline is not None else None
        sandbox = getattr(agent, "_gapt_sandbox", None)
        # The LIVE session tool context — carries extras (subagent_manager,
        # agent_orchestrator, tool settings, …) + sandbox + environment +
        # working_dir. Tools like SubAgentSpawn read context.extras, so the bridge
        # MUST dispatch with this context, not a bare one.
        base_ctx = getattr(env, "_tool_context", None) if env is not None else None
        return registry, env, sandbox, base_ctx
    except Exception:  # noqa: BLE001 — never break dispatch on a runtime miss
        logger.debug("mcp_bridge: session runtime unavailable for %s", session_id, exc_info=True)
        return None, None, None, None


async def _list_session_tools(session_id: str) -> List[Dict[str, Any]]:
    """Return MCP-shaped tool descriptors for the session.

    Parity with the SDK (Anthropic API) path — advertise the EXPOSED set only.
    -------------------------------------------------------------------------
    The executor keeps a *core* / *deferred* split: core tools ship to the model
    every turn; deferred tools stay registered + dispatchable but hidden until
    the model discovers them via ``ToolSearch``. On the SDK path that split IS
    the model's tool list (Stage 3 exports ``exposed_only``). On the
    ``claude_code_cli`` path the model's tool list is instead whatever THIS
    bridge advertises — so to give the CLI the same "few core tools + ToolSearch
    for the rest" behaviour (and to keep the advertised set small enough that
    Claude Code's own tool-search deferral, which we disable via
    ``ENABLE_TOOL_SEARCH=false``, never even needs to kick in), we advertise
    **exposed-only** when a live registry is present.

    Deferred tools are deliberately withheld here; they remain in the registry
    so the executor's ``ToolSearch`` (bridged as ``mcp__geny__ToolSearch``) can
    ``activate`` them, after which they become exposed and appear on the next
    ``tools/list`` — a fresh one per ``claude --print`` spawn, plus a
    ``list_changed`` nudge (see ``_maybe_notify_tools_changed``) for same-turn
    pickup.

    Falls back to the shared ``ToolLoader`` (all tools, best effort) only when
    there is no live session registry yet.
    """
    from service.executor.agent_session_manager import get_agent_session_manager

    registry, _env, _sb, _ctx = await _session_runtime(session_id)
    tools: List[Dict[str, Any]] = []
    seen: set[str] = set()

    if registry is not None and len(registry) > 0:
        # Live session — the registry is authoritative. Advertise the exposed
        # (core + runtime-activated) set only; deferred tools stay hidden but
        # reachable via ToolSearch. This mirrors the SDK path's exposed_only
        # export and keeps the CLI's tool surface small.
        try:
            for name in registry.list_names():
                if name in seen:
                    continue
                is_exposed = getattr(registry, "is_exposed", None)
                if callable(is_exposed) and not is_exposed(name):
                    continue  # deferred → discover via ToolSearch, not here
                tool = registry.get(name)
                if tool is None:
                    continue
                seen.add(name)
                tools.append(_describe_tool(name, tool))
        except Exception:  # noqa: BLE001
            logger.debug("mcp_bridge: registry listing failed for %s", session_id, exc_info=True)
        return tools

    # Fallback ONLY when there is no live registry (older path / not yet built):
    # union the global loader so the CLI never loses its base tools. Here there
    # is no core/deferred split to honour, so advertise everything the loader
    # knows about (gapt_*, custom, list_tool_packs, use_tool_pack, …).
    manager = get_agent_session_manager()
    loader = getattr(manager, "_tool_loader", None)
    if loader is not None:
        for name in loader.get_all_names():
            if name in seen:
                continue
            tool = loader.get_tool(name)
            if tool is None:
                continue
            seen.add(name)
            tools.append(_describe_tool(name, tool))
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
    from geny_executor.tools.base import ToolContext
    from service.executor.agent_session_manager import get_agent_session_manager
    from tools.base import INJECTED_PARAM_NAMES

    # Resolve from the LIVE session first — that registry carries the env tool,
    # forged tools, and per-env pack tools (+ the env controller + sandbox + the
    # live ToolContext whose extras hold subagent_manager/orchestrator/settings).
    # Fall back to the global loader when no live session.
    registry, env_controller, sandbox, base_ctx = await _session_runtime(session_id)
    tool = registry.get(name) if registry is not None else None
    if tool is None:
        manager = get_agent_session_manager()
        loader = getattr(manager, "_tool_loader", None)
        tool = loader.get_tool(name) if loader is not None else None
    if tool is None:
        return {
            "content": [{"type": "text", "text": f"Tool '{name}' not found"}],
            "isError": True,
        }

    # Strip any host-injected param names the LLM may have hallucinated; the
    # tool's execute() re-injects them from the trusted ToolContext below.
    call_input = dict(arguments or {})
    for hidden in INJECTED_PARAM_NAMES:
        call_input.pop(hidden, None)

    # Unified dispatch: every Geny tool IS an executor Tool, so its execute()
    # is the SINGLE source of truth for session_id injection + ToolError /
    # legacy-{"error"} / exception sanitisation — identical to the Stage-10
    # path. The claude_code_cli MCP bridge no longer carries its own copy.
    if not hasattr(tool, "execute"):
        return {
            "content": [{"type": "text", "text": f"Tool '{name}' is not executable"}],
            "isError": True,
        }
    # Prefer the session's LIVE ToolContext — it already carries everything a
    # tool needs: extras (subagent_manager / agent_orchestrator / tool settings),
    # sandbox, environment, working_dir, storage_path. Without extras, tools like
    # SubAgentSpawn fail with NO_SUBAGENT_MANAGER. Fall back to a minimal context
    # (env+sandbox) when there's no live session, then a bare one.
    if base_ctx is not None:
        ctx = base_ctx
    elif env_controller is not None or sandbox is not None:
        ctx = ToolContext(
            session_id=session_id,
            environment=env_controller,
            sandbox=sandbox,
            working_dir="/workspace" if sandbox is not None else None,
        )
    else:
        ctx = ToolContext(session_id=session_id)
    # Bind the live registry so a bridged ``ToolSearch`` can ``activate`` deferred
    # tools in the SAME registry this bridge advertises from — otherwise
    # discovery is a no-op on the CLI path and the long tail is unreachable. Only
    # set it when absent (never clobber an executor-bound registry); it's the
    # same session registry either way, so this is idempotent.
    if registry is not None:
        try:
            if getattr(ctx, "tool_registry", None) is None:
                ctx.tool_registry = registry
        except Exception:  # noqa: BLE001 — context may forbid attribute set
            pass
    result = await tool.execute(call_input, ctx)
    return {"content": _to_mcp_content(result.content), "isError": bool(result.is_error)}


def _to_mcp_content(content: Any) -> list:
    """Serialize a ToolResult's content into MCP content parts.

    A tool that wants the model to SEE an image (e.g. desktop_screenshot for
    computer use) returns ``content`` as a list of blocks, each a dict with
    ``type`` in {"text", "image"} — an image block carries ``data`` (base64) and
    ``mime_type``. Those pass through as MCP image parts (Claude Code forwards
    image parts to the model's vision). Everything else becomes a single text
    part exactly as before (backward compatible)."""
    if (
        isinstance(content, list)
        and content
        and all(isinstance(b, dict) and b.get("type") in ("text", "image") for b in content)
    ):
        parts: list = []
        for b in content:
            if b.get("type") == "image":
                # Accept the canonical block ({source:{type:base64,media_type,data}})
                # OR a flat block ({data, mime_type}); emit the MCP image shape.
                src = b.get("source") if isinstance(b.get("source"), dict) else {}
                data = src.get("data") or b.get("data") or ""
                mime = src.get("media_type") or b.get("mime_type") or b.get("mimeType") or "image/png"
                if isinstance(data, str) and data.startswith("data:"):
                    data = data.split(",", 1)[-1]  # tolerate a data: URL prefix
                parts.append({"type": "image", "data": data, "mimeType": mime})
            else:
                parts.append({"type": "text", "text": str(b.get("text", ""))})
        return parts
    if isinstance(content, str):
        text = content
    else:
        try:
            text = json.dumps(content, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            text = str(content)
    return [{"type": "text", "text": text}]


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
                    # The tool list DOES change mid-turn: a bridged
                    # ToolSearch activates deferred tools. The stdio bridge
                    # emits notifications/tools/list_changed when a
                    # tools/call response carries _meta.genyToolsChanged, so
                    # the CLI re-fetches tools/list and can call the newly
                    # activated tool in the SAME turn.
                    "tools": {"listChanged": True},
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
            tools = await _list_session_tools(session_id)
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
        # Same-turn activation detection: a bridged ToolSearch (or any tool
        # that mutates the registry) changes the exposed set mid-turn. The
        # registry version captures that; a moved version stamps
        # ``_meta.genyToolsChanged`` on the result so the stdio bridge can
        # nudge the CLI with notifications/tools/list_changed.
        _reg_before = None
        try:
            _reg, _, _, _ = await _session_runtime(session_id)
            if _reg is not None:
                _reg_before = getattr(_reg, "version", None)
        except Exception:  # noqa: BLE001 — detection must never block dispatch
            _reg = None
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

        try:
            if (
                _reg is not None
                and _reg_before is not None
                and getattr(_reg, "version", None) != _reg_before
                and isinstance(result, dict)
            ):
                meta = dict(result.get("_meta") or {})
                meta["genyToolsChanged"] = True
                result["_meta"] = meta
                logger.info(
                    "mcp_bridge: registry version moved during tools/call "
                    "'%s' — flagging genyToolsChanged", name,
                )
        except Exception:  # noqa: BLE001
            pass

        return JsonRpcResponse(id=request.id, result=result)

    return JsonRpcResponse(
        id=request.id, error=_err(-32601, f"method not found: {method}"),
    )
