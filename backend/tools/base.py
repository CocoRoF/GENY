"""
Tools Base Module

Provides base interfaces and decorators for tool definition.

``BaseTool`` and ``ToolWrapper`` ARE ``geny_executor.tools.base.Tool``
subclasses — Geny tools consume the executor's tool abstraction directly
instead of a parallel one. Authoring stays ergonomic (write ``run()`` +
a Google-style docstring → auto JSON schema), but the resulting object is a
real executor ``Tool``: it implements ``name`` / ``description`` /
``input_schema`` / ``async execute(input, context)`` and is dispatched by the
executor's Stage 10 (and the MCP bridge) with no separate adapter.

Usage:
    # Method 1: @tool decorator (for simple tools)
    from tools.base import tool

    @tool
    def my_function(param: str) -> str:
        '''Tool description here'''
        return result

    # Method 2: BaseTool class inheritance (for complex tools)
    from tools.base import BaseTool

    class MyTool(BaseTool):
        name = "my_tool"
        description = "Tool description"

        def run(self, param: str) -> str:
            return result
"""
import asyncio
import functools
import inspect
import json
import logging
from abc import abstractmethod
from typing import (
    Any,
    Callable,
    ClassVar,
    Dict,
    FrozenSet,
    List,
    Optional,
    Union,
    get_type_hints,
)

from geny_executor.tools.base import Tool, ToolCapabilities, ToolContext, ToolResult

logger = logging.getLogger(__name__)


# Names the host injects into a tool call from runtime context (NOT from the
# LLM). The schema generator strips these from `properties` and `required`
# so the LLM never sees — or hallucinates — them; ``execute`` overwrites
# them from the trusted `ToolContext` before dispatch.
#
# Adding a name here is the *only* place a new injected parameter needs to
# be registered; both BaseTool and ToolWrapper read it.
INJECTED_PARAM_NAMES: FrozenSet[str] = frozenset({"session_id", "web_search_config"})


class ToolError(Exception):
    """Raised by tools to signal a structured failure to the LLM.

    ``execute`` (Stage-10 dispatch + the MCP bridge) catches this and surfaces
    a clean ``isError=true`` envelope with the message text. Use this instead
    of returning ``json.dumps({"error": ...})`` — that pattern historically
    came back to the LLM as ``isError=false`` (a silent success containing an
    error string), which the LLM happily paraphrased as "맡겼어, 잠깐만" while
    nothing actually happened.

    Pass ``user_message`` for the safe text shown to the LLM (no class names,
    no module paths, no tracebacks). Diagnostic detail goes to logger.error
    via the dispatcher — never to the LLM.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.user_message = message
        self.code = code


# ─────────────────────────────────────────────────────────────────
# Shared dispatch helpers (single source of truth for tool execution)
# ─────────────────────────────────────────────────────────────────


def _detect_legacy_error_envelope(result_str: str) -> bool:
    """Return True iff ``result_str`` parses to a dict with an ``error`` key.

    Pre-PR-#1 tools (notably ``blog_agent_*``) returned
    ``json.dumps({"error": "..."})`` to signal failure while keeping the
    host's success/error envelope at "OK" — which the LLM then paraphrased as
    "맡겼어, 잠깐만" while nothing actually happened. New code raises
    :class:`ToolError`; this detector handles the holdouts until they migrate.
    """
    s = result_str.lstrip()
    if not s.startswith("{"):
        return False
    try:
        body = json.loads(s)
    except (ValueError, json.JSONDecodeError):
        return False
    return isinstance(body, dict) and "error" in body


def _sanitize_exception_message(tool_name: str, exc: BaseException) -> str:
    """Surface a clean, LLM-safe error message for an unexpected exception.

    Strips Python class names and module paths — the LLM doesn't need
    "BlogAgentStatusTool.run() got an unexpected keyword argument 'fake_arg'"
    leaking through. The operator-facing detail goes to ``logger.warning`` at
    the call site.
    """
    msg = str(exc)
    if "got an unexpected keyword argument" in msg:
        return f"Tool '{tool_name}' rejected an unknown argument."
    if "missing" in msg and "required positional argument" in msg:
        return f"Tool '{tool_name}' was called without a required argument."
    return f"Tool '{tool_name}' failed: {type(exc).__name__}"


def _probe_param(tool: Any, param_name: str, *, kwargs_counts: bool) -> bool:
    """Inspect a tool's authoritative signature for ``param_name``.

    Probes ``func`` (ToolWrapper's wrapped function) → ``run`` (BaseTool
    subclass override) → ``arun`` in order; the first inspectable target is
    authoritative (the kwargs flow through that signature). When
    ``kwargs_counts`` is True a bare ``**kwargs`` also satisfies the probe
    (used for ``session_id``, which is safe to spray); when False only an
    explicit named parameter counts (used for ``web_search_config``, which
    must only reach tools that opt in by naming it). Inspection failure →
    False (omit the injection rather than crash).
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
            if param.name == param_name:
                return True
            if kwargs_counts and param.kind is inspect.Parameter.VAR_KEYWORD:
                return True
        return False  # first inspectable target is authoritative
    return False


