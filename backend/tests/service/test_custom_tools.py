"""Phase B / PR #2 — Custom Tools backend tests.

Covers the model + adapter layer end-to-end without spinning up the
full FastAPI stack:

  * Pydantic validators (schema hygiene, kind/config matching).
  * HTTP adapter — template interpolation, response handling,
    upstream error → ToolError mapping.
  * MCP-proxy adapter — schema hygiene, dispatcher dispatch.
  * Builtin-alias adapter — overlay on top of an existing BaseTool
    subclass.
  * ``build_adapter`` factory routing.

The CRUD-controller side is exercised separately in
``tests/controller/test_custom_tools_controller.py``.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx
import pytest

from tools.base import BaseTool, INJECTED_PARAM_NAMES, ToolError
from service.custom_tools.models import (
    BuiltinAliasConfig,
    CustomToolDefinition,
    HttpToolConfig,
    McpProxyConfig,
    ToolCapabilities,
)
from service.custom_tools.adapters import (
    BuiltinAliasAdapter,
    HttpToolAdapter,
    McpProxyAdapter,
    _hygiene,
    _interpolate,
    build_adapter,
)


# ── Schema hygiene ───────────────────────────────────────────────


def test_hygiene_enforces_invariants():
    schema = {
        "type": "object",
        "properties": {
            "session_id": {"type": "string"},  # must be stripped
            "query": {"type": "string"},
        },
        "required": ["session_id", "query"],
    }
    out = _hygiene(schema)
    assert out["additionalProperties"] is False
    assert "session_id" not in out["properties"]
    assert "session_id" not in out["required"]
    assert "query" in out["properties"]


def test_definition_writer_enforces_schema_hygiene():
    """The model_validator on CustomToolDefinition must scrub injected
    params even if the caller hand-rolls a leaky schema."""
    defn = CustomToolDefinition(
        name="my_tool",
        description="x",
        input_schema={
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "q": {"type": "string"},
            },
            "required": ["session_id", "q"],
        },
        backend_kind="http",
        config=HttpToolConfig(
            method="GET",
            url_template="https://example.com",
            headers={},
        ),
    )
    assert "session_id" not in defn.input_schema["properties"]
    assert defn.input_schema["additionalProperties"] is False


def test_kind_config_mismatch_rejected():
    with pytest.raises(Exception):
        CustomToolDefinition(
            name="bad",
            description="x",
            backend_kind="http",
            config=McpProxyConfig(
                upstream_mcp_server="srv", upstream_tool_name="t",
            ),
        )


# ── Placeholder interpolation ────────────────────────────────────


def test_interpolate_arg(monkeypatch):
    out = _interpolate(
        "GET /items/${arg:id}?token=${secret:DOES_NOT_EXIST}",
        args={"id": "abc-123"},
        session_id=None,
    )
    # Missing secret resolves to empty string (intentionally silent —
    # leaking the key name would be worse than failing the upstream
    # auth check).
    assert out == "GET /items/abc-123?token="


def test_interpolate_secret(monkeypatch):
    monkeypatch.setenv("CUSTOM_TOOL_FAKE", "shh")
    out = _interpolate(
        "Bearer ${secret:CUSTOM_TOOL_FAKE}",
        args={},
        session_id=None,
    )
    assert out == "Bearer shh"


def test_interpolate_session_id():
    out = _interpolate(
        "${session:session_id}",
        args={},
        session_id="real-sid-42",
    )
    assert out == "real-sid-42"


def test_interpolate_missing_arg_raises_tool_error():
    with pytest.raises(ToolError) as exc:
        _interpolate(
            "${arg:missing}",
            args={},
            session_id=None,
        )
    assert "missing" in str(exc.value)


# ── HTTP adapter ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_http_adapter_get_returns_json(monkeypatch):
    captured: Dict[str, Any] = {}

    async def fake_request(self, method, url, **kw):  # type: ignore[no-untyped-def]
        captured["method"] = method
        captured["url"] = url
        captured["headers"] = dict(kw.get("headers") or {})
        return httpx.Response(200, json={"items": [1, 2, 3]})

    monkeypatch.setattr("httpx.AsyncClient.request", fake_request)

    defn = CustomToolDefinition(
        name="list_items",
        description="x",
        input_schema={
            "type": "object",
            "properties": {"category": {"type": "string"}},
            "required": ["category"],
        },
        backend_kind="http",
        config=HttpToolConfig(
            method="GET",
            url_template="https://api.example.com/items/${arg:category}",
            headers={"Authorization": "Bearer ${secret:FAKE_NOT_SET}"},
        ),
    )
    adapter = HttpToolAdapter(defn)
    result = await adapter.arun(category="books")
    assert captured["url"] == "https://api.example.com/items/books"
    # Secret missing → empty string interpolation; header still sent.
    assert captured["headers"]["Authorization"] == "Bearer "
    assert json.loads(result) == {"items": [1, 2, 3]}


@pytest.mark.asyncio
async def test_http_adapter_4xx_raises_tool_error(monkeypatch):
    async def fake_request(self, method, url, **kw):  # type: ignore[no-untyped-def]
        return httpx.Response(403, text="forbidden")

    monkeypatch.setattr("httpx.AsyncClient.request", fake_request)

    defn = CustomToolDefinition(
        name="forbid_tool",
        description="x",
        input_schema={"type": "object", "properties": {}, "required": []},
        backend_kind="http",
        config=HttpToolConfig(
            method="GET",
            url_template="https://api.example.com/x",
            headers={},
        ),
    )
    adapter = HttpToolAdapter(defn)
    with pytest.raises(ToolError) as exc:
        await adapter.arun()
    assert "HTTP 403" in str(exc.value)


@pytest.mark.asyncio
async def test_http_adapter_truncates_oversized_response(monkeypatch):
    big = "x" * 20_000

    async def fake_request(self, method, url, **kw):  # type: ignore[no-untyped-def]
        return httpx.Response(200, text=big)

    monkeypatch.setattr("httpx.AsyncClient.request", fake_request)

    defn = CustomToolDefinition(
        name="big_tool",
        description="x",
        input_schema={"type": "object", "properties": {}, "required": []},
        backend_kind="http",
        config=HttpToolConfig(
            method="GET", url_template="https://x.test/", headers={},
            response_handler="text",
        ),
        capabilities=ToolCapabilities(max_result_chars=500),
    )
    adapter = HttpToolAdapter(defn)
    out = await adapter.arun()
    assert "truncated at 500 chars" in out
    assert len(out) < 600


# ── Builtin alias adapter ────────────────────────────────────────


class _UnderlyingEcho(BaseTool):
    name = "underlying_echo"
    description = "echoes back"

    def run(self, session_id: str, msg: str = "hi") -> str:  # noqa: D401
        return f"{session_id}:{msg}"


@pytest.mark.asyncio
async def test_builtin_alias_uses_underlying_dispatch():
    underlying = _UnderlyingEcho()
    defn = CustomToolDefinition(
        name="aliased_echo",
        description="aliased",
        input_schema=underlying.parameters,
        backend_kind="builtin_alias",
        config=BuiltinAliasConfig(
            source_module="this_test_module",
            source_class="_UnderlyingEcho",
            description_override="aliased description!",
        ),
    )
    adapter = BuiltinAliasAdapter(defn, underlying)
    assert adapter.name == "aliased_echo"
    assert adapter.description == "aliased description!"
    out = await adapter.arun(session_id="sid-xyz", msg="boo")
    assert out == "sid-xyz:boo"


def test_build_adapter_routes_by_kind():
    defn_http = CustomToolDefinition(
        name="h", description="x",
        backend_kind="http",
        config=HttpToolConfig(method="GET", url_template="https://x.test/", headers={}),
    )
    assert isinstance(build_adapter(defn_http), HttpToolAdapter)

    defn_mcp = CustomToolDefinition(
        name="m", description="x",
        backend_kind="mcp_proxy",
        config=McpProxyConfig(
            upstream_mcp_server="srv", upstream_tool_name="tool",
        ),
    )
    assert isinstance(build_adapter(defn_mcp), McpProxyAdapter)


def test_build_adapter_builtin_alias_requires_lookup():
    defn = CustomToolDefinition(
        name="alias",
        description="x",
        backend_kind="builtin_alias",
        config=BuiltinAliasConfig(
            source_module="dummy", source_class="DummyTool",
        ),
    )
    with pytest.raises(ValueError):
        build_adapter(defn)

    # With a matching lookup, resolves cleanly.
    class DummyTool(BaseTool):
        name = "dummy_underlying"
        description = "underlying"

        def run(self) -> str:
            return "ok"

    underlying = DummyTool()
    cfg = defn.config
    assert isinstance(cfg, BuiltinAliasConfig)
    # Patch the module stem to whatever Python set on the class.
    cfg.source_module = type(underlying).__module__.rsplit(".", 1)[-1]
    cfg.source_class = "DummyTool"
    adapter = build_adapter(defn, builtin_lookup={"dummy_underlying": underlying})
    assert isinstance(adapter, BuiltinAliasAdapter)


# ── Adapter is a real BaseTool (so ToolLoader registers it) ──────


def test_adapters_inherit_from_basetool():
    defn = CustomToolDefinition(
        name="x", description="x",
        backend_kind="http",
        config=HttpToolConfig(method="GET", url_template="https://x.test/", headers={}),
    )
    adapter = HttpToolAdapter(defn)
    assert isinstance(adapter, BaseTool)
    # Parameters carry the W1/W10 invariants.
    p = adapter.parameters
    assert p["additionalProperties"] is False
    assert "session_id" not in p.get("properties", {})


# ── Schema hygiene applies even to handcrafted leaks ─────────────


def test_hygiene_strips_handcrafted_session_id():
    schema = {
        "type": "object",
        "properties": {
            "session_id": {"type": "string"},
            "other": {"type": "string"},
        },
        "required": ["session_id"],
    }
    out = _hygiene(schema)
    assert "session_id" not in out["properties"]
    assert out["required"] == []
    # Ensure INJECTED_PARAM_NAMES is what we expect — pin contract.
    assert "session_id" in INJECTED_PARAM_NAMES
