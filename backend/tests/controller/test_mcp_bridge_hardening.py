"""Regression tests for PR #1 (Phase A2) — MCP wrap hardening.

Covers the ten weaknesses identified in
``dev_docs/20260525_1/analysis/A1_mcp_wrap_prod_diagnosis.md``:

  W1  schema hides host-injected ``session_id``
  W4  ``{"error": ...}`` envelope is promoted to ``isError=True``
  W4b ``ToolError`` raises also map to ``isError=True`` with clean text
  W5  unexpected exceptions surface sanitised text (no class/module names)
  W8  ``resources/list`` / ``prompts/list`` / ``logging/setLevel`` /
      ``completion/complete`` / ``ping`` return well-formed empty
      responses instead of method-not-found
  W9  ``initialize`` advertises the *server's* protocolVersion regardless
      of what the client requested
  W10 generated schemas carry ``additionalProperties: False``
  +   host-injected names smuggled in by a hallucinated LLM are dropped

The tests run against a stub agent registered directly on the manager,
so no LLM, no subprocess, no DB writes.
"""

from __future__ import annotations

import json
from typing import Any, Dict

import pytest

from tools.base import BaseTool, INJECTED_PARAM_NAMES, ToolError


# ── Stub tools ─────────────────────────────────────────────────────


class _EchoTool(BaseTool):
    """Returns its kwargs as JSON. Used to observe what the adapter
    actually dispatches into ``run``."""

    name = "echo_tool"
    description = "Returns kwargs as JSON."

    def run(self, session_id: str, payload: str = "") -> str:  # noqa: D401
        return json.dumps(
            {"session_id": session_id, "payload": payload},
            ensure_ascii=False,
        )


class _LegacyErrEnvelopeTool(BaseTool):
    """Returns a legacy ``{"error": ...}`` JSON-string failure."""

    name = "legacy_err_tool"
    description = "Returns a legacy error envelope."

    def run(self, session_id: str) -> str:  # noqa: D401
        return json.dumps({"error": "config disabled — try later"})


class _RaisesToolErrorTool(BaseTool):
    """Raises :class:`ToolError` with a user-safe message."""

    name = "tool_error_tool"
    description = "Raises ToolError."

    def run(self, session_id: str) -> str:  # noqa: D401
        raise ToolError("nope: external system says no")


class _BoomTool(BaseTool):
    """Raises an unexpected exception with a Python-style message
    (the kind we want to sanitise before showing it to the LLM)."""

    name = "boom_tool"
    description = "Boom."

    def run(self, session_id: str) -> str:  # noqa: D401
        raise TypeError(
            "BoomTool.run() got an unexpected keyword argument 'whatever'"
        )


# ── Fixtures ───────────────────────────────────────────────────────


@pytest.fixture()
def stub_session(monkeypatch):
    """Register a fake session + tool roster on the live manager so the
    MCP bridge controller can exercise dispatch end-to-end."""
    from service.executor.agent_session_manager import get_agent_session_manager

    mgr = get_agent_session_manager()

    # ── stub agent ──
    class _FakeAgent:
        pass

    sid = "test-mcp-hardening-sid"
    fake = _FakeAgent()
    fake._mcp_bridge_token = "STUB_TOKEN"  # type: ignore[attr-defined]
    prior = mgr._local_agents.get(sid)
    mgr._local_agents[sid] = fake  # type: ignore[index]

    # ── stub tool loader ──
    class _StubLoader:
        def __init__(self):
            self._tools = {
                t.name: t
                for t in (
                    _EchoTool(),
                    _LegacyErrEnvelopeTool(),
                    _RaisesToolErrorTool(),
                    _BoomTool(),
                )
            }

        def get_all_names(self):
            return list(self._tools.keys())

        def get_tool(self, name):
            return self._tools.get(name)

    prior_loader = mgr._tool_loader
    mgr._tool_loader = _StubLoader()  # type: ignore[assignment]

    yield sid

    # cleanup
    if prior is None:
        mgr._local_agents.pop(sid, None)
    else:
        mgr._local_agents[sid] = prior
    mgr._tool_loader = prior_loader  # type: ignore[assignment]


# ── W10 + schema hygiene ───────────────────────────────────────────


