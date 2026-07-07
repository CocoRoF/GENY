"""Central provider-key resolver + live validator (LLM & Provider panel).

Contract under test: the key pasted in the LLM & Provider settings
(LLMCredentialsConfig) is what every service resolves; env is only a
legacy fallback. Validation probes the provider once per key value and
maps 401/403 → rejected, 2xx → verified, transport trouble → unknown
(never cached, never treated as rejection).
"""

from __future__ import annotations

import sys
import types

import pytest

import service.config.credentials as creds_mod
import service.config.manager as manager_mod


class _FakeCreds:
    def __init__(self, openai="", anthropic="", google=""):
        self.openai_api_key = openai
        self.anthropic_api_key = anthropic
        self.google_api_key = google


class _FakeCM:
    def __init__(self, creds):
        self._creds = creds

    def load_config(self, cls):
        return self._creds


@pytest.fixture(autouse=True)
def _clean_cache():
    creds_mod._VALIDATION_CACHE.clear()
    yield
    creds_mod._VALIDATION_CACHE.clear()


def test_config_value_wins_over_env(monkeypatch):
    monkeypatch.setattr(
        manager_mod, "get_config_manager",
        lambda: _FakeCM(_FakeCreds(openai="sk-from-settings")),
    )
    monkeypatch.setenv("OPENAI_API_KEY", "sk-stale-env")
    assert creds_mod.resolve_provider_key("openai") == "sk-from-settings"


def test_env_fallback_when_config_empty(monkeypatch):
    monkeypatch.setattr(
        manager_mod, "get_config_manager", lambda: _FakeCM(_FakeCreds()),
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-env")
    assert creds_mod.resolve_provider_key("anthropic") == "sk-ant-env"
    assert creds_mod.resolve_provider_key("nope") == ""


def _install_fake_httpx(monkeypatch, status_code=None, exc=None, counter=None):
    class _Resp:
        def __init__(self):
            self.status_code = status_code

    class _Client:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None):
            if counter is not None:
                counter["n"] += 1
            if exc is not None:
                raise exc
            return _Resp()

    fake = types.SimpleNamespace(AsyncClient=_Client)
    monkeypatch.setitem(sys.modules, "httpx", fake)


@pytest.mark.asyncio
async def test_rejected_key_cached(monkeypatch):
    calls = {"n": 0}
    _install_fake_httpx(monkeypatch, status_code=401, counter=calls)
    ok, detail = await creds_mod.validate_provider_key("openai", "sk-bad")
    assert ok is False and "401" in detail
    ok2, _ = await creds_mod.validate_provider_key("openai", "sk-bad")
    assert ok2 is False
    assert calls["n"] == 1  # verdict cached per key value

    # force busts the cache
    await creds_mod.validate_provider_key("openai", "sk-bad", force=True)
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_valid_key_verified(monkeypatch):
    _install_fake_httpx(monkeypatch, status_code=200)
    ok, detail = await creds_mod.validate_provider_key("google", "AIza-ok")
    assert ok is True and detail == "verified"


@pytest.mark.asyncio
async def test_transport_error_is_unknown_and_uncached(monkeypatch):
    calls = {"n": 0}
    _install_fake_httpx(monkeypatch, exc=RuntimeError("net down"), counter=calls)
    ok, _ = await creds_mod.validate_provider_key("openai", "sk-x")
    assert ok is None
    await creds_mod.validate_provider_key("openai", "sk-x")
    assert calls["n"] == 2  # unknown verdicts re-probe


@pytest.mark.asyncio
async def test_no_key_is_unknown(monkeypatch):
    monkeypatch.setattr(
        manager_mod, "get_config_manager", lambda: _FakeCM(_FakeCreds()),
    )
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    ok, detail = await creds_mod.validate_provider_key("openai")
    assert ok is None and "no key" in detail
