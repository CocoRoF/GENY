"""Tests for the 2.2.0 events-tap bridge in ``service.executor.agent_session``.

Replaces ``tests/service/test_llm_patches.py``: geny-executor 2.2.0
publishes CLI-handled tool calls and structured error envelopes as
first-class pipeline events (``api.cli_tool_call`` / ``api.tool_result``
/ ``api.error``), so the ``StreamJsonAccumulator.feed`` monkey-patch and
its contextvar plumbing were deleted. These tests drive the bridge
helper directly with synthetic event payloads (the documented shapes
from ``geny_executor.events.catalog.PAYLOADS``) and assert the same
SessionLogger calls the old patch produced.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from service.executor.agent_session import (
    _AUTH_EXPIRED_MESSAGE,
    _bridge_cli_stream_event,
    _friendly_api_error_message,
    _tool_result_text,
)


class _FakeSessionLogger:
    """Records log_tool_use / log_tool_result / log calls."""

    def __init__(self) -> None:
        self.tool_uses: List[Dict[str, Any]] = []
        self.tool_results: List[Dict[str, Any]] = []
        self.logs: List[Dict[str, Any]] = []

    def log_tool_use(
        self,
        tool_name: str,
        tool_input: Optional[Dict[str, Any]] = None,
        tool_id: Optional[str] = None,
    ) -> None:
        self.tool_uses.append(
            {"tool_name": tool_name, "tool_input": tool_input, "tool_id": tool_id}
        )

    def log_tool_result(
        self,
        tool_name: str,
        tool_id: Optional[str] = None,
        result: Optional[str] = None,
        is_error: bool = False,
        duration_ms: Optional[int] = None,
    ) -> None:
        self.tool_results.append(
            {
                "tool_name": tool_name,
                "tool_id": tool_id,
                "result": result,
                "is_error": is_error,
                "duration_ms": duration_ms,
            }
        )

    def log(self, level: Any = None, message: str = "", metadata: Optional[Dict] = None) -> None:
        self.logs.append({"level": level, "message": message, "metadata": metadata or {}})


def _pending() -> Dict[str, Tuple[str, float]]:
    return {}


# ── api.cli_tool_call → log_tool_use ─────────────────────────────────


def test_cli_tool_call_emits_tool_use() -> None:
    sl = _FakeSessionLogger()
    pending = _pending()
    _bridge_cli_stream_event(
        sl,
        "api.cli_tool_call",
        {"id": "toolu_1", "name": "Bash", "input": {"command": "ls"}, "source": "cli"},
        pending,
    )
    assert sl.tool_uses == [
        {"tool_name": "Bash", "tool_input": {"command": "ls"}, "tool_id": "toolu_1"}
    ]
    assert "toolu_1" in pending


def test_cli_tool_call_skips_mcp_prefixed_tools() -> None:
    """MCP tools are logged by the bridge controller — double-logging
    would render them twice in the UI (same rule the old patch had)."""
    sl = _FakeSessionLogger()
    pending = _pending()
    _bridge_cli_stream_event(
        sl,
        "api.cli_tool_call",
        {"id": "toolu_2", "name": "mcp__geny__memory_read", "input": {}, "source": "cli"},
        pending,
    )
    assert sl.tool_uses == []
    assert pending == {}


def test_cli_tool_call_duplicate_id_logged_once() -> None:
    sl = _FakeSessionLogger()
    pending = _pending()
    payload = {"id": "toolu_3", "name": "Read", "input": {"file_path": "/a"}, "source": "cli"}
    _bridge_cli_stream_event(sl, "api.cli_tool_call", payload, pending)
    _bridge_cli_stream_event(sl, "api.cli_tool_call", payload, pending)
    assert len(sl.tool_uses) == 1


# ── api.tool_result → log_tool_result ────────────────────────────────


def test_tool_result_emits_with_duration() -> None:
    sl = _FakeSessionLogger()
    pending = _pending()
    _bridge_cli_stream_event(
        sl,
        "api.cli_tool_call",
        {"id": "toolu_4", "name": "Bash", "input": {"command": "true"}, "source": "cli"},
        pending,
    )
    _bridge_cli_stream_event(
        sl,
        "api.tool_result",
        {"tool_use_id": "toolu_4", "content": "ok", "is_error": False, "source": "cli"},
        pending,
    )
    assert len(sl.tool_results) == 1
    entry = sl.tool_results[0]
    assert entry["tool_name"] == "Bash"
    assert entry["tool_id"] == "toolu_4"
    assert entry["result"] == "ok"
    assert entry["is_error"] is False
    assert isinstance(entry["duration_ms"], int) and entry["duration_ms"] >= 0
    assert pending == {}, "pending entry must be consumed"


def test_tool_result_handles_content_block_list_shape() -> None:
    sl = _FakeSessionLogger()
    pending = _pending()
    _bridge_cli_stream_event(
        sl,
        "api.cli_tool_call",
        {"id": "toolu_5", "name": "Read", "input": {"file_path": "/a"}, "source": "cli"},
        pending,
    )
    _bridge_cli_stream_event(
        sl,
        "api.tool_result",
        {
            "tool_use_id": "toolu_5",
            "content": [
                {"type": "text", "text": "line one"},
                {"type": "text", "text": "line two"},
            ],
            "is_error": False,
            "source": "cli",
        },
        pending,
    )
    assert sl.tool_results[0]["result"] == "line one\nline two"


def test_tool_result_ignores_api_source() -> None:
    """Stage-10 dispatch already logs api-source results through
    tool.call_start / tool.call_complete — the bridge must not double."""
    sl = _FakeSessionLogger()
    pending = _pending()
    _bridge_cli_stream_event(
        sl,
        "api.tool_result",
        {"tool_use_id": "toolu_6", "content": "x", "is_error": False, "source": "api"},
        pending,
    )
    assert sl.tool_results == []


def test_tool_result_without_matching_call_is_ignored() -> None:
    sl = _FakeSessionLogger()
    _bridge_cli_stream_event(
        sl,
        "api.tool_result",
        {"tool_use_id": "toolu_unseen", "content": "x", "is_error": False, "source": "cli"},
        _pending(),
    )
    assert sl.tool_results == []


# ── api.error → friendly Korean error log ────────────────────────────


def test_api_error_auth_code_logs_korean_message() -> None:
    sl = _FakeSessionLogger()
    _bridge_cli_stream_event(
        sl,
        "api.error",
        {
            "code": "exec.cli.auth_failed",
            "category": "cli_auth_failed",
            "provider": "claude_code_cli",
            "message": "Failed to authenticate. API Error: 401",
        },
        _pending(),
    )
    assert len(sl.logs) == 1
    assert _AUTH_EXPIRED_MESSAGE in sl.logs[0]["message"]
    assert "401" in sl.logs[0]["message"], "original message preserved as suffix"
    assert sl.logs[0]["metadata"]["error_code"] == "exec.cli.auth_failed"


def test_api_error_generic_includes_code_and_message() -> None:
    sl = _FakeSessionLogger()
    _bridge_cli_stream_event(
        sl,
        "api.error",
        {
            "code": "exec.api.rate_limited",
            "category": "rate_limited",
            "provider": "anthropic",
            "message": "429 too many requests",
        },
        _pending(),
    )
    assert len(sl.logs) == 1
    msg = sl.logs[0]["message"]
    assert "exec.api.rate_limited" in msg
    assert "429 too many requests" in msg


def test_friendly_message_auth_category_without_code() -> None:
    msg = _friendly_api_error_message({"category": "auth", "message": "expired"})
    assert msg.startswith(_AUTH_EXPIRED_MESSAGE)


def test_bridge_never_raises_on_logger_failure() -> None:
    class _Boom:
        def log_tool_use(self, **kwargs: Any) -> None:
            raise RuntimeError("boom")

    _bridge_cli_stream_event(
        _Boom(),
        "api.cli_tool_call",
        {"id": "t", "name": "Bash", "input": {}, "source": "cli"},
        _pending(),
    )  # must not raise


# ── result-text normalisation ────────────────────────────────────────


def test_tool_result_text_shapes() -> None:
    assert _tool_result_text(None) is None
    assert _tool_result_text("plain") == "plain"
    assert _tool_result_text([{"type": "text", "text": "a"}, "b"]) == "a\nb"
    assert _tool_result_text({"k": 1}) == '{"k": 1}'
