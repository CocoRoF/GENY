"""Adapters that turn a :class:`CustomToolDefinition` row into a
:class:`tools.base.BaseTool` instance.

Three concrete adapters mirror the three ``backend_kind`` values:

  * :class:`HttpToolAdapter`        — HTTP request via httpx, with
                                      ``${arg:*}`` / ``${secret:*}`` /
                                      ``${session:*}`` placeholder
                                      interpolation.
  * :class:`McpProxyAdapter`        — forward the call to an existing
                                      MCP server via the host's
                                      MCP manager. Schema overlay
                                      may hide / rename arguments.
  * :class:`BuiltinAliasAdapter`    — overlay name/description/etc
                                      on top of an existing BaseTool
                                      subclass already loaded from
                                      ``backend/tools/custom/*_tools.py``.

All adapters share two invariants enforced at construction time:

  1. ``input_schema`` runs through the same hygiene
     :class:`tools.base.BaseTool` applies to auto-generated schemas:
     :data:`tools.base.INJECTED_PARAM_NAMES` is stripped from
     ``properties`` / ``required`` and ``additionalProperties=False``
     is set.

  2. ``run`` / ``arun`` honour :class:`tools.base.ToolError` — failures
     raise it with a clean user-facing message. The Stage 10 dispatch
     and MCP bridge controller (post PR #847) surface that envelope
     to the LLM as a real ``isError: True`` outcome, instead of the
     legacy ``{"error": "..."}`` JSON-string soft-failure.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from logging import getLogger
from typing import Any, Dict, List, Mapping, Optional

import httpx

from tools.base import INJECTED_PARAM_NAMES, BaseTool, ToolError
from service.custom_tools.models import (
    BuiltinAliasConfig,
    CustomToolDefinition,
    HttpToolConfig,
    McpProxyConfig,
    PythonInlineConfig,
)

logger = getLogger(__name__)


# ── Shared utilities ─────────────────────────────────────────────


_PLACEHOLDER_RE = re.compile(r"\$\{(arg|secret|session):([A-Za-z_][A-Za-z0-9_]*)\}")


def _hygiene(schema: Dict[str, Any]) -> Dict[str, Any]:
    """Force the W1/W10 invariants on a custom-tool input_schema.

    Mirrors :meth:`tools.base.BaseTool._generate_parameters_schema` so
    a hand-edited DB row can never reopen the holes PR #847 closed.
    Mutates and returns the schema for convenience.
    """
    if not isinstance(schema, dict):
        return {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        }
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    schema.setdefault("required", [])
    schema["additionalProperties"] = False

    props = schema.get("properties", {})
    required = schema.get("required", [])
    if isinstance(props, dict):
        for hidden in INJECTED_PARAM_NAMES:
            props.pop(hidden, None)
    if isinstance(required, list):
        schema["required"] = [r for r in required if r not in INJECTED_PARAM_NAMES]
    return schema


def _resolve_secret(key: str) -> str:
    """Look up a secret reference from host config / env.

    Secrets live in :class:`service.config.sub_config.general.llm_credentials_config`
    style stores plus env vars. We never persist secret values; the
    custom tool row carries the *reference* string ``${secret:KEY}``
    and resolution happens here at dispatch time.

    Resolution order:
      1. ``os.environ[KEY]``
      2. (future) host settings.json secrets bag
    """
    val = os.environ.get(key, "")
    return val


def _interpolate(
    template: str,
    *,
    args: Mapping[str, Any],
    session_id: Optional[str],
) -> str:
    """Substitute ``${arg:*}`` / ``${secret:*}`` / ``${session:*}`` placeholders.

    Unknown args → ``ToolError`` (LLM caller forgot a required field).
    Unknown secrets → empty string (silent miss is intentional; the
    operator can spot a 401 from the upstream and fix the secret;
    raising here would leak the secret key name through the LLM).
    """
    def _sub(match: re.Match) -> str:
        scope = match.group(1)
        name = match.group(2)
        if scope == "arg":
            if name not in args:
                raise ToolError(
                    f"missing argument: '{name}'",
                    code="MISSING_ARG",
                )
            value = args[name]
            return str(value)
        if scope == "secret":
            return _resolve_secret(name)
        if scope == "session":
            if name == "session_id":
                return session_id or ""
            return ""
        return match.group(0)

    return _PLACEHOLDER_RE.sub(_sub, template)


# ── HTTP backend ─────────────────────────────────────────────────


class HttpToolAdapter(BaseTool):
    """:class:`BaseTool` wrapping an HTTP request.

    The class-level ``parameters`` schema is the user-supplied
    ``input_schema`` (hygiene-checked at construction time). The
    ``run`` signature accepts ``**kwargs`` so we don't constrain the
    LLM's argument list at the Python signature layer — the schema
    is the source of truth.

    ``session_id`` is in :data:`tools.base.INJECTED_PARAM_NAMES`, so
    the adapter receives it from the trusted ``ToolContext`` via
    ``tool_bridge`` / ``mcp_bridge_controller`` exactly the way
    PR #847 wires every other host tool.
    """

    def __init__(self, defn: CustomToolDefinition) -> None:
        cfg = defn.config
        if not isinstance(cfg, HttpToolConfig):
            raise TypeError(
                f"HttpToolAdapter requires HttpToolConfig, got {type(cfg).__name__}"
            )
        self.name = defn.name
        self.description = defn.description
        self.parameters = _hygiene(dict(defn.input_schema))
        self.CAPABILITIES = _to_executor_capabilities(defn)
        self._cfg = cfg
        self._defn = defn

    async def arun(self, **kwargs: Any) -> str:  # noqa: D401
        # Session id arrives from the bridge controller / tool_bridge.
        sid = kwargs.pop("session_id", None)

        try:
            url = _interpolate(self._cfg.url_template, args=kwargs, session_id=sid)
            headers = {
                k: _interpolate(v, args=kwargs, session_id=sid)
                for k, v in (self._cfg.headers or {}).items()
            }
            body: Optional[str] = None
            if self._cfg.body_template is not None:
                body = _interpolate(
                    self._cfg.body_template, args=kwargs, session_id=sid,
                )
        except ToolError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ToolError(f"failed to render request: {exc}") from exc

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self._cfg.timeout_seconds),
            ) as client:
                if self._cfg.response_handler == "sse_stream_collect":
                    text = await self._stream_collect(client, url, headers, body)
                else:
                    resp = await client.request(
                        self._cfg.method,
                        url,
                        headers=headers,
                        content=body.encode("utf-8") if body is not None else None,
                    )
                    if resp.status_code >= 400:
                        # Trim the upstream body so we don't dump a
                        # 500KB HTML error page into the LLM context.
                        snippet = resp.text[:512]
                        raise ToolError(
                            f"HTTP {resp.status_code} from "
                            f"{self.name}: {snippet}",
                            code=f"HTTP_{resp.status_code}",
                        )
                    if self._cfg.response_handler == "json":
                        try:
                            text = json.dumps(resp.json(), ensure_ascii=False)
                        except (ValueError, json.JSONDecodeError):
                            text = resp.text
                    else:
                        text = resp.text
        except ToolError:
            raise
        except httpx.HTTPError as exc:
            raise ToolError(f"transport error: {exc}", code="HTTP_TRANSPORT") from exc

        max_len = self._defn.capabilities.max_result_chars or 8_000
        if len(text) > max_len:
            text = text[:max_len] + f"\n…(truncated at {max_len} chars)"
        return text

    def run(self, **kwargs: Any) -> str:  # noqa: D401
        return _run_async(self.arun(**kwargs))

    async def _stream_collect(
        self,
        client: httpx.AsyncClient,
        url: str,
        headers: Mapping[str, str],
        body: Optional[str],
    ) -> str:
        """SSE-style collector. Reads the stream until ``sse_done_marker``
        appears or the upstream closes.

        Returns the concatenated ``data:`` payloads. Intentionally simple
        — Phase D's blog-tool sample uses the dedicated BlogAgent fire-
        and-poll path; this collector covers the "wait for the whole
        result" case that smaller custom HTTP+SSE tools usually need.
        """
        done = self._cfg.sse_done_marker
        chunks: List[str] = []
        async with client.stream(
            self._cfg.method,
            url,
            headers=headers,
            content=body.encode("utf-8") if body is not None else None,
        ) as resp:
            if resp.status_code >= 400:
                snippet = (await resp.aread())[:512].decode(errors="replace")
                raise ToolError(
                    f"HTTP {resp.status_code} from {self.name}: {snippet}",
                    code=f"HTTP_{resp.status_code}",
                )
            async for line in resp.aiter_lines():
                if not line:
                    continue
                if done and done in line:
                    break
                if line.startswith("data:"):
                    chunks.append(line[5:].lstrip())
        return "\n".join(chunks)


def _run_async(coro):
    """sync ``run`` wrapper for `arun`. Mirrors blog_agent_tools._run_async."""
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result()
    return asyncio.run(coro)


# ── MCP proxy backend ────────────────────────────────────────────


class McpProxyAdapter(BaseTool):
    """Re-export an upstream MCP server's tool under a new name / schema.

    Construction-time fetch of the upstream schema is deferred — we
    take whatever the user supplied as ``input_schema`` and validate
    only the hygiene invariants. Runtime dispatch goes through the
    host's MCP manager, which already knows the upstream server.
    """

    def __init__(self, defn: CustomToolDefinition) -> None:
        cfg = defn.config
        if not isinstance(cfg, McpProxyConfig):
            raise TypeError(
                f"McpProxyAdapter requires McpProxyConfig, got {type(cfg).__name__}"
            )
        self.name = defn.name
        self.description = defn.description
        self.parameters = _hygiene(dict(defn.input_schema))
        self.CAPABILITIES = _to_executor_capabilities(defn)
        self._cfg = cfg

    async def arun(self, **kwargs: Any) -> str:
        kwargs.pop("session_id", None)
        # Lazy import — MCP manager is a heavy module and loading it
        # at adapter-construction time forces an MCP boot for every
        # ToolLoader scan.
        try:
            from service.mcp_loader import get_session_mcp_call_dispatcher  # type: ignore
        except ImportError:
            raise ToolError(
                "MCP proxy unavailable: host MCP manager is not initialised",
                code="MCP_UNAVAILABLE",
            )

        dispatcher = get_session_mcp_call_dispatcher()
        if dispatcher is None:
            raise ToolError(
                "MCP proxy unavailable: host MCP dispatcher is not bound",
                code="MCP_UNAVAILABLE",
            )

        try:
            return await dispatcher(
                server=self._cfg.upstream_mcp_server,
                tool=self._cfg.upstream_tool_name,
                arguments=kwargs,
            )
        except ToolError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ToolError(
                f"upstream MCP error: {exc}", code="MCP_UPSTREAM",
            ) from exc

    def run(self, **kwargs: Any) -> str:
        return _run_async(self.arun(**kwargs))


# ── Builtin alias backend ────────────────────────────────────────


class BuiltinAliasAdapter(BaseTool):
    """Metadata overlay on a BaseTool that already lives in ``tools/custom``.

    The overlay can rename the tool, replace the description, or pin
    a custom capabilities profile — the *execution* still happens
    through the original BaseTool subclass's ``run`` / ``arun``.
    Phase D ships ``blog_agent_*`` as samples via this path so the
    Python implementation needs zero change.
    """

    def __init__(
        self,
        defn: CustomToolDefinition,
        underlying: BaseTool,
    ) -> None:
        cfg = defn.config
        if not isinstance(cfg, BuiltinAliasConfig):
            raise TypeError(
                f"BuiltinAliasAdapter requires BuiltinAliasConfig, "
                f"got {type(cfg).__name__}"
            )
        self.name = defn.name
        self.description = (
            cfg.description_override
            or defn.description
            or getattr(underlying, "description", "")
        )
        # Schema: prefer the underlying tool's parameters (already
        # gone through BaseTool's hygiene path), but force the
        # invariants again in case the user supplied an explicit
        # ``input_schema`` override.
        if defn.input_schema and defn.input_schema.get("properties"):
            self.parameters = _hygiene(dict(defn.input_schema))
        else:
            self.parameters = _hygiene(
                dict(getattr(underlying, "parameters", None) or {}),
            )
        self.CAPABILITIES = _to_executor_capabilities(defn)
        self._underlying = underlying

    async def arun(self, **kwargs: Any) -> str:
        # Forward unchanged — the underlying tool's signature is
        # responsible for declaring whatever injected params it
        # accepts; tool_bridge / mcp_bridge does the injection.
        underlying = self._underlying
        if hasattr(underlying, "arun"):
            return await underlying.arun(**kwargs)
        if hasattr(underlying, "run"):
            run_fn = underlying.run
            if asyncio.iscoroutinefunction(run_fn):
                return await run_fn(**kwargs)
            return await asyncio.to_thread(lambda: run_fn(**kwargs))
        raise ToolError(
            f"underlying tool '{getattr(underlying, 'name', '?')}' has no run/arun",
            code="BUILTIN_ALIAS_DEAD",
        )

    def run(self, **kwargs: Any) -> str:
        return _run_async(self.arun(**kwargs))


# ── Python-inline backend ────────────────────────────────────────


class PythonInlineAdapter(BaseTool):
    """Loads a complete BaseTool subclass from inline Python source stored
    in the DB row. The "make a tool fully in the web" backend kind.

    The source code is ``exec()``d in a fresh namespace that already
    has ``BaseTool`` / ``ToolError`` plus ``asyncio`` / ``json`` /
    ``httpx`` available so the operator doesn't need to handle the
    common imports. The host's ``service.*`` and ``geny_executor.*``
    namespaces remain importable via normal ``import`` statements so a
    tool can reach the BlogTaskRegistry, the SessionLogger, etc.
    exactly like an in-repo ``*_tools.py`` file.

    Compilation happens once at adapter construction (loader boot /
    hot-reload). A syntax error raises immediately so the row is
    rejected before being registered with the ToolLoader.

    Security: host is single-admin (the same operator who could SSH
    in and write a ``.py`` file). No sandboxing; the inline source
    runs with full host privilege. That's the *point* of the kind.
    """

    def __init__(self, defn: CustomToolDefinition) -> None:
        cfg = defn.config
        if not isinstance(cfg, PythonInlineConfig):
            raise TypeError(
                f"PythonInlineAdapter requires PythonInlineConfig, "
                f"got {type(cfg).__name__}"
            )
        self._defn = defn
        self._cfg = cfg

        underlying = _compile_python_inline(cfg)
        self._underlying = underlying

        # The inline tool's own ``name``/``description``/``parameters``
        # take precedence (the operator wrote them on the BaseTool
        # subclass directly). Fall back to the DB-row fields if the
        # inline class left them blank.
        self.name = getattr(underlying, "name", "") or defn.name
        self.description = (
            getattr(underlying, "description", "") or defn.description
        )
        self.parameters = _hygiene(
            dict(getattr(underlying, "parameters", None) or defn.input_schema or {}),
        )
        self.CAPABILITIES = (
            getattr(type(underlying), "CAPABILITIES", None)
            or getattr(underlying, "CAPABILITIES", None)
            or _to_executor_capabilities(defn)
        )

    async def arun(self, **kwargs: Any) -> str:
        underlying = self._underlying
        if hasattr(underlying, "arun"):
            return await underlying.arun(**kwargs)
        if hasattr(underlying, "run"):
            run_fn = underlying.run
            if asyncio.iscoroutinefunction(run_fn):
                return await run_fn(**kwargs)
            return await asyncio.to_thread(lambda: run_fn(**kwargs))
        raise ToolError(
            f"inline tool '{self.name}' has no run/arun method",
            code="INLINE_BAD_SHAPE",
        )

    def run(self, **kwargs: Any) -> str:
        return _run_async(self.arun(**kwargs))


def _compile_python_inline(cfg: PythonInlineConfig) -> BaseTool:
    """``exec`` the source, fish out the requested class, instantiate.

    Imports + a couple of convenience names are seeded so the operator
    doesn't have to spell out the obvious ones. The full ``service.*``
    namespace is reachable via normal ``import`` statements, same as a
    filesystem tool.
    """
    import asyncio as _asyncio  # noqa: F401 — exposed via namespace
    import json as _json  # noqa: F401
    import logging as _logging  # noqa: F401
    import typing as _typing  # noqa: F401

    try:
        compiled = compile(
            cfg.source_code,
            f"<python_inline:{cfg.class_name}>",
            "exec",
        )
    except SyntaxError as exc:
        raise ToolError(
            f"inline source syntax error at line {exc.lineno}: {exc.msg}",
            code="INLINE_SYNTAX",
        ) from exc

    namespace: Dict[str, Any] = {
        "__name__": f"custom_tools.python_inline.{cfg.class_name}",
        "BaseTool": BaseTool,
        "ToolError": ToolError,
        "asyncio": _asyncio,
        "json": _json,
        "logging": _logging,
        "typing": _typing,
    }

    try:
        exec(compiled, namespace)  # noqa: S102 — intentional, see docstring
    except Exception as exc:  # noqa: BLE001
        raise ToolError(
            f"inline source failed to load: {type(exc).__name__}: {exc}",
            code="INLINE_LOAD",
        ) from exc

    cls = namespace.get(cfg.class_name)
    if cls is None:
        raise ToolError(
            f"inline source did not define class '{cfg.class_name}'",
            code="INLINE_CLASS_NOT_FOUND",
        )
    if not (isinstance(cls, type) and issubclass(cls, BaseTool)):
        raise ToolError(
            f"inline source's '{cfg.class_name}' is not a BaseTool subclass",
            code="INLINE_BAD_CLASS",
        )

    try:
        return cls()
    except Exception as exc:  # noqa: BLE001
        raise ToolError(
            f"inline class '{cfg.class_name}' failed to instantiate: {exc}",
            code="INLINE_INSTANTIATE",
        ) from exc


# ── Factory ──────────────────────────────────────────────────────


def _to_executor_capabilities(defn: CustomToolDefinition) -> Any:
    """Turn the pydantic ``ToolCapabilities`` into the executor's class.

    Imports lazily so importing ``service.custom_tools.adapters`` does
    not require ``geny_executor`` to be installed (matters for the
    schema-only tests).
    """
    try:
        from geny_executor.tools.base import ToolCapabilities as _Cap
    except ImportError:
        return None
    c = defn.capabilities
    return _Cap(
        concurrency_safe=c.concurrency_safe,
        read_only=c.read_only,
        idempotent=c.idempotent,
        network_egress=c.network_egress,
        max_result_chars=c.max_result_chars,
    )


def build_adapter(
    defn: CustomToolDefinition,
    *,
    builtin_lookup: Optional[Mapping[str, BaseTool]] = None,
) -> BaseTool:
    """Instantiate the adapter matching ``defn.backend_kind``.

    For ``builtin_alias`` rows the caller must pass ``builtin_lookup``
    so we can resolve the source class. Pass ``ToolLoader.get_all_tools()``
    or any mapping keyed by tool name.
    """
    if defn.backend_kind == "http":
        return HttpToolAdapter(defn)
    if defn.backend_kind == "mcp_proxy":
        return McpProxyAdapter(defn)
    if defn.backend_kind == "python_inline":
        return PythonInlineAdapter(defn)
    if defn.backend_kind == "builtin_alias":
        if builtin_lookup is None:
            raise ValueError(
                "builtin_alias adapter requires builtin_lookup to resolve "
                "the underlying BaseTool subclass"
            )
        cfg = defn.config
        assert isinstance(cfg, BuiltinAliasConfig)
        underlying = _resolve_builtin(cfg, builtin_lookup)
        return BuiltinAliasAdapter(defn, underlying)
    raise ValueError(f"unknown backend_kind: {defn.backend_kind!r}")


def _resolve_builtin(
    cfg: BuiltinAliasConfig,
    lookup: Mapping[str, BaseTool],
) -> BaseTool:
    """Pick the matching BaseTool from the loader's roster.

    We match by ``(source_module, source_class)`` rather than by
    ``name`` because the alias renames the tool — the original might
    even be hidden from the LLM by a deny-list. ``lookup`` is keyed
    by tool *name*; we iterate and match by class+module attributes.
    """
    for tool in lookup.values():
        cls = type(tool)
        if cls.__name__ != cfg.source_class:
            continue
        # ``__module__`` looks like ``tools_loader_<stem>``; the stem
        # carries the source-file basename which is what the user
        # supplied in ``source_module``.
        mod_name = (cls.__module__ or "").rsplit(".", 1)[-1]
        if mod_name.endswith(cfg.source_module) or mod_name == cfg.source_module:
            return tool
    raise ToolError(
        f"builtin_alias: source class '{cfg.source_class}' "
        f"from module '{cfg.source_module}' not found in loader roster",
        code="BUILTIN_ALIAS_NOT_LOADED",
    )
