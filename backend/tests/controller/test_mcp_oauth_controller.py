"""Endpoint tests for /api/agents/{id}/mcp/servers/{name}/auth/start
and /api/mcp/resources (G10.2 / G10.3 — controller/mcp_oauth_controller.py).

Same direct-handler pattern as test_endpoints.py for HITL: no
FastAPI TestClient, just stub the resolved manager and call the
handler functions directly. Skipped when fastapi isn't importable
(test venv).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

pytest.importorskip("fastapi")
from fastapi import HTTPException  # noqa: E402

import controller.mcp_oauth_controller as oauth_ctrl  # noqa: E402
from controller.mcp_oauth_controller import (  # noqa: E402
    oauth_start,
    resolve_mcp_uri,
)


# ── stubs ────────────────────────────────────────────────────────────


class _StubAuthResult:
    def __init__(self, url: str) -> None:
        self.authorize_url = url


class _StubManager:
    def __init__(
        self,
        *,
        oauth_url: str | None = None,
        oauth_raises: Exception | None = None,
        servers: dict[str, dict] | None = None,
        resource: Any = None,
        resource_raises: Exception | None = None,
        no_oauth_hook: bool = False,
        no_read_hook: bool = False,
    ) -> None:
        self._configs = dict(servers or {})
        self._oauth_url = oauth_url
        self._oauth_raises = oauth_raises
        self._resource = resource
        self._resource_raises = resource_raises
        if not no_oauth_hook:
            self.start_oauth = self._start_oauth
        if not no_read_hook:
            self.read_resource = self._read_resource

    def _start_oauth(self, name: str) -> Any:
        if self._oauth_raises is not None:
            raise self._oauth_raises
        return _StubAuthResult(self._oauth_url or f"https://example.com/auth/{name}")

    def _read_resource(self, server: str, resource_id: str) -> Any:
        if self._resource_raises is not None:
            raise self._resource_raises
        return self._resource


class _StubPipeline:
    def __init__(self, manager: Any) -> None:
        self._mcp_manager = manager


class _StubAgent:
    def __init__(self, pipeline: Any) -> None:
        self._pipeline = pipeline


@pytest.fixture(autouse=True)
def _patch_agent_manager(monkeypatch):
    """Replace the lazy-imported agent_controller.agent_manager that
    mcp_oauth_controller delegates to via _resolve_pipeline."""
    import controller.agent_controller as ac

    mgr = MagicMock()
    monkeypatch.setattr(ac, "agent_manager", mgr)
    yield mgr


def _bind(mgr, agent: Any) -> None:
    mgr.get_agent = MagicMock(return_value=agent)


# ── /auth/start ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_oauth_start_happy_path(_patch_agent_manager) -> None:
    manager = _StubManager(oauth_url="https://idp.example.com/oauth?state=abc")
    _bind(_patch_agent_manager, _StubAgent(_StubPipeline(manager)))
    resp = await oauth_start(session_id="s1", name="gdrive", auth={})
    assert resp.session_id == "s1"
    assert resp.server == "gdrive"
    assert resp.authorize_url == "https://idp.example.com/oauth?state=abc"


@pytest.mark.asyncio
async def test_oauth_start_unknown_session_404(_patch_agent_manager) -> None:
    _bind(_patch_agent_manager, None)
    with pytest.raises(HTTPException) as exc:
        await oauth_start(session_id="ghost", name="x", auth={})
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_oauth_start_no_manager_409(_patch_agent_manager) -> None:
    _bind(_patch_agent_manager, _StubAgent(_StubPipeline(None)))
    with pytest.raises(HTTPException) as exc:
        await oauth_start(session_id="s1", name="x", auth={})
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_oauth_start_no_hook_409(_patch_agent_manager) -> None:
    """Manager exposes no start_oauth/authorize/begin_oauth method."""
    manager = _StubManager(no_oauth_hook=True)
    _bind(_patch_agent_manager, _StubAgent(_StubPipeline(manager)))
    with pytest.raises(HTTPException) as exc:
        await oauth_start(session_id="s1", name="x", auth={})
    assert exc.value.status_code == 409
    assert "OAuth" in exc.value.detail or "oauth" in exc.value.detail.lower()


@pytest.mark.asyncio
async def test_oauth_start_raises_400(_patch_agent_manager) -> None:
    manager = _StubManager(oauth_raises=RuntimeError("transport refused"))
    _bind(_patch_agent_manager, _StubAgent(_StubPipeline(manager)))
    with pytest.raises(HTTPException) as exc:
        await oauth_start(session_id="s1", name="x", auth={})
    assert exc.value.status_code == 400


# ── /api/mcp/resources ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resolve_uri_invalid_400(_patch_agent_manager) -> None:
    manager = _StubManager(servers={"fs": {}})
    _bind(_patch_agent_manager, _StubAgent(_StubPipeline(manager)))
    with pytest.raises(HTTPException) as exc:
        await resolve_mcp_uri(uri="not-an-mcp-uri", session_id="s1", auth={})
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_resolve_uri_session_no_manager_409(_patch_agent_manager) -> None:
    _bind(_patch_agent_manager, _StubAgent(_StubPipeline(None)))
    with pytest.raises(HTTPException) as exc:
        await resolve_mcp_uri(
            uri="mcp://fs/some/path", session_id="s1", auth={},
        )
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_resolve_uri_happy_path(_patch_agent_manager) -> None:
    manager = _StubManager(
        servers={"fs": {}},
        resource={"content": "hello world", "mime_type": "text/plain"},
    )
    _bind(_patch_agent_manager, _StubAgent(_StubPipeline(manager)))
    resp = await resolve_mcp_uri(
        uri="mcp://fs/foo/bar", session_id="s1", auth={},
    )
    assert resp.server == "fs"
    assert resp.resource_id in ("foo/bar", "/foo/bar")  # parser normalisation varies
    assert resp.content == "hello world"
    assert resp.mime_type == "text/plain"


@pytest.mark.asyncio
async def test_resolve_uri_no_read_hook_409(_patch_agent_manager) -> None:
    manager = _StubManager(servers={"fs": {}}, no_read_hook=True)
    _bind(_patch_agent_manager, _StubAgent(_StubPipeline(manager)))
    with pytest.raises(HTTPException) as exc:
        await resolve_mcp_uri(uri="mcp://fs/x", session_id="s1", auth={})
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_resolve_uri_read_raises_400(_patch_agent_manager) -> None:
    manager = _StubManager(
        servers={"fs": {}}, resource_raises=RuntimeError("backend down"),
    )
    _bind(_patch_agent_manager, _StubAgent(_StubPipeline(manager)))
    with pytest.raises(HTTPException) as exc:
        await resolve_mcp_uri(uri="mcp://fs/x", session_id="s1", auth={})
    assert exc.value.status_code == 400
