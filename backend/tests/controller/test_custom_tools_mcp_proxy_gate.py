"""Audit 2026-06-17 (C4) — mcp_proxy creation gate.

The mcp_proxy backend has no runtime dispatcher
(``service.mcp_loader.get_session_mcp_call_dispatcher`` was never
implemented), so any mcp_proxy tool errors on first call. The controller
now rejects creation/replace of the kind with a 400 before a dead tool
can be persisted. Other kinds (http / python_inline) are unaffected.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from controller.custom_tools_controller import (
    CustomToolPayload,
    _build_definition,
)


def _mcp_proxy_payload() -> CustomToolPayload:
    return CustomToolPayload(
        name="proxy_tool",
        description="re-export an upstream MCP tool",
        input_schema={"type": "object", "properties": {}, "required": []},
        backend_kind="mcp_proxy",
        config={
            "upstream_mcp_server": "some_server",
            "upstream_tool_name": "some_tool",
        },
    )


def _http_payload() -> CustomToolPayload:
    return CustomToolPayload(
        name="http_tool",
        description="call an external API",
        input_schema={"type": "object", "properties": {}, "required": []},
        backend_kind="http",
        config={"url_template": "https://example.com/api", "method": "POST"},
    )


def test_mcp_proxy_creation_rejected_with_400() -> None:
    with pytest.raises(HTTPException) as ei:
        _build_definition(_mcp_proxy_payload())
    assert ei.value.status_code == 400
    assert "mcp_proxy" in str(ei.value.detail)


def test_mcp_proxy_replace_rejected_with_400() -> None:
    # The same shared builder backs PUT (replace) — a stale mcp_proxy row
    # cannot be edited back into a "valid" tool either.
    with pytest.raises(HTTPException) as ei:
        _build_definition(_mcp_proxy_payload(), id_="existing-id")
    assert ei.value.status_code == 400


def test_http_tool_still_builds() -> None:
    # Regression guard: the gate must not block supported kinds.
    defn = _build_definition(_http_payload())
    assert defn.backend_kind == "http"
    assert defn.name == "http_tool"
