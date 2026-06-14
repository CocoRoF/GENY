"""Unit tests for the WebSocket auth helpers (Phase 1a).

Covers:
* ``_extract_ws_token`` — every source (Authorization header, geny-auth
  subprotocol, ?token= query param, geny_auth_token cookie), precedence, and
  the empty case.
* ``require_ws_auth`` — valid token → payload + negotiated subprotocol;
  invalid/missing → unauthorized; GENY_AUTH_STRICT + no DB → refuse; not
  strict + no DB → anonymous (back-compat).
* ``ws_auth_or_close`` — closes with code 4401 on failure.

These are pure-Python unit tests with a fake WebSocket and a real AuthService
that never touches a DB (only its JWT secret + verify_token are exercised).
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

import service.auth.auth_middleware as mw
from service.auth.auth_middleware import (
    WS_AUTH_SUBPROTOCOL,
    WS_UNAUTHORIZED_CODE,
    _extract_ws_token,
    require_ws_auth,
    ws_auth_or_close,
)
from service.auth.auth_service import AuthService


# ── fakes ────────────────────────────────────────────────────────────


class _FakeHeaders:
    """Case-insensitive header lookup like Starlette's Headers."""

    def __init__(self, data: dict[str, str]):
        self._data = {k.lower(): v for k, v in data.items()}

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key.lower(), default)


class _FakeWebSocket:
    """Minimal stand-in for starlette WebSocket for extraction/auth tests."""

    def __init__(
        self,
        headers: Optional[dict[str, str]] = None,
        query_params: Optional[dict[str, str]] = None,
        cookies: Optional[dict[str, str]] = None,
    ):
        self.headers = _FakeHeaders(headers or {})
        self.query_params = dict(query_params or {})
        self.cookies = dict(cookies or {})
        self.closed_with: Optional[tuple[int, str]] = None
        self.accepted_subprotocol: Any = "NOT_ACCEPTED"

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)

    async def accept(self, subprotocol: Optional[str] = None) -> None:
        self.accepted_subprotocol = subprotocol


def _make_auth_service() -> AuthService:
    """A real AuthService with a fixed secret and no DB access."""
    svc = AuthService(app_db=None)  # app_db unused by token methods
    svc._secret_key = "test-secret-key-for-ws-auth-which-is-long-enough-32+"
    return svc


@pytest.fixture
def auth_service(monkeypatch):
    svc = _make_auth_service()
    monkeypatch.setattr(mw, "get_auth_service", lambda: svc)
    return svc


@pytest.fixture(autouse=True)
def _clear_strict(monkeypatch):
    # Default: strict mode OFF unless a test sets it.
    monkeypatch.delenv("GENY_AUTH_STRICT", raising=False)
    yield


def _token_for(svc: AuthService, username: str = "admin") -> str:
    return svc._create_token(username, username)["access_token"]


# ── _extract_ws_token: each source ──────────────────────────────────


def test_extract_from_authorization_header():
    ws = _FakeWebSocket(headers={"Authorization": "Bearer header-token"})
    assert _extract_ws_token(ws) == "header-token"


def test_extract_from_subprotocol():
    ws = _FakeWebSocket(headers={"Sec-WebSocket-Protocol": "geny-auth, sub-token"})
    assert _extract_ws_token(ws) == "sub-token"


def test_extract_from_subprotocol_no_spaces():
    ws = _FakeWebSocket(headers={"Sec-WebSocket-Protocol": "geny-auth,sub-token"})
    assert _extract_ws_token(ws) == "sub-token"


def test_extract_from_query_param():
    ws = _FakeWebSocket(query_params={"token": "query-token"})
    assert _extract_ws_token(ws) == "query-token"


def test_extract_from_cookie():
    ws = _FakeWebSocket(cookies={"geny_auth_token": "cookie-token"})
    assert _extract_ws_token(ws) == "cookie-token"


def test_extract_none_when_absent():
    ws = _FakeWebSocket()
    assert _extract_ws_token(ws) is None


def test_subprotocol_marker_without_token_is_none():
    # 'geny-auth' present but nothing after it.
    ws = _FakeWebSocket(headers={"Sec-WebSocket-Protocol": "geny-auth"})
    assert _extract_ws_token(ws) is None


# ── _extract_ws_token: precedence ───────────────────────────────────


def test_precedence_header_beats_subprotocol():
    ws = _FakeWebSocket(
        headers={
            "Authorization": "Bearer header-token",
            "Sec-WebSocket-Protocol": "geny-auth, sub-token",
        },
    )
    assert _extract_ws_token(ws) == "header-token"


