"""Auth plumbing contracts behind the 2026-08-16 Voice Studio outage.

Root cause chain being pinned here:
  1. The global RequireLoginMiddleware (secure-by-default, 2026-07-12)
     gates every /api path — including all voice-studio GETs and audio
     byte routes that the frontend fetched WITHOUT an Authorization
     header, relying on the geny_auth_token cookie.
  2. That cookie was pinned to 7 days while the JWT lives
     TOKEN_EXPIRE_HOURS (default 30d) — after day 7, Bearer surfaces
     kept working and every cookie surface 401'd.
  3. EventSource (voice-studio SSE) can never send headers, so the
     middleware must accept ?token= like the overlay already does.

Contracts:
  * _extract_token: Bearer > cookie > ?token= query param
  * RequireLoginMiddleware passes a valid ?token= request through
  * the login cookie max_age equals the JWT lifetime
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient


def _fake_request(headers=None, cookies=None, query=""):
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/x",
        "query_string": query.encode(),
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
    }
    req = Request(scope)
    if cookies:
        req._cookies = cookies  # Request lazily parses; inject directly
    return req


def test_extract_token_priority_and_query_fallback():
    from service.auth.auth_middleware import _extract_token

    assert _extract_token(_fake_request(headers={"Authorization": "Bearer AAA"})) == "AAA"
    assert _extract_token(_fake_request(cookies={"geny_auth_token": "BBB"})) == "BBB"
    # the EventSource path: no header, no cookie, token in the query
    assert _extract_token(_fake_request(query="token=CCC")) == "CCC"
    assert _extract_token(_fake_request()) is None


def test_middleware_accepts_query_token(monkeypatch):
    import service.auth.auth_middleware as mw

    class _Svc:
        def verify_token(self, token):
            if token != "GOOD":
                raise ValueError("bad")
            return {"sub": "u"}

    monkeypatch.setattr(mw, "get_auth_service", lambda: _Svc())

    app = FastAPI()

    @app.get("/api/voice-studio/events")
    def events():
        return {"ok": True}

    wrapped = mw.RequireLoginMiddleware(app)
    client = TestClient(wrapped)

    assert client.get("/api/voice-studio/events").status_code == 401
    assert client.get("/api/voice-studio/events?token=BAD").status_code == 401
    res = client.get("/api/voice-studio/events?token=GOOD")
    assert res.status_code == 200 and res.json() == {"ok": True}


def test_login_cookie_lifetime_matches_token_lifetime():
    """The 7d-cookie/30d-token mismatch must never come back: every
    set_cookie in the auth controller derives max_age from
    TOKEN_EXPIRE_HOURS instead of a hardcoded constant."""
    import inspect

    import controller.auth_controller as ac

    src = inspect.getsource(ac)
    assert "max_age=86400 * 7" not in src, "cookie lifetime hardcoded to 7d again"
    assert src.count("TOKEN_EXPIRE_HOURS") >= 3, (
        "each set_cookie site should derive max_age from the token lifetime"
    )
