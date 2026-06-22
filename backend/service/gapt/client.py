"""Async HTTP client for the GAPT control plane (``/_gapt/api/**``).

Single-admin cookie auth: ``POST /_gapt/api/auth/login {id, password}`` → 204 +
session cookie (kept in the httpx cookie jar); re-login once on 401. Mirrors the
contract the ``gapt-mcp`` package implements.

Config (env):
  GAPT_BASE_URL        e.g. http://gapt-server:8088  (no trailing slash)
  GAPT_ADMIN_ID        admin login id  (default "admin")
  GAPT_ADMIN_PASSWORD  admin password  (default "admin")
  GAPT_TIMEOUT_S       per-request timeout seconds (default 60)
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


class GaptApiError(Exception):
    """A GAPT API call failed (non-2xx) or the client is misconfigured."""

    def __init__(self, status: int, code: str, reason: str) -> None:
        self.status = status
        self.code = code
        self.reason = reason
        super().__init__(f"[{status}] {code}: {reason}")


class GaptClient:
    """Thin async client. One instance per process is fine (httpx pools)."""

    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        login_id: Optional[str] = None,
        login_pw: Optional[str] = None,
        timeout_s: Optional[float] = None,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        self._base = (base_url if base_url is not None else os.getenv("GAPT_BASE_URL", "")).rstrip("/")
        self._id = login_id or os.getenv("GAPT_ADMIN_ID", "admin")
        self._pw = login_pw or os.getenv("GAPT_ADMIN_PASSWORD", "admin")
        self._timeout = timeout_s if timeout_s is not None else float(os.getenv("GAPT_TIMEOUT_S", "60"))
        # The httpx cookie jar persists the session cookie across requests.
        # ``transport`` is an injection seam for tests (httpx.MockTransport).
        self._client = httpx.AsyncClient(
            base_url=self._base or "http://gapt.invalid",
            timeout=self._timeout,
            transport=transport,
        )
        self._login_lock = asyncio.Lock()
        self._authed = False
        # Captured ``name=value`` cookie string. We send it manually rather
        # than rely on httpx's jar: GAPT marks the session cookie ``Secure``
        # in prod, which the jar would refuse to store/send over the internal
        # plain-http hop (gapt-server:8088). Mirrors the gapt-mcp client.
        self._cookie: Optional[str] = None

    @property
    def configured(self) -> bool:
        """True when a base URL is set (GAPT integration enabled)."""
        return bool(self._base)

    @property
    def base_url(self) -> str:
        return self._base

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------ auth
    async def _login(self) -> None:
        async with self._login_lock:
            resp = await self._client.post(
                "/_gapt/api/auth/login", json={"id": self._id, "password": self._pw}
            )
            if resp.status_code not in (200, 204):
                raise GaptApiError(
                    resp.status_code,
                    "auth.login_failed",
                    f"GAPT login failed (check GAPT_ADMIN_ID / GAPT_ADMIN_PASSWORD): "
                    f"{resp.text[:200]}",
                )
            # Capture the session cookie name=value manually (Secure flag would
            # otherwise drop it from the jar over the internal http hop).
            pairs = [
                sc.split(";", 1)[0].strip()
                for sc in resp.headers.get_list("set-cookie")
                if sc.split(";", 1)[0].strip()
            ]
            if not pairs:
                raise GaptApiError(
                    500, "auth.no_cookie", "GAPT login returned no session cookie"
                )
            self._cookie = "; ".join(pairs)
            self._authed = True

    # --------------------------------------------------------------- request
    async def request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict] = None,
        json: Any = None,
    ) -> Any:
        if not self._base:
            raise GaptApiError(0, "gapt.not_configured", "GAPT_BASE_URL is not set")
        if not self._authed:
            await self._login()
        headers = {"Cookie": self._cookie} if self._cookie else None
        resp = await self._client.request(
            method, path, params=params, json=json, headers=headers
        )
        if resp.status_code == 401:
            # Session expired/missing — re-login once and retry.
            self._authed = False
            await self._login()
            headers = {"Cookie": self._cookie} if self._cookie else None
            resp = await self._client.request(
                method, path, params=params, json=json, headers=headers
            )
        if resp.status_code >= 400:
            code, reason = "gapt.error", resp.text[:300]
            try:
                detail = resp.json().get("detail")
                if isinstance(detail, dict):
                    code = detail.get("code", code)
                    reason = detail.get("reason", reason)
                elif isinstance(detail, str):
                    reason = detail
            except Exception:
                pass
            raise GaptApiError(resp.status_code, code, reason)
        if resp.status_code == 204 or not resp.content:
            return None
        if "application/json" in resp.headers.get("content-type", ""):
            return resp.json()
        return resp.text

    async def get(self, path: str, **kw: Any) -> Any:
        return await self.request("GET", path, **kw)

    async def post(self, path: str, **kw: Any) -> Any:
        return await self.request("POST", path, **kw)

    async def delete(self, path: str, **kw: Any) -> Any:
        return await self.request("DELETE", path, **kw)

    # ----------------------------------------------------------- projects
    async def list_projects(self) -> Any:
        return await self.get("/_gapt/api/projects")

    async def get_project(self, project_id: str) -> Any:
        return await self.get(f"/_gapt/api/projects/{project_id}")

    async def create_project(
        self,
        *,
        slug: str,
        display_name: Optional[str] = None,
        git_remote_url: str = "",
    ) -> Any:
        return await self.post(
            "/_gapt/api/projects",
            json={
                "slug": slug,
                "display_name": display_name or slug,
                "git_remote_url": git_remote_url,
            },
        )

    # --------------------------------------------------------- workspaces
    async def list_workspaces(self, project_id: str) -> Any:
        return await self.get(f"/_gapt/api/projects/{project_id}/workspaces")

    async def create_workspace(
        self,
        project_id: str,
        *,
        name: str,
        selections: Optional[list] = None,
    ) -> Any:
        body: dict[str, Any] = {"name": name}
        if selections is not None:
            body["selections"] = selections
        return await self.post(
            f"/_gapt/api/projects/{project_id}/workspaces", json=body
        )

    async def get_workspace(self, workspace_id: str) -> Any:
        return await self.get(f"/_gapt/api/workspaces/{workspace_id}")

    async def start_workspace(self, workspace_id: str) -> Any:
        return await self.post(f"/_gapt/api/workspaces/{workspace_id}/start")

    async def stop_workspace(self, workspace_id: str) -> Any:
        return await self.post(f"/_gapt/api/workspaces/{workspace_id}/stop")

    async def wait_workspace_running(
        self, workspace_id: str, *, timeout_s: float = 180.0, interval_s: float = 2.0
    ) -> dict:
        """Poll ``get_workspace`` until status is ``running`` (or raise).

        Workspace creation/clone is async; the create call returns immediately
        with status ``creating``."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout_s
        last: dict = {}
        while loop.time() < deadline:
            ws = await self.get_workspace(workspace_id)
            last = ws if isinstance(ws, dict) else {}
            status = last.get("status")
            if status == "running":
                return last
            if status in ("failed", "archived"):
                raise GaptApiError(
                    409,
                    "workspace.not_running",
                    f"workspace {workspace_id} entered status={status}",
                )
            await asyncio.sleep(interval_s)
        raise GaptApiError(
            504,
            "workspace.timeout",
            f"workspace {workspace_id} not running after {timeout_s:.0f}s "
            f"(last status={last.get('status')})",
        )


_singleton: Optional[GaptClient] = None


def get_gapt_client() -> GaptClient:
    """Process-wide GAPT client (lazy). Returns an unconfigured client when
    ``GAPT_BASE_URL`` is unset — callers gate on ``.configured``."""
    global _singleton
    if _singleton is None:
        _singleton = GaptClient()
    return _singleton