def test_precedence_subprotocol_beats_query():
    ws = _FakeWebSocket(
        headers={"Sec-WebSocket-Protocol": "geny-auth, sub-token"},
        query_params={"token": "query-token"},
    )
    assert _extract_ws_token(ws) == "sub-token"


def test_precedence_query_beats_cookie():
    ws = _FakeWebSocket(
        query_params={"token": "query-token"},
        cookies={"geny_auth_token": "cookie-token"},
    )
    assert _extract_ws_token(ws) == "query-token"


# ── require_ws_auth: with AuthService ───────────────────────────────


@pytest.mark.asyncio
async def test_valid_subprotocol_token_authorizes_and_negotiates(auth_service):
    token = _token_for(auth_service)
    ws = _FakeWebSocket(headers={"Sec-WebSocket-Protocol": f"geny-auth, {token}"})

    result = await require_ws_auth(ws)

    assert result.authorized is True
    assert result.payload["sub"] == "admin"
    # Client offered geny-auth → server must echo it.
    assert result.subprotocol == WS_AUTH_SUBPROTOCOL


@pytest.mark.asyncio
async def test_valid_header_token_authorizes_no_subprotocol(auth_service):
    token = _token_for(auth_service)
    ws = _FakeWebSocket(headers={"Authorization": f"Bearer {token}"})

    result = await require_ws_auth(ws)

    assert result.authorized is True
    assert result.payload["sub"] == "admin"
    # No subprotocol offered → none echoed (header path, e.g. desktop connector).
    assert result.subprotocol is None


@pytest.mark.asyncio
async def test_invalid_token_unauthorized(auth_service):
    ws = _FakeWebSocket(headers={"Authorization": "Bearer not-a-real-jwt"})

    result = await require_ws_auth(ws)

    assert result.authorized is False
    assert result.payload is None


@pytest.mark.asyncio
async def test_missing_token_unauthorized(auth_service):
    ws = _FakeWebSocket()

    result = await require_ws_auth(ws)

    assert result.authorized is False


# ── require_ws_auth: no DB / strict matrix ──────────────────────────


@pytest.mark.asyncio
async def test_no_db_not_strict_allows_anonymous(monkeypatch):
    monkeypatch.setattr(mw, "get_auth_service", lambda: None)
    monkeypatch.delenv("GENY_AUTH_STRICT", raising=False)

    ws = _FakeWebSocket()
    result = await require_ws_auth(ws)

    assert result.authorized is True
    assert result.payload["sub"] == "anonymous"


@pytest.mark.asyncio
async def test_no_db_not_strict_echoes_offered_subprotocol(monkeypatch):
    """A browser that already speaks geny-auth must still complete handshake."""
    monkeypatch.setattr(mw, "get_auth_service", lambda: None)
    monkeypatch.delenv("GENY_AUTH_STRICT", raising=False)

    ws = _FakeWebSocket(headers={"Sec-WebSocket-Protocol": "geny-auth, anything"})
    result = await require_ws_auth(ws)

    assert result.authorized is True
    assert result.subprotocol == WS_AUTH_SUBPROTOCOL


@pytest.mark.asyncio
async def test_no_db_strict_refuses(monkeypatch):
    monkeypatch.setattr(mw, "get_auth_service", lambda: None)
    monkeypatch.setenv("GENY_AUTH_STRICT", "1")

    ws = _FakeWebSocket()
    result = await require_ws_auth(ws)

    assert result.authorized is False
    assert result.payload is None


# ── ws_auth_or_close ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ws_auth_or_close_returns_result_on_success(auth_service):
    token = _token_for(auth_service)
    ws = _FakeWebSocket(headers={"Authorization": f"Bearer {token}"})

    result = await ws_auth_or_close(ws)

    assert result is not None
    assert result.authorized is True
    # Helper must NOT accept — caller controls accept().
    assert ws.accepted_subprotocol == "NOT_ACCEPTED"
    assert ws.closed_with is None


@pytest.mark.asyncio
async def test_ws_auth_or_close_closes_4401_on_failure(auth_service):
    ws = _FakeWebSocket(headers={"Authorization": "Bearer bad"})

    result = await ws_auth_or_close(ws)

    assert result is None
    assert ws.closed_with is not None
    assert ws.closed_with[0] == WS_UNAUTHORIZED_CODE
