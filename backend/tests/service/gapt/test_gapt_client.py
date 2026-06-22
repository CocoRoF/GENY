"""Tests for the Geny→GAPT client + workspace provider (httpx.MockTransport)."""

from __future__ import annotations

import httpx
import pytest

from service.gapt.client import GaptApiError, GaptClient
from service.gapt.provider import GaptSandboxHandle, GaptWorkspaceProvider


def _client(handler) -> GaptClient:
    return GaptClient(
        base_url="http://gapt-server:8088",
        login_id="admin",
        login_pw="secret",
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.asyncio
async def test_login_then_request_carries_cookie() -> None:
    seen: dict = {"login": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/_gapt/api/auth/login":
            seen["login"] += 1
            return httpx.Response(204, headers={"set-cookie": "gapt_session=abc; Path=/"})
        if request.url.path == "/_gapt/api/projects":
            assert "gapt_session=abc" in request.headers.get("cookie", "")
            return httpx.Response(200, json={"projects": []})
        return httpx.Response(404, json={"detail": {"code": "x", "reason": "nope"}})

    c = _client(handler)
    out = await c.list_projects()
    assert out == {"projects": []}
    assert seen["login"] == 1
    await c.aclose()


@pytest.mark.asyncio
async def test_relogin_once_on_401() -> None:
    state = {"logins": 0, "first": True}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/_gapt/api/auth/login":
            state["logins"] += 1
            return httpx.Response(204, headers={"set-cookie": "gapt_session=s; Path=/"})
        if request.url.path == "/_gapt/api/projects":
            if state["first"]:
                state["first"] = False
                return httpx.Response(401, json={"detail": "expired"})
            return httpx.Response(200, json=[])
        return httpx.Response(404)

    c = _client(handler)
    out = await c.list_projects()
    assert out == []
    assert state["logins"] == 2  # initial + one re-login on 401
    await c.aclose()


@pytest.mark.asyncio
async def test_error_surfaces_code_and_reason() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/login"):
            return httpx.Response(204, headers={"set-cookie": "gapt_session=s"})
        return httpx.Response(
            429, json={"detail": {"code": "workspace.cap_reached", "reason": "at limit"}}
        )

    c = _client(handler)
    with pytest.raises(GaptApiError) as ei:
        await c.create_workspace("p1", name="w1")
    assert ei.value.status == 429
    assert ei.value.code == "workspace.cap_reached"
    await c.aclose()


@pytest.mark.asyncio
async def test_not_configured_raises() -> None:
    c = GaptClient(base_url="", login_id="a", login_pw="b")
    assert c.configured is False
    with pytest.raises(GaptApiError) as ei:
        await c.list_projects()
    assert ei.value.code == "gapt.not_configured"
    await c.aclose()


@pytest.mark.asyncio
async def test_provider_get_or_create_returns_handle() -> None:
    created = {"project": False, "workspace": False}

    def handler(request: httpx.Request) -> httpx.Response:
        p = request.url.path
        if p.endswith("/login"):
            return httpx.Response(204, headers={"set-cookie": "gapt_session=s"})
        if p == "/_gapt/api/projects" and request.method == "GET":
            return httpx.Response(200, json={"projects": []})
        if p == "/_gapt/api/projects" and request.method == "POST":
            created["project"] = True
            return httpx.Response(200, json={"id": "proj-1", "slug": "geny"})
        if p == "/_gapt/api/projects/proj-1/workspaces" and request.method == "GET":
            return httpx.Response(200, json={"workspaces": []})
        if p == "/_gapt/api/projects/proj-1/workspaces" and request.method == "POST":
            created["workspace"] = True
            return httpx.Response(200, json={"id": "WS01ABC", "status": "running"})
        return httpx.Response(404, json={"detail": "unexpected " + p})

    c = _client(handler)
    provider = GaptWorkspaceProvider(c)
    handle = await provider.ensure_workspace(project_slug="geny", workspace_name="sess-1")
    assert isinstance(handle, GaptSandboxHandle)
    assert handle.workspace_id == "WS01ABC"
    assert handle.container_name == "gapt-ws-ws01abc"  # lowercased
    assert created == {"project": True, "workspace": True}
    await c.aclose()


@pytest.mark.asyncio
async def test_sandbox_handle_ensure_calls_start() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/login"):
            return httpx.Response(204, headers={"set-cookie": "gapt_session=s"})
        if request.url.path == "/_gapt/api/workspaces/WS9/start":
            calls.append("start")
            return httpx.Response(204)
        return httpx.Response(404)

    c = _client(handler)
    handle = GaptSandboxHandle(c, "WS9")
    await handle.ensure()
    assert calls == ["start"]
    await c.aclose()
