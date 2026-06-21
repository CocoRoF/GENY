"""Tool category + global Web Search config (with per-env override layering)."""

from __future__ import annotations

import os

from unittest.mock import patch


def test_tool_related_configs_are_in_tools_category():
    from service.config import get_config_manager

    classes = get_config_manager().get_registered_config_classes()
    for name in ("github", "blog_agent", "game", "web_search"):
        assert classes[name].get_category() == "tools", name
    # unrelated configs stay put
    assert classes["timezone"].get_category() == "general"


def test_web_search_config_schema_and_env_sync():
    from service.config.sub_config.tools.web_search_config import WebSearchConfig

    s = WebSearchConfig.get_schema()
    assert s["category"] == "tools"
    assert [f["name"] for f in s["fields"]] == [
        "backend",
        "brave_api_key",
        "tavily_api_key",
        "searxng_url",
    ]
    assert [o["value"] for o in s["fields"][0]["options"]] == ["ddg", "brave", "tavily", "searxng"]
    # secrets flagged secure
    secure = {f["name"]: f["secure"] for f in s["fields"]}
    assert secure["brave_api_key"] and secure["tavily_api_key"]
    # saving syncs the env var the executor reads (restore env after)
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GENY_WEBSEARCH_BACKEND", None)
        WebSearchConfig.get_fields_metadata()[0].apply_change(None, "brave")
        assert os.environ["GENY_WEBSEARCH_BACKEND"] == "brave"


def test_custom_web_search_uses_global_env_when_no_per_env_config():
    """With no per-env Tool Setting, the global config (env var) drives the
    custom web_search backend."""
    from tools.custom import web_search_tools

    captured = {}

    class _FakeBackend:
        async def search(self, query, max_results, region, safesearch):
            return [{"rank": 1, "title": "T", "url": "u", "snippet": "s"}]

    def _fake_build(name, ctx, **kw):
        captured["backend"] = name
        return _FakeBackend()

    with patch.dict(os.environ, {"GENY_WEBSEARCH_BACKEND": "tavily"}, clear=False), patch(
        "geny_executor.tools.built_in._web_search_backends.build_backend", _fake_build
    ):
        out = web_search_tools.WebSearchTool().run(query="hi", web_search_config=None)
    assert captured["backend"] == "tavily"
    assert '"backend": "tavily"' in out


def test_per_env_config_overrides_global():
    """An explicit per-env web_search_config wins over the global env var."""
    from tools.custom import web_search_tools

    captured = {}

    class _FakeBackend:
        async def search(self, *a):
            return []

    def _fake_build(name, ctx, **kw):
        captured["backend"] = name
        return _FakeBackend()

    with patch.dict(os.environ, {"GENY_WEBSEARCH_BACKEND": "tavily"}, clear=False), patch(
        "geny_executor.tools.built_in._web_search_backends.build_backend", _fake_build
    ):
        web_search_tools.WebSearchTool().run(
            query="hi", web_search_config={"backend": "brave", "brave_api_key": "k"}
        )
    assert captured["backend"] == "brave"  # per-env overrides global


def test_controller_exposes_tools_category():
    import controller.config_controller as cc
    import inspect

    src = inspect.getsource(cc)
    assert '"tools"' in src and '"label": "Tool"' in src
