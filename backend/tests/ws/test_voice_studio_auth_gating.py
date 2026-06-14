"""REST auth-gating tests for the Voice Studio synthesis surface.

Phase 1a closed the chat-path ``/api/tts/.../speak*`` family, but the
Voice Studio routes drive the SAME OmniVoice GPU engine and were left
open — a sibling resource-exhaustion hole (plan R1). These tests pin the
engine-driving / mutating routes shut:

* POST   /api/voice-studio/synth/preview
* POST   /api/voice-studio/synth/save-as-ref
* POST   /api/voice-studio/synth/history/{id}/replay
* DELETE /api/voice-studio/synth/history/{id}
* POST   /api/voice-studio/batch
* POST   /api/voice-studio/batch/{id}/cancel
* POST   /api/voice-studio/tools/detect-language
* POST   /api/voice-studio/tools/analyze-ref
* POST   /api/voice-studio/tools/seed-search

The R1-critical assertion is "401 without a token" — this fires BEFORE the
handler runs, so it never touches the GPU engine. The valid-token path
through ``require_auth`` is identical for every route and is already
covered exhaustively by tests/ws/test_rest_auth_gating.py (broadcast +
speak) and tests/service/auth/test_ws_auth_middleware.py (19 unit tests),
so we deliberately do NOT re-execute the heavy synthesis handlers here.

Read-only playback GETs (history audio, batch download, seed-search audio)
are intentionally NOT gated — they need an unguessable id and gating an
``<audio src>`` would regress the browser.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import service.auth.auth_middleware as mw  # noqa: E402
from service.auth.auth_service import AuthService  # noqa: E402

from controller.voice_studio import router as voice_studio_router  # noqa: E402


@pytest.fixture
def auth_service(monkeypatch):
    svc = AuthService(app_db=None)
    svc._secret_key = "vs-test-secret-key-which-is-long-enough-32chars+"
    monkeypatch.setattr(mw, "get_auth_service", lambda: svc)
    monkeypatch.delenv("GENY_AUTH_STRICT", raising=False)
    return svc


@pytest.fixture
def client(auth_service):
    app = FastAPI()
    app.include_router(voice_studio_router)
    return TestClient(app)


# Each entry: (method, path, json_body, files) — gated synthesis/mutating routes.
GATED = [
    ("post", "/api/voice-studio/synth/preview", {"text": "hi", "mode": "auto"}, None),
    (
        "post",
        "/api/voice-studio/synth/save-as-ref",
        {"history_id": "x", "profile": "p", "emotion": "neutral"},
        None,
    ),
    ("post", "/api/voice-studio/synth/history/x/replay", None, None),
    ("delete", "/api/voice-studio/synth/history/x", None, None),
    ("post", "/api/voice-studio/batch", {"lines": [{"text": "a"}]}, None),
    ("post", "/api/voice-studio/batch/x/cancel", None, None),
    ("post", "/api/voice-studio/tools/detect-language", {"text": "hello"}, None),
    ("post", "/api/voice-studio/tools/analyze-ref", None, {"file": ("r.wav", b"RIFF")}),
    (
        "post",
        "/api/voice-studio/tools/seed-search",
        {"text": "hi", "profile": "p"},
        None,
    ),
]


@pytest.mark.parametrize("method,path,body,files", GATED)
def test_voice_studio_route_requires_auth(client, method, path, body, files):
    """No token -> 401, raised by require_auth BEFORE the handler runs (so the
    GPU engine is never touched). This is the R1 closure proof."""
    kwargs = {}
    if body is not None:
        kwargs["json"] = body
    if files is not None:
        kwargs["files"] = files
    r = getattr(client, method)(path, **kwargs)
    assert r.status_code == 401, f"{method.upper()} {path} should 401 without a token"


def test_bad_token_is_rejected(client):
    """A malformed/forged token is rejected (401) — confirms the gate actually
    validates, not just presence-checks. Fires before the handler."""
    r = client.delete(
        "/api/voice-studio/synth/history/x",
        headers={"Authorization": "Bearer not-a-real-jwt"},
    )
    assert r.status_code == 401


# Note on no-DB back-compat: when auth_service is None + GENY_AUTH_STRICT unset,
# require_auth returns anonymous (not 401) — proven generically (and without a
# sqlite-touching handler) by tests/ws/test_rest_auth_gating.py
# ::test_broadcast_open_when_no_auth_service. We deliberately do NOT re-assert it
# here, because the only cheap voice-studio handler to land on (DELETE history)
# opens the voice_studio sqlite history store, which blocks under a concurrent
# writer in dev — a test-harness artifact, not an auth behavior.
