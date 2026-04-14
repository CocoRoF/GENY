#!/usr/bin/env python3
"""
Proxy MCP Server — thin proxy between Claude CLI and the FastAPI main process.

This script runs as a stdio MCP server subprocess spawned by Claude CLI.
It does NOT execute tools itself. Instead, it:

1. Auto-discovers tool modules from the specified category folder
2. Registers proxy functions with FastMCP that delegate execution
   to the main FastAPI process via HTTP POST

This solves the fundamental problem: tools like geny_tools need access
to singletons (AgentSessionManager, ChatStore) that only exist in the
main process.

Usage (spawned by Claude CLI via .mcp.json):
    python tools/_proxy_mcp_server.py <backend_url> <session_id> <category> [tool1,tool2,...]

Arguments:
    backend_url:   Base URL of the FastAPI server (e.g. http://localhost:8000)
    session_id:    Session ID for context passing
    category:      Tool category: 'builtin' or 'custom'
    allowed_tools: Optional comma-separated list of tool names to register.
                   If omitted, all tools in the category are registered.
"""

import sys
import functools
import importlib.util
from pathlib import Path
from typing import List, Any, Optional, Set

# ── Add project root to path ──
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    print("Error: MCP SDK not installed. Run: pip install mcp", file=sys.stderr)
    sys.exit(1)

try:
    import httpx
except ImportError:
    print("Error: httpx not installed. Run: pip install httpx", file=sys.stderr)
    sys.exit(1)


# ════════════════════════════════════════════════════════════════════════════
# CLI Argument Parsing
# ════════════════════════════════════════════════════════════════════════════

def print_usage_and_exit():
    print(
        "Usage: python _proxy_mcp_server.py <backend_url> <session_id> <category> [allowed_tools]\n"
        "  category: 'builtin' or 'custom'\n"
        "  allowed_tools: optional comma-separated tool names",
        file=sys.stderr,
    )
    sys.exit(1)


if len(sys.argv) < 4:
    print_usage_and_exit()

BACKEND_URL = sys.argv[1]
SESSION_ID = sys.argv[2]
CATEGORY = sys.argv[3]  # 'builtin' or 'custom'
ALLOWED_TOOLS: Optional[Set[str]] = (
    set(sys.argv[4].split(",")) if len(sys.argv) > 4 and sys.argv[4] else None
)

if CATEGORY not in ("builtin", "custom"):
    print(f"Error: category must be 'builtin' or 'custom', got '{CATEGORY}'", file=sys.stderr)
    print_usage_and_exit()


# ════════════════════════════════════════════════════════════════════════════
# Auto-Discovery: Load tools from folder
# ════════════════════════════════════════════════════════════════════════════

def discover_tools_from_folder(folder: Path) -> List[Any]:
    """
    Scan a folder for *_tools.py files and extract tool objects.

    Each tool file should define a TOOLS list containing tool instances.
    Falls back to auto-collecting BaseTool/ToolWrapper instances if no TOOLS list.
    """
    if not folder.exists():
        print(f"Warning: Tool folder not found: {folder}", file=sys.stderr)
        return []

    all_tools = []
    tool_files = sorted(folder.glob("*_tools.py"))

    for tool_file in tool_files:
        try:
            tools = _load_tools_from_file(tool_file)
            all_tools.extend(tools)
            if tools:
                names = [getattr(t, "name", "?") for t in tools]
                print(f"  [{CATEGORY}] {tool_file.name}: {names}", file=sys.stderr)
        except Exception as e:
            print(f"Warning: Failed to load {tool_file.name}: {e}", file=sys.stderr)

    return all_tools