async def _dispatch_geny_tool(
    tool: Any,
    input: Dict[str, Any],
    context: Optional[ToolContext],
    *,
    accepts_session_id: bool,
    accepts_web_search_config: bool,
) -> ToolResult:
    """Unified Geny-tool dispatch — the SINGLE place tool calls are executed.

    Overwrites host-injected parameters (``session_id`` etc.) from the trusted
    ``ToolContext`` regardless of what the LLM supplied (the schema generator
    hides them, so any value the LLM passed is a hallucination). Normalises the
    result to a string and maps failures (``ToolError`` / legacy
    ``{"error": ...}`` envelopes / unexpected exceptions) to a clean
    ``ToolResult(is_error=True)`` with no tracebacks or class names leaking to
    the LLM.
    """
    name = getattr(tool, "name", "unknown_tool")
    # Copy so injection never mutates the caller's pending-call entry.
    call_input = dict(input or {})
    if accepts_session_id and context and getattr(context, "session_id", None):
        call_input["session_id"] = context.session_id
    if accepts_web_search_config and context:
        ws_cfg = (getattr(context, "extras", None) or {}).get("web_search")
        if ws_cfg:
            call_input["web_search_config"] = ws_cfg

    try:
        result = await tool.arun(**call_input)
        if isinstance(result, str):
            result_str = result
        else:
            try:
                result_str = json.dumps(result, ensure_ascii=False, default=str)
            except (TypeError, ValueError):
                result_str = str(result)
        return ToolResult(
            content=result_str,
            is_error=_detect_legacy_error_envelope(result_str),
        )
    except ToolError as exc:
        logger.info("tool '%s' raised ToolError: %s", name, exc.user_message)
        return ToolResult(content=exc.user_message, is_error=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("tool '%s' execution failed: %s", name, exc, exc_info=True)
        return ToolResult(
            content=_sanitize_exception_message(name, exc), is_error=True
        )


class _GenyToolExecuteMixin:
    """Shared executor-``Tool`` surface for BaseTool + ToolWrapper.

    Both author tools via ``run`` / ``arun`` + an auto-generated ``parameters``
    schema. This mixin exposes that as the executor's ``Tool`` contract
    (``input_schema`` + ``execute`` + ``capabilities``) so the object IS a real
    executor tool with no separate adapter."""

    def _injection_support(self) -> tuple[bool, bool]:
        """``(accepts_session_id, accepts_web_search_config)``, probed once
        and cached on the instance.

        Computed LAZILY (not in ``__init__``) on purpose: some BaseTool
        subclasses (e.g. ``HttpToolAdapter``) set their attributes directly
        and never call ``super().__init__()``, so an __init__-time probe would
        silently miss them and drop ``session_id`` injection."""
        cached = self.__dict__.get("_geny_injection_support")
        if cached is None:
            cached = (
                _probe_param(self, "session_id", kwargs_counts=True),
                _probe_param(self, "web_search_config", kwargs_counts=False),
            )
            self.__dict__["_geny_injection_support"] = cached
        return cached

    @property
    def input_schema(self) -> Dict[str, Any]:
        params = getattr(self, "parameters", None)
        if params is None:
            params = {"type": "object", "properties": {}}
        return params

    def capabilities(self, input: Dict[str, Any]) -> ToolCapabilities:
        declared = getattr(type(self), "CAPABILITIES", None) or getattr(
            self, "CAPABILITIES", None
        )
        if isinstance(declared, ToolCapabilities):
            return declared
        return ToolCapabilities()

    async def execute(
        self, input: Dict[str, Any], context: Optional[ToolContext] = None
    ) -> ToolResult:
        accepts_session_id, accepts_web_search_config = self._injection_support()
        return await _dispatch_geny_tool(
            self,
            input,
            context,
            accepts_session_id=accepts_session_id,
            accepts_web_search_config=accepts_web_search_config,
        )


class BaseTool(_GenyToolExecuteMixin, Tool):
    """
    Base class for tools — a real geny-executor ``Tool``.

    All custom tools should inherit from this class and implement ``run``.

    Attributes:
        name: Tool name (must be unique)
        description: Tool description (used by Claude for tool selection)
        parameters: Parameter schema (auto-generated from ``run`` when unset)

    Example:
        class MyTool(BaseTool):
            name = "my_tool"
            description = "Does something useful"

            def run(self, query: str, limit: int = 10) -> str:
                return f"Results for {query}, limit {limit}"
    """

    name: str = ""
    description: str = ""
    parameters: Optional[Dict[str, Any]] = None
    # Optional executor-side runtime traits (`geny_executor.tools.base.ToolCapabilities`).
    # Subclasses opt in by setting this; :meth:`capabilities` forwards it to
    # Stage 10, else falls back to the fail-closed default.
    CAPABILITIES: Optional[Any] = None
    # Per-tool override for the host-injected parameter set. Defaults to
    # the module-level `INJECTED_PARAM_NAMES`. A tool that genuinely wants
    # the LLM to pick a parameter named "session_id" (rare) can clear it.
    INJECTED_PARAMS: ClassVar[FrozenSet[str]] = INJECTED_PARAM_NAMES

    def __init__(self):
        if not self.name:
            self.name = self.__class__.__name__.lower().replace('tool', '')
        if not self.description:
            self.description = self.__doc__ or f"Tool: {self.name}"
        if self.parameters is None:
            self.parameters = self._generate_parameters_schema()

    def _generate_parameters_schema(self) -> Dict[str, Any]:
        """Generate parameter schema from run method signature and docstring.

        Excludes :class:`INJECTED_PARAM_NAMES` (e.g. ``session_id``) from
        both ``properties`` and ``required`` — those are filled by
        :meth:`execute` from trusted context, never by the LLM. Sets
        ``additionalProperties: False`` so hallucinated args are rejected
        by the schema validator before they reach :meth:`run`.
        """
        schema: Dict[str, Any] = {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        }

        injected = self.INJECTED_PARAMS

        try:
            sig = inspect.signature(self.run)
            hints = get_type_hints(self.run) if hasattr(self.run, '__annotations__') else {}

            # Parse Args: section from run() docstring for parameter descriptions
            param_docs = self._parse_docstring_args(self.run.__doc__)

            for param_name, param in sig.parameters.items():
                if param_name == 'self':
                    continue
                if param_name in injected:
                    # Host-injected from ToolContext — hide from LLM.
                    continue

                # Type inference
                param_type = hints.get(param_name, str)
                json_type = self._python_type_to_json(param_type)

                schema["properties"][param_name] = {
                    "type": json_type,
                    "description": param_docs.get(param_name, f"Parameter: {param_name}")
                }

                # Check required parameters
                if param.default == inspect.Parameter.empty:
                    schema["required"].append(param_name)
                else:
                    schema["properties"][param_name]["default"] = param.default

        except Exception:
            pass

        return schema

    @staticmethod
    def _parse_docstring_args(docstring: Optional[str]) -> Dict[str, str]:
        """Extract parameter descriptions from Google-style docstring Args section."""
        if not docstring:
            return {}

        import re
        result: Dict[str, str] = {}

        # Find the Args: section
        args_match = re.search(r'\bArgs:\s*\n', docstring)
        if not args_match:
            return {}

        args_text = docstring[args_match.end():]
        # Stop at the next section (Returns:, Raises:, etc.) or end of docstring
        next_section = re.search(r'\n\S', args_text)
        if next_section:
            args_text = args_text[:next_section.start()]

        # Parse each "    param_name: description" line
        for match in re.finditer(r'^\s+(\w+):\s*(.+?)(?=\n\s+\w+:|$)', args_text, re.MULTILINE | re.DOTALL):
            name = match.group(1)
            desc = ' '.join(match.group(2).split())  # Normalize whitespace
            result[name] = desc

        return result

    @staticmethod
    def _python_type_to_json(python_type: type) -> str:
        """Convert Python type to JSON schema type"""
        type_map = {
            str: "string",
            int: "integer",
            float: "number",
            bool: "boolean",
            list: "array",
            dict: "object",
            type(None): "null"
        }

        # Handle Optional, Union, etc.
        origin = getattr(python_type, '__origin__', None)
        if origin is Union:
            args = getattr(python_type, '__args__', ())
            for arg in args:
                if arg is not type(None):
                    return type_map.get(arg, "string")

        return type_map.get(python_type, "string")

    @abstractmethod
    def run(self, **kwargs) -> str:
        """
        Execute the tool (authoring entry point).

        Args:
            **kwargs: Tool parameters

        Returns:
            Execution result as string
        """
        pass

    async def arun(self, **kwargs) -> str:
        """
        Async tool execution (default: sync execution)

        Override to implement async behavior
        """
        return self.run(**kwargs)

    def __call__(self, **kwargs) -> str:
        """Call the tool like a function"""
        return self.run(**kwargs)

    def to_dict(self) -> Dict[str, Any]:
        """Convert tool info to dictionary"""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters
        }


