"""Tool Bridge — adapts Geny's BaseTool instances to geny-executor's Tool interface.

Bridges the gap between Geny's tool system (BaseTool with run(**kwargs))
and geny-executor's tool system (Tool ABC with async execute(input, context)).

The single public type exported is :class:`_GenyToolAdapter`, consumed
by :class:`service.executor.geny_tool_provider.GenyToolProvider` —
the :class:`AdhocToolProvider` that the manifest path hands to
``Pipeline.from_manifest_async(adhoc_providers=[...])`` so that
``manifest.tools.external`` names resolve against Geny's loader.

The old ``build_geny_tool_registry`` helper that pre-populated a
fully-built :class:`ToolRegistry` up front is gone — tool
registration now flows through the manifest + provider path and is
no longer computed session-by-session in Geny.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)


class _GenyToolAdapter:
    """Adapts a Geny BaseTool to geny-executor's Tool interface.

    Implements all methods required by geny-executor's Tool ABC:
    - name, description, input_schema (properties)
    - execute(input, context) -> ToolResult
    - to_api_format() -> dict (Anthropic API tool definition)
    """

    def __init__(self, geny_tool: Any):
        self._tool = geny_tool
        self._name = getattr(geny_tool, "name", "unknown_tool")
        self._description = getattr(geny_tool, "description", "")
        self._parameters = getattr(geny_tool, "parameters", None) or {
            "type": "object",
            "properties": {},
        }
        self._accepts_session_id = self._probe_session_id_support(geny_tool)
        # Host-injected per-environment web-search config (Tool Settings).
        # Explicit-param only — never sprayed into a `**kwargs` tool.
        self._accepts_web_search_config = self._probe_explicit_param(
            geny_tool, "web_search_config"
        )

    @staticmethod
    def _probe_explicit_param(tool: Any, param_name: str) -> bool:
        """True iff the tool's authoritative signature EXPLICITLY declares
        ``param_name`` (unlike :meth:`_probe_session_id_support`, a bare
        ``**kwargs`` does NOT count — host-injected tool config should only
        reach tools that opt in by naming the parameter)."""
        for fn in (
            getattr(tool, "func", None),
            getattr(tool, "run", None),
            getattr(tool, "arun", None),
        ):
            if fn is None:
                continue
            try:
                sig = inspect.signature(fn)
            except (TypeError, ValueError):
                continue
            return param_name in sig.parameters
        return False

    @staticmethod
    def _probe_session_id_support(tool: Any) -> bool:
        """Return True iff injecting ``session_id`` into this tool's call
        kwargs is safe.

        The adapter's kwargs flow through ``arun(**input)`` →
        ``run(**input)`` via :meth:`BaseTool.arun`'s inherited
        ``**kwargs`` forwarder, so the signature that actually
        *accepts* the kwargs is ``run``'s, not ``arun``'s. Probing
        ``arun`` first — as this did before — trips on the forwarder's
        bare ``**kwargs`` and returns a false positive for every
        BaseTool subclass regardless of its concrete ``run``
        signature (see cycle ``dev_docs/20260420_6/analysis/01``).

        For a ``@tool``-decorated function wrapped in
        :class:`~tools.base.ToolWrapper`, the kwargs reach ``func``
        through ``ToolWrapper.run``'s fixed ``**kwargs`` forwarder —
        so the authoritative signature is ``func``'s.

        Resolution order:
          1. ``tool.func`` — wrapped function inside a ToolWrapper.
          2. ``tool.run`` — concrete override on a BaseTool subclass.
          3. ``tool.arun`` — fallback for duck-typed objects that expose
             only the async method.

        A target accepts ``session_id`` if it declares the parameter
        explicitly OR accepts ``**kwargs``. If inspection fails
        (C-implemented callables, unreadable partials), return False
        — safer to omit the injection than to crash the call.
        """
        for fn in (
            getattr(tool, "func", None),
            getattr(tool, "run", None),
            getattr(tool, "arun", None),
        ):
            if fn is None:
                continue
            try:
                sig = inspect.signature(fn)
            except (TypeError, ValueError):
                continue
            for param in sig.parameters.values():
                if param.name == "session_id":
                    return True
                if param.kind is inspect.Parameter.VAR_KEYWORD:
                    return True
            return False  # first inspectable target is authoritative
        return False

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def input_schema(self) -> Dict[str, Any]:
        return self._parameters

    def to_api_format(self) -> Dict[str, Any]:
        """Convert to Anthropic API tools parameter format.

        Required by ToolRegistry.to_api_format() which is called
        by s03_system stage to build the API request tools list.
        """
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }

    def capabilities(self, input: Dict[str, Any]) -> Any:
        """Forward executor-side capability flags to Stage 10.

        Reads the wrapped tool's class-level ``CAPABILITIES`` attribute
        (a :class:`geny_executor.tools.base.ToolCapabilities`) when the
        author has declared one. Returns the executor's fail-closed
        baseline otherwise — same default as :meth:`Tool.capabilities`.
        """
        from geny_executor.tools.base import ToolCapabilities

        declared = getattr(type(self._tool), "CAPABILITIES", None) or getattr(
            self._tool, "CAPABILITIES", None
        )
        if isinstance(declared, ToolCapabilities):
            return declared
        return ToolCapabilities()

    async def execute(
        self, input: Dict[str, Any], context: Any = None
    ) -> Any:
        """Execute the Geny tool and wrap result as ToolResult.

        Overwrites host-injected parameters (``session_id`` etc.) from the
        Pipeline ``ToolContext`` regardless of what the LLM supplied —
        the schema generator strips them from the LLM's view (see
        :data:`tools.base.INJECTED_PARAM_NAMES`), so any value the LLM
        managed to pass is a hallucination and must not win over the
        trusted ``ToolContext``.

        Errors are normalised:
          * :class:`ToolError` (and tool-returned ``{"error": "..."}``
            JSON, which earlier blog tools used) → ``is_error=True``
            with a clean message. No tracebacks, no Python class names.
          * Unexpected exceptions → ``is_error=True`` with a generic
            message; full detail goes to logger.error.
        """
        from geny_executor.tools.base import ToolResult
        from tools.base import ToolError

        # Copy the caller's dict so our injection doesn't mutate the
        # state.pending_tool_calls entry Stage 10 passed in. Adapters
        # are cached in GenyToolProvider, and stages can retry on
        # transient failure; a mutated input would persist across turns.
        call_input = dict(input)
        if (
            self._accepts_session_id
            and context
            and getattr(context, "session_id", None)
        ):
            # Overwrite, not setdefault — see docstring above.
            call_input["session_id"] = context.session_id

        if self._accepts_web_search_config and context:
            _ws_cfg = (getattr(context, "extras", None) or {}).get("web_search")
            if _ws_cfg:
                call_input["web_search_config"] = _ws_cfg

        try:
            # Try async first (arun), fall back to sync (run)
            if hasattr(self._tool, "arun"):
                result = await self._tool.arun(**call_input)
            elif hasattr(self._tool, "run"):
                run_fn = self._tool.run
                if asyncio.iscoroutinefunction(run_fn):
                    result = await run_fn(**call_input)
                else:
                    result = await asyncio.to_thread(lambda: run_fn(**call_input))
            else:
                return ToolResult(
                    content=f"Tool '{self._name}' has no run/arun method",
                    is_error=True,
                )

            # Normalise result to string
            if not isinstance(result, str):
                import json as _json
                try:
                    result_str = _json.dumps(result, ensure_ascii=False, default=str)
                except (TypeError, ValueError):
                    result_str = str(result)
            else:
                result_str = result

            # Legacy compat: tools that return ``{"error": "..."}`` JSON
            # strings as a soft-failure signal. Detect that pattern and
            # surface it as a real error envelope so downstream stages
            # (and the LLM) don't treat it as success.
            is_err = _detect_legacy_error_envelope(result_str)
            return ToolResult(content=result_str, is_error=is_err)

        except ToolError as exc:
            logger.info("tool_bridge: '%s' raised ToolError: %s", self._name, exc.user_message)
            return ToolResult(content=exc.user_message, is_error=True)

        except Exception as exc:
            # Full traceback to logs; sanitised message to the LLM.
            logger.warning(
                "tool_bridge: '%s' execution failed: %s", self._name, exc, exc_info=True,
            )
            return ToolResult(
                content=_sanitize_exception_message(self._name, exc),
                is_error=True,
            )


def _detect_legacy_error_envelope(result_str: str) -> bool:
    """Return True iff ``result_str`` parses to a dict with an ``error`` key.

    Pre-PR-#1 tools (notably ``blog_agent_*``) returned
    ``json.dumps({"error": "..."})`` to signal failure while keeping
    the host's success/error envelope at "OK" — which the LLM then
    paraphrased as "맡겼어, 잠깐만" while nothing actually happened.
    New code raises :class:`ToolError`; this detector handles the
    holdouts until they migrate.
    """
    s = result_str.lstrip()
    if not s.startswith("{"):
        return False
    import json as _json
    try:
        body = _json.loads(s)
    except (ValueError, _json.JSONDecodeError):
        return False
    return isinstance(body, dict) and "error" in body


def _sanitize_exception_message(tool_name: str, exc: BaseException) -> str:
    """Surface a clean, LLM-safe error message for an unexpected exception.

    Strips Python class names and module paths — the LLM doesn't need
    "BlogAgentStatusTool.run() got an unexpected keyword argument
    'fake_arg'" leaking through. The operator-facing detail goes to
    ``logger.warning`` at the call site.
    """
    msg = str(exc)
    # Best-effort cleanup of common Python noise.
    if "got an unexpected keyword argument" in msg:
        return f"Tool '{tool_name}' rejected an unknown argument."
    if "missing" in msg and "required positional argument" in msg:
        return f"Tool '{tool_name}' was called without a required argument."
    # Generic fallback — short and free of class/module names.
    return f"Tool '{tool_name}' failed: {type(exc).__name__}"