def test_w10_schema_has_additional_properties_false():
    tool = _EchoTool()
    schema = tool.parameters
    assert schema["additionalProperties"] is False


def test_w1_schema_hides_injected_session_id():
    tool = _EchoTool()
    schema = tool.parameters
    assert "session_id" in INJECTED_PARAM_NAMES
    assert "session_id" not in schema["properties"]
    assert "session_id" not in schema["required"]
    # Non-injected param still present.
    assert "payload" in schema["properties"]


def test_w1_decorator_path_also_hides_injected_params():
    from tools.base import tool as tool_decorator

    @tool_decorator
    def msg_tool(session_id: str, msg: str) -> str:
        """Send a message."""
        return f"{session_id}: {msg}"

    schema = msg_tool.parameters
    assert "session_id" not in schema["properties"]
    assert "msg" in schema["properties"]
    assert schema["additionalProperties"] is False


# ── W1 dispatch: injected param overwrites LLM-supplied value ──────


@pytest.mark.asyncio
async def test_w1_session_id_overwrites_llm_hallucination(stub_session):
    from controller.mcp_bridge_controller import _execute_tool

    sid = stub_session
    res = await _execute_tool(
        sid,
        "echo_tool",
        {"session_id": "FAKE-HALLUCINATED-ID", "payload": "hi"},
    )
    assert res["isError"] is False
    body = json.loads(res["content"][0]["text"])
    # Adapter dropped the LLM's value and injected the real session_id.
    assert body["session_id"] == sid
    assert body["payload"] == "hi"


# ── W4 + W4b error envelope ────────────────────────────────────────


@pytest.mark.asyncio
async def test_w4_legacy_error_envelope_promotes_to_iserror(stub_session):
    from controller.mcp_bridge_controller import _execute_tool

    res = await _execute_tool(stub_session, "legacy_err_tool", {})
    assert res["isError"] is True
    # Body text is unchanged — only the envelope flag flipped — so any
    # downstream logger that grepped the message keeps working.
    assert "config disabled" in res["content"][0]["text"]


@pytest.mark.asyncio
async def test_w4b_tool_error_yields_iserror_with_clean_text(stub_session):
    from controller.mcp_bridge_controller import _execute_tool

    res = await _execute_tool(stub_session, "tool_error_tool", {})
    assert res["isError"] is True
    text = res["content"][0]["text"]
    assert text == "nope: external system says no"
    # No class name, no module path.
    assert "ToolError" not in text
    assert "tool_error_tool" not in text


# ── W5 traceback sanitisation ──────────────────────────────────────


@pytest.mark.asyncio
async def test_w5_unexpected_exception_is_sanitised(stub_session):
    from controller.mcp_bridge_controller import _execute_tool

    res = await _execute_tool(stub_session, "boom_tool", {})
    assert res["isError"] is True
    text = res["content"][0]["text"]
    # No class name (BoomTool), no method (.run()), no Python noise.
    assert "BoomTool" not in text
    assert ".run()" not in text
    # We *do* keep the tool name (registry handle) — the LLM may need
    # it to pick a different tool or retry.
    assert "boom_tool" in text


# ── W8 unknown-method probes ───────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method,expected_key",
    [
        ("resources/list", "resources"),
        ("resources/templates/list", "resourceTemplates"),
        ("prompts/list", "prompts"),
    ],
)
async def test_w8_probe_returns_empty_array(stub_session, method, expected_key):
    from controller.mcp_bridge_controller import mcp_rpc, JsonRpcRequest

    r = await mcp_rpc(
        JsonRpcRequest(method=method, id=1), session_id=stub_session,
    )
    assert r.error is None
    assert r.result == {expected_key: []}


@pytest.mark.asyncio
async def test_w8_logging_setlevel_is_accepted(stub_session):
    from controller.mcp_bridge_controller import mcp_rpc, JsonRpcRequest

    r = await mcp_rpc(
        JsonRpcRequest(method="logging/setLevel", id=1, params={"level": "info"}),
        session_id=stub_session,
    )
    assert r.error is None
    assert r.result == {}


@pytest.mark.asyncio
async def test_w8_completion_returns_empty_envelope(stub_session):
    from controller.mcp_bridge_controller import mcp_rpc, JsonRpcRequest

    r = await mcp_rpc(
        JsonRpcRequest(method="completion/complete", id=1), session_id=stub_session,
    )
    assert r.error is None
    assert r.result["completion"]["values"] == []