class ToolWrapper(_GenyToolExecuteMixin, Tool):
    """
    Function wrapper created by @tool decorator — a real geny-executor ``Tool``.

    Wraps regular functions to be compatible with the tool interface.
    """

    # Class-level attrs so they override the executor ``Tool``'s abstract
    # ``name`` / ``description`` properties at class-creation time; __init__
    # sets the real per-instance values.
    name: str = ""
    description: str = ""
    parameters: Optional[Dict[str, Any]] = None

    # Mirror BaseTool's INJECTED_PARAMS so the schema generator hides
    # host-injected parameters from the LLM here too.
    INJECTED_PARAMS: ClassVar[FrozenSet[str]] = INJECTED_PARAM_NAMES
    # Authors may set this on the wrapped function (rare); kept for parity
    # with BaseTool so :meth:`capabilities` can read it.
    CAPABILITIES: Optional[Any] = None

    def __init__(self, func: Callable, name: Optional[str] = None, description: Optional[str] = None):
        self.func = func
        self.name = name or func.__name__
        self.description = description or func.__doc__ or f"Tool: {self.name}"
        self.parameters = self._generate_parameters_schema()
        self.is_async = inspect.iscoroutinefunction(func)
        # Carry an author-declared CAPABILITIES off the function if present.
        self.CAPABILITIES = getattr(func, "CAPABILITIES", None)

        # Copy function metadata
        functools.update_wrapper(self, func)

    def _generate_parameters_schema(self) -> Dict[str, Any]:
        """Generate parameter schema from function signature.

        Hides :data:`INJECTED_PARAMS` (e.g. ``session_id``) from the LLM
        and sets ``additionalProperties: False`` — same treatment as
        :meth:`BaseTool._generate_parameters_schema`.
        """
        schema: Dict[str, Any] = {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        }

        injected = self.INJECTED_PARAMS

        try:
            sig = inspect.signature(self.func)
            hints = get_type_hints(self.func) if hasattr(self.func, '__annotations__') else {}

            for param_name, param in sig.parameters.items():
                if param_name in injected:
                    continue
                param_type = hints.get(param_name, str)
                json_type = BaseTool._python_type_to_json(param_type)

                # Try to extract parameter description from docstring
                param_desc = f"Parameter: {param_name}"
                if self.func.__doc__:
                    # Find parameter description in Args: section
                    import re
                    match = re.search(rf'{param_name}:\s*(.+?)(?:\n|$)', self.func.__doc__)
                    if match:
                        param_desc = match.group(1).strip()

                schema["properties"][param_name] = {
                    "type": json_type,
                    "description": param_desc
                }

                if param.default == inspect.Parameter.empty:
                    schema["required"].append(param_name)
                else:
                    if param.default is not None:
                        schema["properties"][param_name]["default"] = param.default

        except Exception:
            pass

        return schema

    def run(self, **kwargs) -> str:
        """Synchronous execution"""
        result = self.func(**kwargs)
        return self._format_result(result)

    async def arun(self, **kwargs) -> str:
        """Async execution"""
        if self.is_async:
            result = await self.func(**kwargs)
        else:
            result = self.func(**kwargs)
        return self._format_result(result)

    def _format_result(self, result: Any) -> str:
        """Convert result to string"""
        if isinstance(result, str):
            return result
        elif isinstance(result, (dict, list)):
            return json.dumps(result, ensure_ascii=False, indent=2)
        else:
            return str(result)

    def __call__(self, *args, **kwargs):
        """Callable like the original function"""
        return self.func(*args, **kwargs)

    def to_dict(self) -> Dict[str, Any]:
        """Convert tool info to dictionary"""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters
        }


def tool(
    func: Optional[Callable] = None,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None
) -> Union[ToolWrapper, Callable[[Callable], ToolWrapper]]:
    """
    Decorator to convert a function into a tool

    Args:
        func: Function to convert
        name: Tool name (default: function name)
        description: Tool description (default: docstring)

    Usage:
        @tool
        def my_func(param: str) -> str:
            '''Description here'''
            return result

        @tool(name="custom_name", description="Custom description")
        def another_func(param: str) -> str:
            return result
    """
    def decorator(f: Callable) -> ToolWrapper:
        return ToolWrapper(f, name=name, description=description)

    if func is not None:
        # Used as @tool
        return decorator(func)
    else:
        # Used as @tool(...)
        return decorator


def is_tool(obj: Any) -> bool:
    """Check if object is a tool"""
    return isinstance(obj, (BaseTool, ToolWrapper))


def get_tool_info(obj: Any) -> Optional[Dict[str, Any]]:
    """Extract tool information"""
    if isinstance(obj, (BaseTool, ToolWrapper)):
        return obj.to_dict()
    return None
