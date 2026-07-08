"""VSCode-extension capability tools — a DISTINCT connector tool set.

The Geny VSCode extension is a connector (it opens ``/ws/connector/{session_id}``
like the desktop connector) but it advertises a different capability universe:
LOCAL DEVELOPMENT operations on the machine where VSCode runs — read/write/edit
files, search the workspace, run terminal commands, inspect the active editor and
diagnostics. The agent drives them through the same inverse-MCP bridge
(:class:`ConnectorCapabilityTool` → ``capability_call`` over the session's
connector WebSocket → the extension executes locally via the VSCode API).

Isolation (the reason this is a SEPARATE module + provider, not more entries in
``connector_bridge._build_tools``):

* These tool names live ONLY in :class:`VSCodeToolProvider` — never in the
  ToolLoader's name universe — so a normal environment's ``tools.external``
  whitelist (seeded from ``tool_loader.get_all_names()``) can never contain them.
* They reach a session ONLY through the runtime injection gated by
  ``manifest.host_selections.extras.vscode_enabled`` (see
  ``AgentSessionManager._env_vscode_enabled``), which is set only on the
  ``template-vscode-env`` environment.

Two independent fail-closed gates ⇒ the ``vscode_*`` tools appear in the VSCode
Environment and NOWHERE else. The ``desktop_*`` computer-use set is unaffected.

Capability strings are namespaced ``vscode.*`` so the extension dispatches them
distinctly from the desktop verbs; the extension MUST list them in its
connector ``hello.capabilities``.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from service.executor.connector_bridge import ConnectorCapabilityTool


# Capability strings the VSCode extension advertises + dispatches on
# (``capability_call.data.tool``). Kept in one place so the extension and the
# backend agree on the exact wire vocabulary.
VSCODE_CAPABILITIES = (
    "vscode.workspace_info",
    "vscode.read_file",
    "vscode.list_dir",
    "vscode.find_files",
    "vscode.search_text",
    "vscode.active_editor",
    "vscode.diagnostics",
    "vscode.open",
    "vscode.write_file",
    "vscode.edit",
    "vscode.run_terminal",
)

_OBJ = "object"


def _build_vscode_tools() -> Dict[str, ConnectorCapabilityTool]:
    """The VSCode local-development capability tools. ``manifest.tools.external``
    (via the ``vscode_enabled`` gate) selects which a session actually exposes;
    the set is all-or-nothing today, matching the desktop connector."""
    tools: Dict[str, ConnectorCapabilityTool] = {}

    # ── read-only: workspace + file inspection ──
    tools["vscode_workspace_info"] = ConnectorCapabilityTool(
        name="vscode_workspace_info",
        description=(
            "Get the VSCode workspace layout: root folder(s), the currently open "
            "editors, and basic project info. Call this FIRST to learn the "
            "workspace root before reading or searching files."
        ),
        input_schema={"type": _OBJ, "properties": {}, "additionalProperties": False},
        capability="vscode.workspace_info",
        read_only=True,
        reason="agent inspects the VSCode workspace",
        timeout=15.0,
    )
    tools["vscode_read_file"] = ConnectorCapabilityTool(
        name="vscode_read_file",
        description=(
            "Read a file from the user's VSCode workspace. `path` is relative to "
            "the workspace root (or absolute). Optionally read a line range with "
            "`start_line`/`end_line` (1-based, inclusive). Returns the text with "
            "line numbers."
        ),
        input_schema={
            "type": _OBJ,
            "properties": {
                "path": {"type": "string", "description": "Workspace-relative or absolute file path."},
                "start_line": {"type": "integer", "description": "1-based first line (optional)."},
                "end_line": {"type": "integer", "description": "1-based last line, inclusive (optional)."},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
        capability="vscode.read_file",
        read_only=True,
        reason="agent reads a workspace file",
        timeout=20.0,
    )
    tools["vscode_list_dir"] = ConnectorCapabilityTool(
        name="vscode_list_dir",
        description=(
            "List the entries of a directory in the workspace (files + subfolders, "
            "with type). `path` defaults to the workspace root."
        ),
        input_schema={
            "type": _OBJ,
            "properties": {
                "path": {"type": "string", "description": "Directory path (default: workspace root)."},
            },
            "additionalProperties": False,
        },
        capability="vscode.list_dir",
        read_only=True,
        reason="agent lists a workspace directory",
        timeout=15.0,
    )
    tools["vscode_find_files"] = ConnectorCapabilityTool(
        name="vscode_find_files",
        description=(
            "Find files in the workspace by glob (e.g. '**/*.ts', 'src/**/*.py'). "
            "Respects .gitignore / files.exclude. Returns matching paths."
        ),
        input_schema={
            "type": _OBJ,
            "properties": {
                "glob": {"type": "string", "description": "Glob pattern, e.g. '**/*.ts'."},
                "max": {"type": "integer", "description": "Max results (default 200).", "default": 200},
            },
            "required": ["glob"],
            "additionalProperties": False,
        },
        capability="vscode.find_files",
        read_only=True,
        reason="agent finds files by glob",
        timeout=20.0,
    )
    tools["vscode_search_text"] = ConnectorCapabilityTool(
        name="vscode_search_text",
        description=(
            "Search the workspace text for a string or regex (ripgrep-backed). "
            "Returns matches as file:line with the matching line. Use `glob` to "
            "scope, `is_regex` for regex, `case_sensitive` to control folding."
        ),
        input_schema={
            "type": _OBJ,
            "properties": {
                "query": {"type": "string", "description": "Text or regex to search for."},
                "glob": {"type": "string", "description": "Restrict to files matching this glob (optional)."},
                "is_regex": {"type": "boolean", "default": False},
                "case_sensitive": {"type": "boolean", "default": False},
                "max": {"type": "integer", "description": "Max matches (default 200).", "default": 200},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        capability="vscode.search_text",
        read_only=True,
        reason="agent searches workspace text",
        timeout=30.0,
    )
    tools["vscode_active_editor"] = ConnectorCapabilityTool(
        name="vscode_active_editor",
        description=(
            "Get what the user is currently looking at in VSCode: the active "
            "file path, the selected text (if any), the cursor/selection range, "
            "the language id, and the visible line range. Use when the user "
            "refers to 'this file', 'the selection', or 'here'."
        ),
        input_schema={"type": _OBJ, "properties": {}, "additionalProperties": False},
        capability="vscode.active_editor",
        read_only=True,
        reason="agent reads the active editor",
        timeout=15.0,
    )
    tools["vscode_diagnostics"] = ConnectorCapabilityTool(
        name="vscode_diagnostics",
        description=(
            "Get compiler/linter diagnostics (errors, warnings) from VSCode's "
            "language servers. `path` scopes to one file; omit for the whole "
            "workspace. Use after an edit to check you didn't break anything."
        ),
        input_schema={
            "type": _OBJ,
            "properties": {
                "path": {"type": "string", "description": "File path to scope to (optional)."},
                "severity": {
                    "type": "string",
                    "enum": ["error", "warning", "info", "all"],
                    "default": "all",
                },
            },
            "additionalProperties": False,
        },
        capability="vscode.diagnostics",
        read_only=True,
        reason="agent reads diagnostics",
        timeout=20.0,
    )
    tools["vscode_open"] = ConnectorCapabilityTool(
        name="vscode_open",
        description=(
            "Open a file in the user's VSCode editor (optionally at a line), so "
            "they can see what you're working on. Non-destructive — it only "
            "changes what's shown, not file contents."
        ),
        input_schema={
            "type": _OBJ,
            "properties": {
                "path": {"type": "string"},
                "line": {"type": "integer", "description": "1-based line to reveal (optional)."},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
        capability="vscode.open",
        read_only=False,
        destructive=False,
        reason="agent opens a file in the editor",
        timeout=15.0,
    )

    # ── destructive: mutate files + run commands (→ ASK/HITL, + client consent) ──
    tools["vscode_write_file"] = ConnectorCapabilityTool(
        name="vscode_write_file",
        description=(
            "Create or OVERWRITE a file in the workspace with the given content. "
            "Creates parent directories as needed. For small targeted changes to "
            "an existing file prefer vscode_edit. Destructive — the user is asked "
            "to confirm."
        ),
        input_schema={
            "type": _OBJ,
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
        capability="vscode.write_file",
        read_only=False,
        destructive=True,
        reason="agent writes a workspace file",
        timeout=30.0,
    )
    tools["vscode_edit"] = ConnectorCapabilityTool(
        name="vscode_edit",
        description=(
            "Apply targeted string-replacement edits to an existing file. `edits` "
            "is a list of {old_string, new_string, replace_all?}; each old_string "
            "must match EXACTLY (include enough surrounding context to be unique). "
            "Applied atomically. Destructive — the user is asked to confirm."
        ),
        input_schema={
            "type": _OBJ,
            "properties": {
                "path": {"type": "string"},
                "edits": {
                    "type": "array",
                    "items": {
                        "type": _OBJ,
                        "properties": {
                            "old_string": {"type": "string"},
                            "new_string": {"type": "string"},
                            "replace_all": {"type": "boolean", "default": False},
                        },
                        "required": ["old_string", "new_string"],
                        "additionalProperties": False,
                    },
                    "minItems": 1,
                },
            },
            "required": ["path", "edits"],
            "additionalProperties": False,
        },
        capability="vscode.edit",
        read_only=False,
        destructive=True,
        reason="agent edits a workspace file",
        timeout=30.0,
    )
    tools["vscode_run_terminal"] = ConnectorCapabilityTool(
        name="vscode_run_terminal",
        description=(
            "Run a shell command in the workspace and return its stdout/stderr + "
            "exit code. Runs on the USER'S machine where VSCode is installed. "
            "`cwd` defaults to the workspace root. Use for builds, tests, git, "
            "package managers, scaffolding. Destructive — the user is asked to "
            "confirm; long commands may time out (raise `timeout_sec`)."
        ),
        input_schema={
            "type": _OBJ,
            "properties": {
                "command": {"type": "string", "description": "The shell command to run."},
                "cwd": {"type": "string", "description": "Working dir (default: workspace root)."},
                "timeout_sec": {"type": "integer", "description": "Kill after N seconds (default 120).", "default": 120},
            },
            "required": ["command"],
            "additionalProperties": False,
        },
        capability="vscode.run_terminal",
        read_only=False,
        destructive=True,
        reason="agent runs a terminal command",
        timeout=180.0,
    )
    return tools


class VSCodeToolProvider:
    """Duck-typed AdhocToolProvider for the VSCode local-development tools.

    Separate from :class:`ConnectorToolProvider` on purpose — see the module
    docstring's isolation note. Registered always (inert) and activated only by
    the ``vscode_enabled`` environment gate."""

    def __init__(self) -> None:
        self._tools: Optional[Dict[str, ConnectorCapabilityTool]] = None

    def _ensure(self) -> Dict[str, ConnectorCapabilityTool]:
        if self._tools is None:
            self._tools = _build_vscode_tools()
        return self._tools

    def list_names(self) -> List[str]:
        return list(self._ensure().keys())

    def get(self, name: str) -> Optional[ConnectorCapabilityTool]:
        return self._ensure().get(name)