def _load_tools_from_file(file_path: Path) -> List[Any]:
    """Load tool instances from a single Python file."""
    module_name = f"_proxy_tools_{file_path.stem}"
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        return []

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)

    # Prefer explicit TOOLS list
    if hasattr(module, "TOOLS"):
        return list(module.TOOLS)

    # Fallback: try to find and import tools/base.py for is_tool check
    try:
        from tools.base import is_tool
        tools = []
        for attr_name in dir(module):
            if attr_name.startswith("_"):
                continue
            obj = getattr(module, attr_name)
            if is_tool(obj):
                tools.append(obj)
        return tools
    except ImportError:
        return []


# ════════════════════════════════════════════════════════════════════════════
# Proxy Registration
# ════════════════════════════════════════════════════════════════════════════

def _register_proxy_tool(tool_obj, mcp_server, backend_url: str, session_id: str):
    """Register a tool as a proxy that delegates execution to the main process.

    The tool's schema (name, description, parameters) comes from the original
    tool object. The actual execution is forwarded via HTTP POST.
    """
    name = getattr(tool_obj, "name", None)
    if not name:
        return

    description = getattr(tool_obj, "description", "") or f"Tool: {name}"

    # Get the original run function to preserve its signature.
    # FastMCP uses inspect.signature() on the registered function to
    # generate the input_schema. @functools.wraps copies __wrapped__,
    # __annotations__, etc. so the schema is accurate.
    if hasattr(tool_obj, "run") and callable(tool_obj.run):
        source_fn = tool_obj.run
    elif callable(tool_obj):
        source_fn = tool_obj
    else:
        return

    @functools.wraps(source_fn)
    async def proxy_fn(*args, **kwargs):
        """Proxy: forwards tool call to main FastAPI process via HTTP."""
        async with httpx.AsyncClient(timeout=300.0) as client:
            try:
                resp = await client.post(
                    f"{backend_url}/internal/tools/execute",
                    json={
                        "tool_name": name,
                        "args": kwargs,
                        "session_id": session_id,
                    },
                )
                resp.raise_for_status()
                data = resp.json()

                if data.get("error"):
                    return f"Error: {data['error']}"
                return data.get("result", "")

            except httpx.ConnectError:
                return f"Error: Cannot connect to backend at {backend_url}"
            except Exception as e:
                return f"Error executing {name}: {e}"

    # Override the function name and docstring for MCP registration
    proxy_fn.__name__ = name
    proxy_fn.__qualname__ = name

    # Build the docstring with Args section for proper schema generation
    source_doc = source_fn.__doc__ or ""
    args_section = ""
    if "Args:" in source_doc:
        args_idx = source_doc.index("Args:")
        args_section = source_doc[args_idx:]
    proxy_fn.__doc__ = (
        f"{description}\n\n{args_section}" if args_section else description
    )

    mcp_server.tool(name=name, description=description)(proxy_fn)


# ════════════════════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════════════════════

# Determine folder based on category
TOOLS_DIR = PROJECT_ROOT / "tools"
if CATEGORY == "builtin":
    TARGET_FOLDER = TOOLS_DIR / "built_in"
    MCP_SERVER_NAME = "builtin-tools"
else:
    TARGET_FOLDER = TOOLS_DIR / "custom"
    MCP_SERVER_NAME = "custom-tools"

# Create MCP server
mcp = FastMCP(MCP_SERVER_NAME)

# Discover and load tools from folder
print(f"Proxy MCP [{CATEGORY}]: scanning {TARGET_FOLDER}", file=sys.stderr)
_all_tools = discover_tools_from_folder(TARGET_FOLDER)

# Register proxy functions
_registered_count = 0
for tool_obj in _all_tools:
    tool_name = getattr(tool_obj, "name", "")
    if ALLOWED_TOOLS and tool_name not in ALLOWED_TOOLS:
        continue
    _register_proxy_tool(tool_obj, mcp, BACKEND_URL, SESSION_ID)
    _registered_count += 1

print(
    f"Proxy MCP [{CATEGORY}]: {_registered_count} tools registered (session={SESSION_ID})",
    file=sys.stderr,
)

# ── Run ──
if __name__ == "__main__":
    mcp.run(transport="stdio")
