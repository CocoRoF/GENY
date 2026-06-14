"""REST auth-gating tests for the endpoints hardened in Phase 1a.

* POST /api/chat/rooms/{room}/broadcast
* POST /api/tts/agents/{id}/speak
* POST /api/tts/agents/{id}/speak/chunks
* POST /api/auth/refresh

For each gated endpoint we assert it returns 401 without a token and that a
valid token passes the auth gate (the request is NOT rejected with 401 — it
proceeds to downstream logic, which may 404/204/500 but never 401). This is
exactly the browser-safe contract: the browser already sends Authorization:
Bearer / cookie, so it keeps working.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import service.auth.auth_middleware as mw  # noqa: E402
import controller.auth_controller as auth_ctrl  # noqa: E402
from service.auth.auth_service import AuthService  # noqa: E402

from controller.auth_controller import router as auth_router  # noqa: E402
from controller.chat_controller import router as chat_router  # noqa: E402
from controller.tts_controller import router as tts_router  # noqa: E402


@pytest.fixture
def auth_service(monkeypatch):
    svc = AuthService(app_db=None)
    svc._secret_key = "rest-test-secret-key-which-is-long-enough-32chars+"
    # Patch BOTH the middleware lookup and the auth_controller lookup so the
    # whole stack sees the same service.
    monkeypatch.setattr(mw, "get_auth_service", lambda: svc)
    monkeypatch.setattr(auth_ctrl, "get_auth_service", lambda: svc)
    monkeypatch.delenv("GENY_AUTH_STRICT", raising=False)
    return svc


@pytest.fixture
def client(auth_service):
    app = FastAPI()
    app.include_router(auth_router)
    app.include_router(chat_router)
    app.include_router(tts_router)
    return TestClient(app)


def _token(svc: AuthService) -> str:
    return svc._create_token("admin", "admin")["access_token"]


def _auth_header(svc: AuthService) -> dict:
    return {"Authorization": f"Bearer {_token(svc)}"}


# ── broadcast ───────────────────────────────────────────────────────


def test_broadcast_requires_auth(client):
    r = client.post("/api/chat/rooms/nope/broadcast", json={"message": "hi"})
    assert r.status_code == 401


def test_broadcast_with_token_passes_gate(client, auth_service):
    # Unknown room → 404 from the handler, proving auth passed (not 401).
    r = client.post(
        "/api/chat/rooms/nope/broadcast",
        json={"message": "hi"},
        headers=_auth_header(auth_service),
    )
    assert r.status_code != 401
    assert r.status_code == 404


# ── tts speak ───────────────────────────────────────────────────────


def test_tts_speak_requires_auth(client):
    r = client.post("/api/tts/agents/sess-1/speak", json={"text": "hello"})
    assert r.status_code == 401


def test_tts_speak_chunks_requires_auth(client):
    r = client.post(
        "/api/tts/agents/sess-1/speak/chunks",
        json={"sentences": ["hello"]},
    )
    assert r.status_code == 401


def test_tts_speak_with_token_passes_gate(client, auth_service):
    # Empty after sanitization is fine; the point is we get past the 401 gate.
    r = client.post(
        "/api/tts/agents/sess-1/speak",
        json={"text": ""},
        headers=_auth_header(auth_service),
    )
    assert r.status_code != 401


# ── auth refresh ────────────────────────────────────────────────────


def test_refresh_requires_auth(client):
    r = client.post("/api/auth/refresh")
    assert r.status_code == 401


def test_refresh_with_token_issues_new_token(client, auth_service):
    headers = _auth_header(auth_service)
    r = client.post("/api/auth/refresh", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"]
    assert body["username"] == "admin"
    assert body["token_type"] == "bearer"
    # Refreshed token must itself be valid.
    payload = auth_service.verify_token(body["access_token"])
    assert payload["sub"] == "admin"
    # Cookie refreshed too.
    assert "geny_auth_token" in r.cookies


# ── no-DB back-compat: gated endpoints still open when auth absent ──


def test_broadcast_open_when_no_auth_service(monkeypatch):
    monkeypatch.setattr(mw, "get_auth_service", lambda: None)
    monkeypatch.setattr(auth_ctrl, "get_auth_service", lambda: None)
    monkeypatch.delenv("GENY_AUTH_STRICT", raising=False)

    app = FastAPI()
    app.include_router(chat_router)
    c = TestClient(app)

    # No token, no auth service → require_auth returns anonymous, so we reach
    # the handler (404 for unknown room) rather than 401.
    r = c.post("/api/chat/rooms/nope/broadcast", json={"message": "hi"})
    assert r.status_code != 401
    assert r.status_code == 404