@pytest.mark.asyncio
async def test_w8_ping_returns_empty_object(stub_session):
    from controller.mcp_bridge_controller import mcp_rpc, JsonRpcRequest

    r = await mcp_rpc(
        JsonRpcRequest(method="ping", id=1), session_id=stub_session,
    )
    assert r.error is None
    assert r.result == {}


# ── W9 protocolVersion advertise ───────────────────────────────────


@pytest.mark.asyncio
async def test_w9_initialize_ignores_client_protocol_version(stub_session):
    from controller.mcp_bridge_controller import (
        mcp_rpc,
        JsonRpcRequest,
        _PROTOCOL_VERSION,
    )

    r = await mcp_rpc(
        JsonRpcRequest(
            method="initialize",
            id=1,
            params={"protocolVersion": "2099-99-99-LIES", "capabilities": {}},
        ),
        session_id=stub_session,
    )
    assert r.error is None
    # Server advertises *its* version regardless of client request.
    assert r.result["protocolVersion"] == _PROTOCOL_VERSION
    # Capabilities now include the surfaces we explicitly answer on.
    caps = r.result["capabilities"]
    assert "tools" in caps
    assert "resources" in caps
    assert "prompts" in caps


# ── unknown methods still surface as method-not-found ──────────────


@pytest.mark.asyncio
async def test_unknown_method_still_returns_method_not_found(stub_session):
    from controller.mcp_bridge_controller import mcp_rpc, JsonRpcRequest

    r = await mcp_rpc(
        JsonRpcRequest(method="not/a/real/method", id=1),
        session_id=stub_session,
    )
    assert r.error is not None
    assert r.error["code"] == -32601


# ── Fallback path: no live registry → advertise the full loader roster ─


@pytest.mark.asyncio
async def test_w2_list_session_tools_fallback_advertises_loader(stub_session):
    # The stub agent has no ``_pipeline`` → no live registry, so the bridge
    # falls back to the global loader and advertises every loader tool.
    from controller.mcp_bridge_controller import _list_session_tools

    tools = await _list_session_tools(stub_session)
    names = [t["name"] for t in tools]
    assert {"echo_tool", "legacy_err_tool", "tool_error_tool", "boom_tool"}.issubset(
        set(names)
    )
    # Every advertised schema carries the new hardening defaults.
    for t in tools:
        s = t["inputSchema"]
        assert s["additionalProperties"] is False
        assert "session_id" not in s["properties"]


# ── Live registry: advertise the EXPOSED (core + activated) set only ───


@pytest.mark.asyncio
async def test_list_session_tools_advertises_exposed_only_with_live_registry(monkeypatch):
    """With a live pipeline registry, the bridge mirrors the SDK path: only
    core/activated tools are advertised; deferred tools stay hidden (reachable
    via ToolSearch), keeping the claude_code_cli tool surface small."""
    from controller.mcp_bridge_controller import _list_session_tools
    from service.executor.agent_session_manager import get_agent_session_manager
    from geny_executor.tools.registry import ToolRegistry

    reg = ToolRegistry()
    reg.register(_EchoTool(), core=True)       # exposed
    reg.register(_BoomTool(), core=False)      # deferred
    reg.register(_LegacyErrEnvelopeTool(), core=False)  # deferred
    reg.activate("boom_tool")                  # runtime-activated → exposed

    class _FakePipeline:
        _tool_registry = reg
        environment = None

    class _FakeAgent:
        _pipeline = _FakePipeline()
        _mcp_bridge_token = "STUB_TOKEN"

    mgr = get_agent_session_manager()
    sid = "test-exposed-only-sid"
    prior = mgr._local_agents.get(sid)
    mgr._local_agents[sid] = _FakeAgent()  # type: ignore[index]
    try:
        tools = await _list_session_tools(sid)
        names = {t["name"] for t in tools}
        assert "echo_tool" in names            # core → advertised
        assert "boom_tool" in names            # activated → advertised
        assert "legacy_err_tool" not in names  # deferred → hidden
    finally:
        if prior is None:
            mgr._local_agents.pop(sid, None)
        else:
            mgr._local_agents[sid] = prior
