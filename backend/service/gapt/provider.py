"""Provision a GAPT workspace for a Geny session and adapt it to the executor.

:class:`GaptSandboxHandle` satisfies ``geny_executor.llm_client.SandboxHandle``
(``container_name`` + idempotent async ``ensure()``), so the executor's
``ContainerCLIRunner`` runs the agent CLI inside the GAPT workspace container.

:class:`GaptWorkspaceProvider` is the idempotent "get-or-create" front door:
ensure a GAPT project (by slug) and a workspace (by name) exist and are running,
then return a handle.
"""

from __future__ import annotations

import asyncio
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
    (lowercased). Beyond the base contract (``container_name`` + idempotent
    async ``ensure()``) this handle implements the executor's optional
    path-mapping protocol so a **bind** workspace — whose ``/workspace``
    bind-mounts the session's host workspace — presents ONE filesystem:

    * ``container_workdir`` — the in-container mount root (``/workspace``).
    * ``map_path(path)`` — backend-visible session-workspace paths
      (``/data/geny_agent_sessions/<sid>/workspace/...``) and their
      host-side equivalents translate to ``/workspace/...``.

    ``ensure()`` is the self-healing ladder (fast → authoritative):

    1. ``docker inspect`` — already running → done (~20 ms fast path).
    2. ``docker start`` — container exists but stopped (idle-reaped).
    3. GAPT ``start_workspace`` API — authoritative recreate: rebuilds a
       MISSING container from the workspace row (survives GAPT upgrades,
       image bumps, prunes) and keeps GAPT's status truthful.
    4. Workspace row gone (404 — e.g. a GAPT DB reset): the
       ``reprovision`` callback re-creates the workspace by name and the
       handle re-targets the new ids in place.
    """

    def __init__(
        self,
        client: GaptClient,
        workspace_id: str,
        *,
        backend_workspace_dir: Optional[str] = None,
        bind_host_dir: Optional[str] = None,
        reprovision: Optional[Any] = None,
    ) -> None:
        self._client = client
        self.workspace_id = workspace_id
        self.container_name = f"gapt-ws-{workspace_id.lower()}"
        # Path-mapping roots (bind workspaces only; None → legacy handle
        # behaviour, executor degrades unmappable workdirs to /workspace).
        self._roots = tuple(
            r.rstrip("/")
            for r in (backend_workspace_dir, bind_host_dir)
            if r and r.strip()
        )
        self.container_workdir = "/workspace"
        # Bind workspaces: the mounted dir is owned by the host service
        # user (root in the backend container), while the ws image defaults
        # to ubuntu:1000 — pin exec to root so container-side writes and
        # host-side tools agree (executor 2.60.1 exec_user protocol).
        self.exec_user = "0:0" if self._roots else None
        self._reprovision = reprovision

    # ── executor path-mapping protocol ──────────────────────────────
    def map_path(self, path: str) -> Optional[str]:
        if not path:
            return None
        for root in self._roots:
            if path == root:
                return self.container_workdir
            if path.startswith(root + "/"):
                return self.container_workdir + path[len(root):]
        return None

    # ── self-healing ─────────────────────────────────────────────────
    async def _docker(self, *args: str, timeout_s: float = 10.0) -> tuple[int, str]:
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
            return proc.returncode or 0, out.decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001 — docker CLI missing/unreachable
            return -1, str(exc)

    async def ensure(self) -> None:
        # 1) Fast path: already running.
        rc, out = await self._docker(
            "inspect", "-f", "{{.State.Running}}", self.container_name, timeout_s=5.0
        )
        if rc == 0 and out.strip().lower() == "true":
            return
        # 2) Stopped-but-present: cheap revive (idle-reaper case).
        if rc == 0:
            rc2, _ = await self._docker("start", self.container_name)
            if rc2 == 0:
                return
        # 3) Missing / start failed: authoritative recreate through GAPT —
        # rebuilds the container from the workspace row with its mounts.
        try:
            await self._client.start_workspace(self.workspace_id)
            return
        except GaptApiError as exc:
            if exc.status == 404 and self._reprovision is not None:
                # 4) Workspace row itself is gone — re-create by name and
                # re-target this handle in place (callers keep their ref).
                try:
                    fresh = await self._reprovision()
                    if fresh is not None:
                        self.workspace_id = fresh.workspace_id
                        self.container_name = fresh.container_name
                        logger.info(
                            "gapt_sandbox.reprovisioned → %s", self.workspace_id
                        )
                        return
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "gapt_sandbox.reprovision_failed workspace=%s",
                        self.workspace_id, exc_info=True,
                    )
            logger.debug(
                "gapt_sandbox.start_api_miss workspace=%s: %s",
                self.workspace_id, exc,
            )
        except Exception:  # noqa: BLE001
            logger.debug(
                "gapt_sandbox.start_api_error workspace=%s",
                self.workspace_id, exc_info=True,
            )
        # 5) Final fallback regardless of WHY the API start missed:
        # run_command triggers GAPT's WorkspaceSandbox.ensure() (docker run)
        # — the proven legacy revival path.
        try:
            await self._client.run_command(self.workspace_id, "true")
        except Exception:  # noqa: BLE001
            logger.warning(
                "gapt_sandbox.ensure_failed workspace=%s (all paths)",
                self.workspace_id, exc_info=True,
            )


class GaptWorkspaceProvider:
    """Get-or-create GAPT projects/workspaces for Geny sessions."""

    def __init__(self, client: GaptClient) -> None:
        self._client = client

    async def _find_project_by_slug(self, slug: str) -> Optional[dict]:
        # include_archived: GAPT archives empty projects, and an archived
        # project still accepts new workspaces — so reuse it by id rather than
        # hit a 409 slug-taken on a blind create.
        projects = await self._client.list_projects(include_archived=True)
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
        try:
            created = await self._client.create_project(
                slug=slug, display_name=display_name, git_remote_url=git_remote_url
            )
        except GaptApiError as exc:
            # Race / archived edge: another caller created it, or it exists but
            # was filtered — re-find (include_archived) and reuse.
            if exc.status == 409:
                found = await self._find_project_by_slug(slug)
                if found:
                    return found
            raise
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
        wait_timeout_s: float = 300.0,
        bind_host_dir: Optional[str] = None,
        backend_workspace_dir: Optional[str] = None,
    ) -> GaptSandboxHandle:
        """Idempotently ensure ``project_slug``/``workspace_name`` exists and is
        running; return a :class:`GaptSandboxHandle` for it.

        With ``bind_host_dir`` the workspace is created as GAPT kind='bind':
        its container /workspace bind-mounts the session's HOST workspace
        directory — one session, one sandbox, ONE filesystem. A pre-existing
        legacy (worktree-kind) workspace under the same name is archived and
        re-created as bind, so upgraded deployments converge without manual
        migration (session files all live on the Geny side; nothing is lost).
        ``backend_workspace_dir`` is the same directory as seen from THIS
        process (for the handle's path mapping)."""
        project = await self.ensure_project(
            slug=project_slug, git_remote_url=git_remote_url
        )
        project_id = project.get("id") or project.get("project_id")
        if not project_id:
            raise GaptApiError(500, "project.no_id", str(project)[:200])

        ws = await self._find_workspace_by_name(project_id, workspace_name)
        if (
            ws is not None
            and bind_host_dir
            and (ws.get("kind") or "worktree") != "bind"
        ):
            # Legacy worktree workspace from before the unification —
            # archive it (bind dirs untouched by GAPT deletes) and fall
            # through to a fresh bind creation under the same name.
            wid_old = _workspace_id(ws)
            try:
                if wid_old:
                    await self._client.delete_workspace(wid_old)
                    logger.info(
                        "gapt_workspace.migrated_legacy name=%s old=%s → bind",
                        workspace_name, wid_old,
                    )
            except GaptApiError:
                logger.warning(
                    "gapt_workspace.legacy_archive_failed name=%s", workspace_name,
                    exc_info=True,
                )
            ws = None
        created = ws is None
        if created:
            if bind_host_dir:
                ws = await self._client.create_workspace(
                    project_id,
                    name=workspace_name,
                    kind="bind",
                    worktree_path=bind_host_dir,
                )
            else:
                ws = await self._client.create_workspace(
                    project_id, name=workspace_name
                )
        wid = _workspace_id(ws)
        if not wid:
            raise GaptApiError(500, "workspace.no_id", str(ws)[:200])

        if (
            wait_running
            and created
            and (not isinstance(ws, dict) or ws.get("status") != "running")
        ):
            # Best-effort, FRESH workspaces only: give the just-created
            # container a short window to preboot so the very first tool
            # call is snappy. EXISTING workspaces (the session-wakeup path)
            # never wait here — GAPT's status field can lag/stick at
            # 'creating' even though the container is up, and blocking on
            # it made every backend-restart wakeup eat the full timeout
            # (~45s of a ~49s resume, prod 2026-07-06). The executor execs
            # the container directly and ``GaptSandboxHandle.ensure()``
            # idempotently ``docker start``s it before the first exec, so
            # readiness is guaranteed lazily either way.
            try:
                await self._client.wait_workspace_running(
                    wid, timeout_s=min(wait_timeout_s, 10.0)
                )
            except GaptApiError as exc:
                logger.warning(
                    "gapt_workspace.status_lag workspace=%s (%s) — proceeding; "
                    "container is prebooted and exec'd directly",
                    wid,
                    exc.code,
                )

        logger.info(
            "gapt_workspace.ready project=%s workspace=%s id=%s kind=%s",
            project_slug,
            workspace_name,
            wid,
            "bind" if bind_host_dir else "worktree",
        )

        async def _reprovision() -> Optional[GaptSandboxHandle]:
            # Workspace row vanished (GAPT DB reset / manual archive) —
            # re-create by the same name with the same bind dir.
            return await self.ensure_workspace(
                project_slug=project_slug,
                workspace_name=workspace_name,
                git_remote_url=git_remote_url,
                wait_running=False,
                bind_host_dir=bind_host_dir,
                backend_workspace_dir=backend_workspace_dir,
            )

        return GaptSandboxHandle(
            self._client,
            wid,
            backend_workspace_dir=backend_workspace_dir,
            bind_host_dir=bind_host_dir,
            reprovision=_reprovision,
        )
