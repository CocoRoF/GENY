"""Capability-bridge unit tests: ConnectorRegistry / ConnectorConnection /
ConnectorCapabilityTool — correlation, fail-closed, and tool error mapping."""

from __future__ import annotations

import asyncio

import pytest

from service.executor.connector_registry import ConnectorConnection, ConnectorRegistry, get_connector_registry
from service.executor.connector_bridge import ConnectorCapabilityTool, ConnectorToolProvider

from geny_executor.tools.base import ToolContext


class FakeWS:
    def __init__(self) -> None:
        self.sent: list = []

    async def send_json(self, obj):
        self.sent.append(obj)


def _ctx(session_id: str) -> ToolContext:
    return ToolContext(session_id=session_id)


@pytest.mark.asyncio
async def test_capability_call_resolves_by_request_id():
    ws = FakeWS()
    conn = ConnectorConnection(ws, ["ping"])

    async def call():
        return await conn.capability_call("ping", {}, "test", timeout=2.0)

    task = asyncio.create_task(call())
    await asyncio.sleep(0.01)
    # The send carries a request_id we resolve.
    rid = ws.sent[0]["data"]["request_id"]
    conn.resolve_result(rid, {"request_id": rid, "ok": True, "result": "pong"})
    out = await task
    assert out["ok"] is True and out["result"] == "pong"


@pytest.mark.asyncio
async def test_capability_call_times_out():
    conn = ConnectorConnection(FakeWS(), ["ping"])
    with pytest.raises(asyncio.TimeoutError):
        await conn.capability_call("ping", {}, "test", timeout=0.05)


@pytest.mark.asyncio
async def test_cancel_all_fails_pending():
    ws = FakeWS()
    conn = ConnectorConnection(ws, ["ping"])
    task = asyncio.create_task(conn.capability_call("ping", {}, "", timeout=2.0))
    await asyncio.sleep(0.01)
    conn.cancel_all("dropped")
    with pytest.raises(ConnectionError):
        await task


def test_registry_register_get_unregister():
    reg = ConnectorRegistry()
    c1 = ConnectorConnection(FakeWS(), [])
    reg.register("s1", c1)
    assert reg.get("s1") is c1 and reg.has("s1")
    # last-writer-wins cancels the old
    c2 = ConnectorConnection(FakeWS(), [])
    reg.register("s1", c2)
    assert reg.get("s1") is c2
    reg.unregister("s1", c2)
    assert not reg.has("s1")


def test_singleton_is_shared():
    assert get_connector_registry() is get_connector_registry()


@pytest.mark.asyncio
async def test_tool_offline_is_error():
    reg = get_connector_registry()
    reg.unregister("sX")  # ensure absent
    tool = ConnectorToolProvider().get("connector_ping")
    res = await tool.execute({}, _ctx("sX"))
    assert res.is_error and "offline" in str(res.content)


@pytest.mark.asyncio
async def test_tool_capability_unsupported_is_error():
    reg = get_connector_registry()
    reg.register("sCap", ConnectorConnection(FakeWS(), []))  # no 'ping' capability
    try:
        tool = ConnectorToolProvider().get("connector_ping")
        res = await tool.execute({}, _ctx("sCap"))
        assert res.is_error and "not supported" in str(res.content)
    finally:
        reg.unregister("sCap")


@pytest.mark.asyncio
async def test_tool_success_and_failure_mapping():
    reg = get_connector_registry()
    conn = ConnectorConnection(FakeWS(), ["ping"])
    reg.register("sOk", conn)
    tool = ConnectorToolProvider().get("connector_ping")
    try:
        # success
        ok_task = asyncio.create_task(tool.execute({}, _ctx("sOk")))
        await asyncio.sleep(0.01)
        rid = conn._pending and list(conn._pending.keys())[0]
        conn.resolve_result(rid, {"ok": True, "result": "pong"})
        ok = await ok_task
        assert not ok.is_error and "pong" in str(ok.content)
        # failure (ok:false)
        fail_task = asyncio.create_task(tool.execute({}, _ctx("sOk")))
        await asyncio.sleep(0.01)
        rid2 = list(conn._pending.keys())[0]
        conn.resolve_result(rid2, {"ok": False, "error": "boom"})
        fail = await fail_task
        assert fail.is_error and "boom" in str(fail.content)
    finally:
        reg.unregister("sOk")


def test_provider_lists_ping():
    assert "connector_ping" in ConnectorToolProvider().list_names()


# ── vscode_* tools route over the SAME bridge on vscode.* capabilities ──

from service.executor.vscode_bridge import VSCodeToolProvider


@pytest.mark.asyncio
async def test_vscode_tool_routes_capability_and_maps_result():
    """A vscode_* tool must send its vscode.* capability + args over the
    connector and map the connector's result back — same bridge, distinct
    capability vocabulary."""
    reg = get_connector_registry()
    conn = ConnectorConnection(FakeWS(), ["vscode.write_file"])
    reg.register("sVs", conn)
    tool = VSCodeToolProvider().get("vscode_write_file")
    try:
        task = asyncio.create_task(
            tool.execute({"path": "a.txt", "content": "hi"}, _ctx("sVs"))
        )
        await asyncio.sleep(0.01)
        # the frame carries the vscode.* capability string + the args verbatim
        sent = conn._ws.sent[0]["data"]
        assert sent["tool"] == "vscode.write_file"
        assert sent["args"] == {"path": "a.txt", "content": "hi"}
        rid = list(conn._pending.keys())[0]
        conn.resolve_result(rid, {"ok": True, "result": {"written": "a.txt"}})
        res = await task
        assert not res.is_error and "written" in str(res.content)
    finally:
        reg.unregister("sVs")


