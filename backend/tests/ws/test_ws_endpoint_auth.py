"""Endpoint-level WebSocket auth tests (Phase 1a).

Spins up a minimal FastAPI app that mounts the three real WS routers
(execute / avatar / chat) plus a real AuthService (no DB — only token
methods are exercised). Asserts:

* Authorized connect (subprotocol token) → handshake succeeds and the server
  echoes the 'geny-auth' subprotocol.
* Unauthorized connect (no / bad token) → server closes with code 4401 before
  accepting.

We only need to verify the auth gate, which runs *before* any store / app.state
dependency, so the handlers' downstream logic is irrelevant here.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import service.auth.auth_middleware as mw  # noqa: E402
from service.auth.auth_middleware import WS_AUTH_SUBPROTOCOL, WS_UNAUTHORIZED_CODE  # noqa: E402
from service.auth.auth_service import AuthService  # noqa: E402

from ws import avatar_stream, chat_stream, execute_stream  # noqa: E402


WS_PATHS = [
    ("/ws/execute/sess-1", "execute"),
    ("/ws/vtuber/agents/sess-1/state", "avatar"),
    ("/ws/chat/rooms/room-1", "chat"),
]


@pytest.fixture
def auth_service(monkeypatch):
    svc = AuthService(app_db=None)
    svc._secret_key = "endpoint-test-secret-key-which-is-long-enough-32+"
    monkeypatch.setattr(mw, "get_auth_service", lambda: svc)
    monkeypatch.delenv("GENY_AUTH_STRICT", raising=False)
    return svc


@pytest.fixture
def client(auth_service):
    app = FastAPI()
    app.include_router(execute_stream.router)
    app.include_router(avatar_stream.router)
    app.include_router(chat_stream.router)
    # Minimal app.state so the avatar handler doesn't crash *after* accept.
    # (Auth runs before this is touched; we only need the handshake to land.)
    return TestClient(app)


def _token(svc: AuthService) -> str:
    return svc._create_token("admin", "admin")["access_token"]


@pytest.mark.parametrize("path,_name", WS_PATHS)
def test_authorized_connect_echoes_subprotocol(client, auth_service, path, _name):
    token = _token(auth_service)
    with client.websocket_connect(path, subprotocols=[WS_AUTH_SUBPROTOCOL, token]) as ws:
        # Handshake completed → server echoed the negotiated subprotocol.
        assert ws.accepted_subprotocol == WS_AUTH_SUBPROTOCOL


@pytest.mark.parametrize("path,_name", WS_PATHS)
def test_unauthorized_no_token_closes_4401(client, path, _name):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(path):
            pass
    assert exc.value.code == WS_UNAUTHORIZED_CODE


@pytest.mark.parametrize("path,_name", WS_PATHS)
def test_unauthorized_bad_token_closes_4401(client, path, _name):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(path, subprotocols=[WS_AUTH_SUBPROTOCOL, "garbage"]):
            pass
    assert exc.value.code == WS_UNAUTHORIZED_CODE


@pytest.mark.parametrize("path,_name", WS_PATHS)
def test_no_db_not_strict_allows_anonymous_connect(monkeypatch, path, _name):
    """Back-compat: with no AuthService and no strict flag, connect succeeds."""
    monkeypatch.setattr(mw, "get_auth_service", lambda: None)
    monkeypatch.delenv("GENY_AUTH_STRICT", raising=False)

    app = FastAPI()
    app.include_router(execute_stream.router)
    app.include_router(avatar_stream.router)
    app.include_router(chat_stream.router)
    c = TestClient(app)

    # No token at all — should still be accepted (anonymous), not 4401.
    with c.websocket_connect(path) as ws:
        assert ws.accepted_subprotocol is None


@pytest.mark.parametrize("path,_name", WS_PATHS)
def test_no_db_strict_refuses_connect(monkeypatch, path, _name):
    monkeypatch.setattr(mw, "get_auth_service", lambda: None)
    monkeypatch.setenv("GENY_AUTH_STRICT", "1")

    app = FastAPI()
    app.include_router(execute_stream.router)
    app.include_router(avatar_stream.router)
    app.include_router(chat_stream.router)
    c = TestClient(app)

    with pytest.raises(WebSocketDisconnect) as exc:
        with c.websocket_connect(path):
            pass
    assert exc.value.code == WS_UNAUTHORIZED_CODE
