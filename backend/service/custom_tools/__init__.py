"""Custom Tools — user-defined / DB-backed tools.

PR #2 of the Custom Tools rollout (cycle 20260525_1). Adds a CRUD-able
tool registry stored in the ``custom_tools`` Postgres table that
:class:`service.tool_loader.ToolLoader` consumes alongside the
filesystem-based ``tools/built_in`` and ``tools/custom`` rosters.

Three backend kinds are supported:

  * ``http``           — turn an external HTTP API into a tool (no
                         user code execution; the host calls the URL,
                         interpolates args, returns the body).
  * ``mcp_proxy``      — re-expose a tool from an existing MCP server
                         under a different name / schema overlay.
  * ``builtin_alias``  — metadata overlay (description, examples) on a
                         Python tool that already lives under
                         ``backend/tools/custom/*.py``. Phase D uses
                         this to ship ``blog_agent_*`` as samples
                         without rewriting the Python code.

Schema generators in :mod:`tools.base` were hardened in PR #847 to
hide host-injected parameters and reject extra args — the same
hygiene applies to every adapter here.
"""

from service.custom_tools.models import (
    CustomToolDefinition,
    HttpToolConfig,
    McpProxyConfig,
    BuiltinAliasConfig,
    PythonInlineConfig,
)
from service.custom_tools.store import CustomToolStore, get_custom_tool_store
from service.custom_tools.adapters import (
    HttpToolAdapter,
    McpProxyAdapter,
    BuiltinAliasAdapter,
    PythonInlineAdapter,
    build_adapter,
)

__all__ = [
    "CustomToolDefinition",
    "HttpToolConfig",
    "McpProxyConfig",
    "BuiltinAliasConfig",
    "PythonInlineConfig",
    "CustomToolStore",
    "get_custom_tool_store",
    "HttpToolAdapter",
    "McpProxyAdapter",
    "BuiltinAliasAdapter",
    "PythonInlineAdapter",
    "build_adapter",
]
