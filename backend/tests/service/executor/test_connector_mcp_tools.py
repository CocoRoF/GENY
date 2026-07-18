"""Connector local MCP → first-class tools (catalog sync + call relay).

Pins the name sanitizer, catalog→tool diffing against a live registry
(register/unregister + never touching foreign tools), the MCP CallToolResult
mapping (text / image / isError), and the offline error surfaces.
"""

from __future__ import annotations

import asyncio

import pytest

from geny_executor.tools.base import ToolContext
from service.executor import connector_mcp_tools as cmt
from service.executor.connector_mcp_tools import (
    ConnectorLocalMcpTool,
    _map_mcp_result,
    clear_session,
    sanitize_mcp_tool_name,
    sync_session,
)
from service.executor.connector_registry import (
    ConnectorConnection,
    get_connector_registry,
)


class FakeRegistry:
    """Duck-typed executor ToolRegistry: register/unregister/get + version."""

    def __init__(self):
        self.tools = {}
        self.version = 0

    def register(self, tool, *, core=True):
        self.tools[tool.name] = tool
        self.version += 1

    def unregister(self, name):
        if self.tools.pop(name, None) is not None:
            self.version += 1

    def get(self, name):
        return self.tools.get(name)


CATALOG = [
    {
        "name": "filesystem",
        "connected": True,
        "tools": [
            {"name": "read_file", "description": "Read a file", "inputSchema": {"type": "object"}},
            {"name": "write_file", "description": "Write", "annotations": {"readOnlyHint": False}},
        ],
    },
    {"name": "broken", "connected": False, "error": "spawn failed", "tools": []},
]


@pytest.fixture(autouse=True)
def _clean_state():
    cmt._registered.clear()
    yield
    cmt._registered.clear()


# ── naming ───────────────────────────────────────────────────────────

def test_sanitize_name():
    assert sanitize_mcp_tool_name("filesystem", "read_file") == "mcp_filesystem_read_file"
    assert sanitize_mcp_tool_name("my server!", "do.thing") == "mcp_my_server__do_thing"
    assert len(sanitize_mcp_tool_name("s" * 100, "t" * 100)) == 64


# ── catalog sync ─────────────────────────────────────────────────────

def test_sync_registers_only_connected_servers():
    reg = FakeRegistry()
    counts = sync_session("sess1", CATALOG, registry=reg)
    assert counts == {"registered": 2, "removed": 0, "skipped": 0}
    assert set(reg.tools) == {"mcp_filesystem_read_file", "mcp_filesystem_write_file"}


def test_sync_is_idempotent_and_diffs():
    reg = FakeRegistry()
    sync_session("sess1", CATALOG, registry=reg)
    v = reg.version
    assert sync_session("sess1", CATALOG, registry=reg)["registered"] == 0
    assert reg.version == v  # no churn on identical catalog

    smaller = [{"name": "filesystem", "connected": True, "tools": [CATALOG[0]["tools"][0]]}]
    counts = sync_session("sess1", smaller, registry=reg)
    assert counts["removed"] == 1
    assert set(reg.tools) == {"mcp_filesystem_read_file"}


def test_sync_never_touches_foreign_tools():
    reg = FakeRegistry()

    class Foreign:
        name = "Bash"

    reg.register(Foreign())
    sync_session("sess1", CATALOG, registry=reg)
    sync_session("sess1", [], registry=reg)  # connector reports empty catalog
    assert "Bash" in reg.tools and not any(n.startswith("mcp_") for n in reg.tools if n != "Bash")


def test_clear_session_unregisters_all(monkeypatch):
    reg = FakeRegistry()
    sync_session("sess1", CATALOG, registry=reg)
    monkeypatch.setattr(cmt, "_live_registry", lambda sid: reg)
    assert clear_session("sess1") == 2
    assert not any(n.startswith("mcp_") for n in reg.tools)
    assert clear_session("sess1") == 0  # idempotent


def test_sync_without_live_registry_is_noop():
    assert sync_session("nope", CATALOG)["skipped"] == 1


# ── tool posture ─────────────────────────────────────────────────────

def test_read_only_hint_respected():
    ro = ConnectorLocalMcpTool(
        server="s", tool="t", description="d",
        input_schema=None, annotations={"readOnlyHint": True},
    )
    rw = ConnectorLocalMcpTool(server="s", tool="t2", description="d", input_schema=None)
    assert ro.capabilities({}).read_only is True and ro.capabilities({}).destructive is False
    assert rw.capabilities({}).read_only is False and rw.capabilities({}).destructive is True


# ── result mapping ───────────────────────────────────────────────────

def test_map_text_result():
    r = _map_mcp_result({"content": [{"type": "text", "text": "hello"}, {"type": "text", "text": "world"}]})
    assert r.content == "hello\nworld" and not r.is_error


def test_map_error_result():
    r = _map_mcp_result({"content": [{"type": "text", "text": "boom"}], "isError": True})
    assert r.is_error and r.content == "boom"


def test_map_image_result_uses_canonical_blocks():
    r = _map_mcp_result({"content": [
        {"type": "text", "text": "shot"},
        {"type": "image", "data": "AAAA", "mimeType": "image/png"},
    ]})
    assert isinstance(r.content, list)
    img = [b for b in r.content if b.get("type") == "image"][0]
    assert img["source"] == {"type": "base64", "media_type": "image/png", "data": "AAAA"}


def test_map_non_dict_result():
    assert _map_mcp_result("plain").content == "plain"
    assert _map_mcp_result({"no": "content"}).content == '{"no": "content"}'


# ── call relay ───────────────────────────────────────────────────────

class FakeWs:
    def __init__(self):
        self.sent = []

    async def send_json(self, frame):
        self.sent.append(frame)


def test_execute_relays_via_mcp_call_capability():
    async def main():
        ws = FakeWs()
        conn = ConnectorConnection(ws, ["mcp_call", "mcp_list"])
        get_connector_registry().register("sessX", conn)
        try:
            tool = ConnectorLocalMcpTool(server="fs", tool="read_file", description="", input_schema=None)
            task = asyncio.ensure_future(
                tool.execute({"path": "/tmp/x"}, ToolContext(session_id="sessX", storage_path="/tmp"))
            )
            await asyncio.sleep(0.01)
            frame = ws.sent[0]
            assert frame["type"] == "capability_call"
            data = frame["data"]
            assert data["tool"] == "mcp_call"
            assert data["args"] == {"server": "fs", "tool": "read_file", "args": {"path": "/tmp/x"}}
            conn.resolve_result(data["request_id"], {
                "request_id": data["request_id"], "ok": True,
                "result": {"content": [{"type": "text", "text": "file body"}]},
            })
            res = await task
            assert not res.is_error and res.content == "file body"
        finally:
            get_connector_registry().unregister("sessX")
    asyncio.run(main())


def test_execute_offline_is_clean_error():
    async def main():
        tool = ConnectorLocalMcpTool(server="fs", tool="read_file", description="", input_schema=None)
        res = await tool.execute({}, ToolContext(session_id="no-conn", storage_path="/tmp"))
        assert res.is_error and "offline" in res.content
    asyncio.run(main())
