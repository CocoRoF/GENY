"""Provision a GAPT workspace for a Geny session and adapt it to the executor.

:class:`GaptSandboxHandle` satisfies ``geny_executor.llm_client.SandboxHandle``
(``container_name`` + idempotent async ``ensure()``), so the executor's
``ContainerCLIRunner`` runs the agent CLI inside the GAPT workspace container.

:class:`GaptWorkspaceProvider` is the idempotent "get-or-create" front door:
ensure a GAPT project (by slug) and a workspace (by name) exist and are running,
then return a handle.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from service.gapt.client import GaptApiError, GaptClient

logger = logging.getLogger(__name__)


def _workspace_id(ws: Any) -> Optional[str]:
    if isinstance(ws, dict):
        return ws.get("id") or ws.get("workspace_id")
    return None


class GaptSandboxHandle:
    """Executor ``SandboxHandle`` backed by a GAPT workspace.

    The container name follows GAPT's convention ``gapt-ws-<workspace_id>``
    (lowercased); ``ensure()`` asks GAPT to (idempotently) start the workspace
    container before the first ``docker exec``.
    """

    def __init__(self, client: GaptClient, workspace_id: str) -> None:
        self._client = client
        self.workspace_id = workspace_id
        self.container_name = f"gapt-ws-{workspace_id.lower()}"

    async def ensure(self) -> None:
        # Bring the workspace container live before the executor's docker exec.
        # ``/start`` is a no-op when the workspace is already "running" (and the
        # container may have been prebooted-then-released), so run a trivial
        # command — that path triggers GAPT's WorkspaceSandbox.ensure()
        # (docker run) and the container stays up. Idempotent; non-fatal if it
        # races (the docker exec surfaces the real error if it's truly down).
        try:
            await self._client.run_command(self.workspace_id, "true")
        except GaptApiError as exc:
            logger.warning(
                "gapt_sandbox.ensure_failed workspace=%s: %s", self.workspace_id, exc
            )


class GaptWorkspaceProvider:
    """Get-or-create GAPT projects/workspaces for Geny sessions."""

    def __init__(self, client: GaptClient) -> None:
        self._client = client

    async def _find_project_by_slug(self, slug: str) -> Optional[dict]:
        projects = await self._client.list_projects()
        items = projects.get("projects") if isinstance(projects, dict) else projects
        for p in items or []:
            if isinstance(p, dict) and p.get("slug") == slug:
                return p
        return None

    async def _find_workspace_by_name(
        self, project_id: str, name: str
    ) -> Optional[dict]:
        wss = await self._client.list_workspaces(project_id)
        items = wss.get("workspaces") if isinstance(wss, dict) else wss
        for w in items or []:
            if (
                isinstance(w, dict)
                and w.get("name") == name
                and w.get("status") != "archived"
            ):
                return w
        return None

    async def ensure_project(
        self, *, slug: str, display_name: Optional[str] = None, git_remote_url: str = ""
    ) -> dict:
        existing = await self._find_project_by_slug(slug)
        if existing:
            return existing
        created = await self._client.create_project(
            slug=slug, display_name=display_name, git_remote_url=git_remote_url
        )
        if not isinstance(created, dict):
            raise GaptApiError(500, "project.create_bad_response", str(created)[:200])
        return created

    async def ensure_workspace(
        self,
        *,
        project_slug: str,
        workspace_name: str,
        git_remote_url: str = "",
        wait_running: bool = True,
        wait_timeout_s: float = 180.0,
    ) -> GaptSandboxHandle:
        """Idempotently ensure ``project_slug``/``workspace_name`` exists and is
        running; return a :class:`GaptSandboxHandle` for it."""
        project = await self.ensure_project(
            slug=project_slug, git_remote_url=git_remote_url
        )
        project_id = project.get("id") or project.get("project_id")
        if not project_id:
            raise GaptApiError(500, "project.no_id", str(project)[:200])

        ws = await self._find_workspace_by_name(project_id, workspace_name)
        if ws is None:
            ws = await self._client.create_workspace(project_id, name=workspace_name)
        wid = _workspace_id(ws)
        if not wid:
            raise GaptApiError(500, "workspace.no_id", str(ws)[:200])

        if wait_running and (not isinstance(ws, dict) or ws.get("status") != "running"):
            await self._client.wait_workspace_running(wid, timeout_s=wait_timeout_s)

        logger.info(
            "gapt_workspace.ready project=%s workspace=%s id=%s",
            project_slug,
            workspace_name,
            wid,
        )
        return GaptSandboxHandle(self._client, wid)