@pytest.mark.asyncio
async def test_vscode_tool_unsupported_capability_is_error():
    reg = get_connector_registry()
    reg.register("sVs2", ConnectorConnection(FakeWS(), ["ping"]))  # no vscode caps
    try:
        tool = VSCodeToolProvider().get("vscode_read_file")
        res = await tool.execute({"path": "x"}, _ctx("sVs2"))
        assert res.is_error and "not supported" in str(res.content)
    finally:
        reg.unregister("sVs2")


@pytest.mark.asyncio
async def test_vscode_tool_offline_is_error():
    get_connector_registry().unregister("sVs3")
    tool = VSCodeToolProvider().get("vscode_run_terminal")
    res = await tool.execute({"command": "echo hi"}, _ctx("sVs3"))
    assert res.is_error and "offline" in str(res.content)


# ── Phase 7: structured local control (browser CDP / app UIA / Office COM) ──


def test_provider_lists_structured_control_families():
    names = set(ConnectorToolProvider().list_names())
    browser = {"browser_tabs", "browser_open", "browser_snapshot", "browser_act",
               "browser_read", "browser_screenshot", "browser_eval", "browser_close"}
    winauto = {"app_windows", "app_snapshot", "app_act", "app_read",
               "office_status", "office_read", "office_act"}
    assert browser <= names and winauto <= names


def test_structured_tools_capability_equals_name():
    # The wire capability for each new tool IS its tool name — the frontend
    # dispatch tables (BROWSER_OPS / WINAUTO_OPS) key on these exact strings.
    provider = ConnectorToolProvider()
    for name in ["browser_tabs", "browser_open", "browser_snapshot", "browser_act",
                 "browser_read", "browser_screenshot", "browser_eval", "browser_close",
                 "app_windows", "app_snapshot", "app_act", "app_read",
                 "office_status", "office_read", "office_act"]:
        assert provider.get(name)._capability == name


@pytest.mark.asyncio
async def test_browser_act_routes_capability_and_maps_result():
    reg = get_connector_registry()
    conn = ConnectorConnection(FakeWS(), ["browser_act"])
    reg.register("sBr", conn)
    tool = ConnectorToolProvider().get("browser_act")
    try:
        task = asyncio.create_task(tool.execute({"action": "click", "element": "e3"}, _ctx("sBr")))
        await asyncio.sleep(0.01)
        rid = list(conn._pending.keys())[0]
        conn.resolve_result(rid, {"ok": True, "result": {"tab_id": "T1", "done": "clicked e3"}})
        out = await task
        assert not out.is_error and "clicked e3" in str(out.content)
    finally:
        reg.unregister("sBr")


@pytest.mark.asyncio
async def test_browser_tools_unsupported_on_old_connector():
    # A pre-0.17 connector never advertises browser_* → clean is_error, no send.
    reg = get_connector_registry()
    ws = FakeWS()
    reg.register("sOld", ConnectorConnection(ws, ["ping", "click", "type"]))
    try:
        tool = ConnectorToolProvider().get("browser_snapshot")
        res = await tool.execute({}, _ctx("sOld"))
        assert res.is_error and "not supported" in str(res.content)
        assert ws.sent == []
    finally:
        reg.unregister("sOld")


@pytest.mark.asyncio
async def test_office_act_denied_maps_to_denied_message():
    reg = get_connector_registry()
    conn = ConnectorConnection(FakeWS(), ["office_act"])
    reg.register("sOf", conn)
    tool = ConnectorToolProvider().get("office_act")
    try:
        task = asyncio.create_task(
            tool.execute({"app": "powerpoint", "action": "set_shape_text", "slide": 1, "shape": "2", "text": "hi"}, _ctx("sOf"))
        )
        await asyncio.sleep(0.01)
        rid = list(conn._pending.keys())[0]
        conn.resolve_result(rid, {"ok": False, "denied": True})
        out = await task
        assert out.is_error and "denied" in str(out.content)
    finally:
        reg.unregister("sOf")


@pytest.mark.asyncio
async def test_browser_screenshot_returns_image_blocks():
    reg = get_connector_registry()
    conn = ConnectorConnection(FakeWS(), ["browser_screenshot"])
    reg.register("sShot", conn)
    tool = ConnectorToolProvider().get("browser_screenshot")
    try:
        task = asyncio.create_task(tool.execute({}, _ctx("sShot")))
        await asyncio.sleep(0.01)
        rid = list(conn._pending.keys())[0]
        conn.resolve_result(rid, {"ok": True, "result": {
            "image_b64": "aGVsbG8=", "mime": "image/jpeg", "title": "Page", "url": "https://x.test"}})
        out = await task
        assert not out.is_error
        blocks = out.content
        assert isinstance(blocks, list) and blocks[1]["type"] == "image"
        assert blocks[1]["source"]["data"] == "aGVsbG8="
    finally:
        reg.unregister("sShot")
