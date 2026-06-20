"""Per-environment tool-settings framework + web_search delegation."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from service.tool_settings import (
    RESERVED_EXTRAS_KEYS,
    get_tool_setting_schemas,
    register_tool_setting,
    sanitize_tool_settings,
)
from service.tool_settings.base import ToolSettingSchema


def test_web_search_schema_registered():
    schemas = {s["key"]: s for s in get_tool_setting_schemas()}
    assert "web_search" in schemas
    ws = schemas["web_search"]
    assert [f["name"] for f in ws["fields"]] == [
        "backend",
        "brave_api_key",
        "tavily_api_key",
        "searxng_url",
    ]
    # backend is a SELECT with the 4 executor backends
    backend = ws["fields"][0]
    assert backend["type"] == "select"
    assert [o["value"] for o in backend["options"]] == ["ddg", "brave", "tavily", "searxng"]
    # secrets are flagged secure; UI guide + ko i18n present
    assert dict(zip([f["name"] for f in ws["fields"]], [f["secure"] for f in ws["fields"]])) == {
        "backend": False,
        "brave_api_key": True,
        "tavily_api_key": True,
        "searxng_url": False,
    }
    assert "ko" in ws["i18n"] and ws["setup_guide"]


def test_sanitize_drops_unknown_keys_and_empty_fields():
    cleaned = sanitize_tool_settings(
        {
            "web_search": {"backend": "brave", "brave_api_key": "k", "junk": "x", "tavily_api_key": ""},
            "unknown_tool": {"a": 1},
        }
    )
    assert cleaned == {"web_search": {"backend": "brave", "brave_api_key": "k"}}


def test_sanitize_handles_non_dict():
    assert sanitize_tool_settings(None) == {}
    assert sanitize_tool_settings("nope") == {}
    assert sanitize_tool_settings({"web_search": "nope"}) == {}


def test_register_rejects_reserved_key():
    reserved = next(iter(RESERVED_EXTRAS_KEYS))

    with pytest.raises(ValueError):

        @register_tool_setting
        class _Bad(ToolSettingSchema):
            @classmethod
            def get_key(cls):
                return reserved

            @classmethod
            def get_display_name(cls):
                return "bad"

            @classmethod
            def get_fields(cls):
                return []


def test_custom_web_search_delegates_to_executor_backend():
    """A non-ddg backend config routes the custom web_search tool through the
    executor's pluggable backend (reuse, not duplicate)."""
    from tools.custom import web_search_tools

    captured = {}

    class _FakeBackend:
        async def search(self, query, max_results, region, safesearch):
            captured.update(query=query, max_results=max_results, region=region)
            return [{"rank": 1, "title": "T", "url": "http://x", "snippet": "S"}]

    def _fake_build_backend(name, ctx, **kw):
        captured["backend"] = name
        captured["cfg"] = ctx.extras["web_search"]
        return _FakeBackend()

    with patch(
        "geny_executor.tools.built_in._web_search_backends.build_backend",
        _fake_build_backend,
    ):
        out = web_search_tools.WebSearchTool().run(
            query="hello",
            max_results=3,
            web_search_config={"backend": "brave", "brave_api_key": "k"},
        )

    assert captured["backend"] == "brave"
    assert captured["cfg"] == {"backend": "brave", "brave_api_key": "k"}
    assert '"backend": "brave"' in out and '"title": "T"' in out


def test_custom_web_search_default_stays_ddg(monkeypatch):
    """No config → existing DuckDuckGo path (executor backend never built)."""
    from tools.custom import web_search_tools

    class _FakeDDGS:
        def text(self, *a, **k):
            return [{"title": "D", "href": "http://d", "body": "b"}]

    monkeypatch.setattr(web_search_tools, "_safe_ddgs_import", lambda: _FakeDDGS)
    sentinel = {"built": False}

    def _should_not_run(*a, **k):
        sentinel["built"] = True
        raise AssertionError("executor backend must not be used for ddg")

    monkeypatch.setattr(
        "geny_executor.tools.built_in._web_search_backends.build_backend", _should_not_run
    )
    out = web_search_tools.WebSearchTool().run(query="x", web_search_config=None)
    assert sentinel["built"] is False
    assert '"title": "D"' in out


def test_injected_param_hidden_from_llm():
    """web_search_config is host-injected — never exposed in the LLM schema."""
    from tools.custom.web_search_tools import WebSearchTool

    props = WebSearchTool().parameters["properties"]
    assert "web_search_config" not in props
    assert "query" in props
