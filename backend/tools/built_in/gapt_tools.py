"""GAPT tools — let a Geny agent drive the GAPT platform (projects, workspaces,
deploys) directly, **in-process** via :class:`GaptClient` (no MCP subprocess).

These auto-load when GAPT is configured (``GAPT_BASE_URL`` set) — the ``TOOLS``
list at the bottom is empty otherwise, so a GAPT-less deployment shows no GAPT
tools. Because they call the GAPT HTTP API over the shared ``gapt-net`` network
(not a stdio MCP server), there is nothing to "launch" and no subprocess
lifecycle to go wrong.

Scope is the GAPT *control plane* (manage projects/workspaces/deploys). A
session's file/shell work already runs inside its GAPT workspace via the sandbox
path, so these tools deliberately don't duplicate read/write/bash — use
``gapt_run_command`` for ad-hoc commands in any workspace.

This file is auto-loaded by the tool loader (matches the ``*_tools.py`` pattern).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict

from geny_executor.tools.base import ToolCapabilities

from service.gapt.client import GaptApiError, GaptClient, get_gapt_client
from tools.base import BaseTool

_MAX = 16_000


def _ok(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)[:_MAX]


def _err(msg: str, **extra: Any) -> str:
    return json.dumps({"error": msg, **extra}, ensure_ascii=False)


class _GaptTool(BaseTool):
    """Base: configured-check + error envelope + sync/async plumbing.

    Subclasses set ``name`` / ``description`` / ``parameters`` and implement
    ``async call(self, client, **kwargs) -> json-able``.
    """

    CAPABILITIES = ToolCapabilities(network_egress=True, max_result_chars=_MAX)
    # Explicit (skips run-signature introspection in BaseTool).
    parameters: Dict[str, Any] = {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    }

    async def call(self, client: GaptClient, **kwargs: Any) -> Any:  # pragma: no cover
        raise NotImplementedError

    async def arun(self, **kwargs: Any) -> str:
        client = get_gapt_client()
        if not client.configured:
            return _err("GAPT is not configured (GAPT_BASE_URL unset)")
        try:
            return _ok(await self.call(client, **kwargs))
        except GaptApiError as e:
            return _err(e.reason, code=e.code, status=e.status)
        except Exception as e:  # noqa: BLE001
            return _err(str(e))

    def run(self, **kwargs: Any) -> str:
        # Sync fallback (tests / non-async callers): a fresh client in a new loop.
        async def _f() -> str:
            c = GaptClient()
            if not c.configured:
                return _err("GAPT is not configured (GAPT_BASE_URL unset)")
            try:
                return _ok(await self.call(c, **kwargs))
            except GaptApiError as e:
                return _err(e.reason, code=e.code, status=e.status)
            except Exception as e:  # noqa: BLE001
                return _err(str(e))
            finally:
                await c.aclose()

        return asyncio.run(_f())


# ── orient ───────────────────────────────────────────────────────────

class GaptOverviewTool(_GaptTool):
    name = "gapt_overview"
    description = (
        "GAPT platform snapshot: all projects + workspace capacity stats. "
        "Start here to see what projects/workspaces exist."
    )

    async def call(self, client: GaptClient, **_: Any) -> Any:
        projects = await client.list_projects()
        try:
            stats = await client.workspace_stats()
        except GaptApiError:
            stats = None
        return {"projects": projects, "workspace_stats": stats}


# ── projects ─────────────────────────────────────────────────────────

class GaptListProjectsTool(_GaptTool):
    name = "gapt_list_projects"
    description = "List all GAPT projects (id, slug, repos)."

    async def call(self, client: GaptClient, **_: Any) -> Any:
        return await client.list_projects()


class GaptCreateProjectTool(_GaptTool):
    name = "gapt_create_project"
    description = (
        "Create a GAPT project. Empty git_remote_url makes a blank project "
        "for later multi-repo setup."
    )
    parameters = {
        "type": "object",
        "properties": {
            "slug": {"type": "string", "description": "Unique short id (kebab-case)."},
            "display_name": {"type": "string", "description": "Human-facing name."},
            "git_remote_url": {"type": "string", "description": "Optional git remote to clone."},
        },
        "required": ["slug"],
        "additionalProperties": False,
    }

    async def call(self, client: GaptClient, *, slug: str, display_name: str = "", git_remote_url: str = "", **_: Any) -> Any:
        return await client.create_project(
            slug=slug, display_name=display_name or slug, git_remote_url=git_remote_url
        )


# ── workspaces ───────────────────────────────────────────────────────

class GaptListWorkspacesTool(_GaptTool):
    name = "gapt_list_workspaces"
    description = "List a project's workspaces (name, status, selections)."
    parameters = {
        "type": "object",
        "properties": {"project_id": {"type": "string"}},
        "required": ["project_id"],
        "additionalProperties": False,
    }

    async def call(self, client: GaptClient, *, project_id: str, **_: Any) -> Any:
        return await client.list_workspaces(project_id)


class GaptCreateWorkspaceTool(_GaptTool):
    name = "gapt_create_workspace"
    description = (
        "Create a sandbox workspace in a project. Async — poll gapt_list_workspaces "
        "until status='running'. Idempotent on (project, name)."
    )
    parameters = {
        "type": "object",
        "properties": {
            "project_id": {"type": "string"},
            "name": {"type": "string", "description": "Workspace name (unique among live workspaces)."},
        },
        "required": ["project_id", "name"],
        "additionalProperties": False,
    }

    async def call(self, client: GaptClient, *, project_id: str, name: str, **_: Any) -> Any:
        return await client.create_workspace(project_id, name=name)


class GaptManageWorkspaceTool(_GaptTool):
    name = "gapt_manage_workspace"
    description = "Lifecycle action on a workspace: start, stop, or delete."
    parameters = {
        "type": "object",
        "properties": {
            "workspace_id": {"type": "string"},
            "action": {"type": "string", "enum": ["start", "stop", "delete"]},
        },
        "required": ["workspace_id", "action"],
        "additionalProperties": False,
    }

    async def call(self, client: GaptClient, *, workspace_id: str, action: str, **_: Any) -> Any:
        if action == "start":
            await client.start_workspace(workspace_id)
        elif action == "stop":
            await client.stop_workspace(workspace_id)
        elif action == "delete":
            await client.delete(f"/_gapt/api/workspaces/{workspace_id}")
        else:
            return {"error": f"unknown action {action!r}"}
        return {"workspace_id": workspace_id, "action": action, "ok": True}


class GaptRunCommandTool(_GaptTool):
    name = "gapt_run_command"
    description = (
        "Run a shell command inside a GAPT workspace container (captured output). "
        "Use for ad-hoc ops in any workspace (cwd is relative to /workspace)."
    )
    parameters = {
        "type": "object",
        "properties": {
            "workspace_id": {"type": "string"},
            "command": {"type": "string"},
            "cwd": {"type": "string", "description": "Optional dir relative to /workspace."},
        },
        "required": ["workspace_id", "command"],
        "additionalProperties": False,
    }

    async def call(self, client: GaptClient, *, workspace_id: str, command: str, cwd: str = "", **_: Any) -> Any:
        out = await client.run_command(workspace_id, command, cwd=cwd or None)
        return {"workspace_id": workspace_id, "command": command, "output": out}


# ── deploy ───────────────────────────────────────────────────────────

class GaptListEnvironmentsTool(_GaptTool):
    name = "gapt_list_environments"
    description = "List a project's deploy environments (id, name, kind, history)."
    parameters = {
        "type": "object",
        "properties": {"project_id": {"type": "string"}},
        "required": ["project_id"],
        "additionalProperties": False,
    }

    async def call(self, client: GaptClient, *, project_id: str, **_: Any) -> Any:
        return await client.list_environments(project_id)


class GaptDeployTool(_GaptTool):
    name = "gapt_deploy"
    description = (
        "Kick off an async deploy of an environment. Returns a run id; "
        "poll the deploy run for status."
    )
    parameters = {
        "type": "object",
        "properties": {
            "environment_id": {"type": "string"},
            "version": {"type": "string", "description": "Optional version/ref to pin."},
        },
        "required": ["environment_id"],
        "additionalProperties": False,
    }

    async def call(self, client: GaptClient, *, environment_id: str, version: str = "", **_: Any) -> Any:
        return await client.deploy_environment(environment_id, version=version or None)


# Auto-discovered by the tool loader. Empty when GAPT isn't configured so a
# GAPT-less deployment exposes no GAPT tools.
TOOLS = (
    [
        GaptOverviewTool(),
        GaptListProjectsTool(),
        GaptCreateProjectTool(),
        GaptListWorkspacesTool(),
        GaptCreateWorkspaceTool(),
        GaptManageWorkspaceTool(),
        GaptRunCommandTool(),
        GaptListEnvironmentsTool(),
        GaptDeployTool(),
    ]
    if get_gapt_client().configured
    else []
)
