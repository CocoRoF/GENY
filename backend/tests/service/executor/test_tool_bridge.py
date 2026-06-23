"""Regression tests for the unified Geny-tool dispatch (tools.base).

Geny tools are now real ``geny_executor.tools.base.Tool`` instances — the old
``_GenyToolAdapter`` is gone; ``BaseTool`` / ``ToolWrapper`` implement
``execute()`` directly via the shared dispatch in :mod:`tools.base`. These
tests pin the same contract the adapter used to guarantee:

- the signature probe (``_probe_param``) injects ``session_id`` iff the
  authoritative callable (func for ToolWrapper, run for BaseTool, arun
  fallback) accepts it — explicit or via ``**kwargs``;
- ``execute()`` overwrites LLM-supplied injected params with the trusted
  ``ToolContext``;
- ``execute()`` does not mutate the caller's input dict.

Plus a real-world smoke against ``SendDirectMessageExternalTool`` (the tool
that broke in production) with its session helpers monkey-patched.
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from geny_executor.tools.base import ToolContext
from tools.base import BaseTool, _probe_param, tool as tool_decorator


class _BaseToolNoSessionId(BaseTool):
    """Concrete ``run`` without ``session_id`` — the DM tool shape."""

    name = "no_session_tool"
    description = "does work without needing session_id"

    def run(self, target: str, content: str) -> str:
        return f"no-session:{target}:{content}"


class _BaseToolWithSessionId(BaseTool):
    """Concrete ``run`` declaring ``session_id`` — memory tool shape."""

    name = "needs_session_tool"
    description = "reads per-session state"

    def run(self, session_id: str, key: str) -> str:
        return f"with-session:{session_id}:{key}"


class _BaseToolVarKeyword(BaseTool):
    """Concrete ``run`` with ``**kwargs`` — catches anything."""

    name = "varkw_tool"
    description = "accepts arbitrary kwargs"

    def run(self, **kwargs: Any) -> str:
        return f"varkw:{sorted(kwargs.items())}"


@tool_decorator(name="fn_no_session", description="function without session_id")
def _fn_no_session(target: str, content: str) -> str:
    return f"fn-no-session:{target}:{content}"


@tool_decorator(name="fn_with_session", description="function with session_id")
def _fn_with_session(session_id: str, key: str) -> str:
    return f"fn-with-session:{session_id}:{key}"


class _DuckTypedAsyncOnly:
    """No ``run``, no ``func`` — only ``arun`` with explicit session_id.
    Exercises the fallback probe branch."""

    name = "duck_async_only"
    description = "async-only duck-typed tool"
    parameters = {"type": "object", "properties": {"session_id": {"type": "string"}}}

    async def arun(self, session_id: str = "") -> str:
        return f"duck:{session_id}"


class _UnreadableSignature:
    """Tool whose `run`/`arun` have no introspectable signature."""

    name = "unreadable_tool"
    description = "has an uninspectable signature"
    parameters = {"type": "object", "properties": {}}


def _ctx(session_id: str = "sess-xyz") -> ToolContext:
    return ToolContext(session_id=session_id)


# ─────────────────────────────────────────────────────────────────
# Probe matrix — _probe_param(session_id)
# ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "tool_factory, expected",
    [
        (_BaseToolNoSessionId, False),
        (_BaseToolWithSessionId, True),
        (_BaseToolVarKeyword, True),
        (lambda: _fn_no_session, False),
        (lambda: _fn_with_session, True),
        (_DuckTypedAsyncOnly, True),
    ],
)
def test_probe_matches_concrete_signature(tool_factory, expected) -> None:
    """The probe returns True iff the *authoritative* callable (func for
    ToolWrapper, run for BaseTool subclass, arun fallback) accepts
    session_id — explicit or via **kwargs."""
    tool = tool_factory()
    got = _probe_param(tool, "session_id", kwargs_counts=True)
    assert got is expected, (
        f"probe returned {got} for {type(tool).__name__}; expected {expected}"
    )


def test_probe_explicit_only_for_web_search_config() -> None:
    """``web_search_config`` only injects when EXPLICITLY named — a bare
    ``**kwargs`` must NOT count (kwargs_counts=False)."""
    assert _probe_param(_BaseToolVarKeyword(), "web_search_config", kwargs_counts=False) is False

    @tool_decorator(name="ws", description="x")
    def _fn(web_search_config: dict = None) -> str:  # type: ignore[assignment]
        return "ok"

    assert _probe_param(_fn, "web_search_config", kwargs_counts=False) is True


def test_probe_unreadable_signature_returns_false(monkeypatch) -> None:
    """Uninspectable callables must probe False — no crash, omit injection."""
    import tools.base as tb

    def _always_raise(_fn):
        raise ValueError("simulated uninspectable callable")

    monkeypatch.setattr(tb.inspect, "signature", _always_raise)

    tool = _UnreadableSignature()
    tool.run = lambda **kwargs: None
    assert _probe_param(tool, "session_id", kwargs_counts=True) is False


# ─────────────────────────────────────────────────────────────────
# execute() behaviour: injection + input-dict isolation
# ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_execute_no_session_tool_runs_without_injection() -> None:
    """The DM-shape tool (no session_id in run) must complete without
    ``TypeError`` — the production bug."""
    result = await _BaseToolNoSessionId().execute(
        {"target": "alice", "content": "hi"}, _ctx()
    )
    assert result.is_error is False, result.content
    assert "no-session:alice:hi" in str(result.content)


@pytest.mark.asyncio
async def test_execute_session_tool_receives_injected_id() -> None:
    result = await _BaseToolWithSessionId().execute({"key": "notes"}, _ctx("sess-42"))
    assert result.is_error is False
    assert "with-session:sess-42:notes" in str(result.content)


@pytest.mark.asyncio
async def test_execute_session_tool_overrides_llm_supplied_id() -> None:
    """A hallucinated ``session_id`` from the LLM is overwritten by the
    trusted ``ToolContext.session_id``."""
    result = await _BaseToolWithSessionId().execute(
        {"session_id": "llm-hallucinated", "key": "notes"}, _ctx("ctx-sess")
    )
    assert "with-session:ctx-sess:notes" in str(result.content)
    assert "llm-hallucinated" not in str(result.content)


@pytest.mark.asyncio
async def test_execute_does_not_mutate_caller_input() -> None:
    tool = _BaseToolWithSessionId()
    caller_input: Dict[str, Any] = {"key": "x"}
    snapshot = dict(caller_input)
    await tool.execute(caller_input, _ctx())
    assert caller_input == snapshot, (
        f"execute mutated caller's input: before={snapshot}, after={caller_input}"
    )


@pytest.mark.asyncio
async def test_execute_tool_wrapper_without_session_id() -> None:
    result = await _fn_no_session.execute(
        {"target": "alice", "content": "hi"}, _ctx()
    )
    assert result.is_error is False, result.content
    assert "fn-no-session:alice:hi" in str(result.content)


@pytest.mark.asyncio
async def test_execute_tool_wrapper_with_session_id() -> None:
    result = await _fn_with_session.execute({"key": "notes"}, _ctx("sess-1"))
    assert result.is_error is False
    assert "fn-with-session:sess-1:notes" in str(result.content)


# ─────────────────────────────────────────────────────────────────
# Real-world smoke: SendDirectMessageExternalTool
# ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_send_direct_message_external_no_type_error(monkeypatch) -> None:
    """End-to-end smoke on the exact class that failed in production."""
    from tools.built_in import geny_tools

    class _FakeAgent:
        session_id = "resolved-sid"
        session_name = "SubWorker"

    class _FakeInbox:
        def deliver(self, **kwargs):
            return {"id": "msg-1", "timestamp": "2026-04-21T00:00:00Z"}

    monkeypatch.setattr(
        geny_tools, "_resolve_session", lambda _: (_FakeAgent(), "resolved-sid")
    )
    monkeypatch.setattr(geny_tools, "_get_inbox_manager", lambda: _FakeInbox())
    monkeypatch.setattr(geny_tools, "_trigger_dm_response", lambda **kwargs: None)

    tool = geny_tools.SendDirectMessageExternalTool()
    assert _probe_param(tool, "session_id", kwargs_counts=True) is False, (
        "SendDirectMessageExternalTool.run declares no session_id and no "
        "**kwargs — probe must return False"
    )

    result = await tool.execute(
        {"target_session_id": "sub-worker", "content": "안녕"}, _ctx("vtuber-session")
    )
    assert result.is_error is False, (
        f"SendDirectMessageExternalTool still errors: {result.content}"
    )
    assert "delivered_to" in str(result.content) or "success" in str(result.content)
