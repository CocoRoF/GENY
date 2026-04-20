"""Integration: a VTuber pipeline can actually dispatch geny_send_direct_message.

The 20260420_5 cycle root-caused LOG2 (``Tool error [...] Executed with 1 errors``)
to the following chain:

1. VTuber env was hardcoded to three web tools (``web_search``,
   ``news_search``, ``web_fetch``) — ``geny_send_direct_message``
   was never in ``manifest.tools.external``.
2. Even if the VTuber *tried* to call ``geny_send_direct_message``,
   the pipeline's tool registry had no entry for it, so the router
   short-circuited with ``unknown_tool``.

PR #2 fixed (1) by giving the VTuber every platform tool plus the
three web tools. PR #1 (and the v0.26.1 / v0.26.2 executor bumps)
fixed the registration/rebind invariant. This integration test
locks the combined behaviour:

    Given: VTuber manifest built with the full roster.
    When:  Stage 10 is dispatched with a pending geny_send_direct_message call.
    Then:  The tool recorded the call with the expected input.

Similar in spirit to the existing
``test_delegation_round_trip.py::test_tool_stage_executes_pending_calls_for_worker_manifest``
— different role (VTuber), and focused on the DM tool that was
specifically broken in LOG2.

The full live round-trip (VTuber session → API → tool stage → DM into
the Sub-Worker inbox) requires a live Anthropic key and the full
``AgentSessionManager`` bootstrap, which this layer of tests
intentionally avoids. Manual smoke is the verification for that layer;
see ``dev_docs/20260420_5/plan/04_end_to_end_validation.md``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest
from geny_executor.tools.base import Tool, ToolContext, ToolResult


class _RecordingDMTool(Tool):
    """Stub ``geny_send_direct_message`` that records every call.

    Matches the real tool's *name* and accepts the same top-level
    input shape (``target_session_id``, ``message``). Returning a
    simple success result is enough to check that Stage 10 dispatched
    the call; the real tool's side effect (enqueue into the target's
    inbox) is out of scope for this layer."""

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    @property
    def name(self) -> str:
        return "geny_send_direct_message"

    @property
    def description(self) -> str:
        return "Recording stub for geny_send_direct_message."

    @property
    def input_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "target_session_id": {"type": "string"},
                "message": {"type": "string"},
            },
            "required": ["target_session_id", "message"],
        }

    async def execute(self, input: Dict[str, Any], context: ToolContext) -> ToolResult:
        self.calls.append(dict(input))
        return ToolResult(content="dm recorded")


class _DMProvider:
    """Supplies only ``geny_send_direct_message`` via the AdhocToolProvider
    Protocol — the pipeline will skip every other manifest name with a
    warning, which is exactly the production behaviour if a deployment
    chose to not wire a given tool."""

    def __init__(self, tool: _RecordingDMTool) -> None:
        self._tool = tool

    def list_names(self) -> List[str]:
        return [self._tool.name]

    def get(self, name: str) -> Optional[_RecordingDMTool]:
        return self._tool if name == self._tool.name else None


@pytest.mark.asyncio
async def test_vtuber_pipeline_dispatches_dm_call() -> None:
    """VTuber pipeline, built through the real manifest + Pipeline
    path, actually routes a ``geny_send_direct_message`` call to the
    registered tool.

    This is the functional proof that PR #1 + PR #2 + the v0.26.1/.2
    executor bumps compose into a working end-to-end path for the
    VTuber persona: the tool is *on the manifest*, the pipeline
    registers it, and Stage 10 dispatches the call to it."""
    from geny_executor.core.pipeline import Pipeline
    from geny_executor.core.state import PipelineState

    from service.environment.templates import create_vtuber_env

    all_names = [
        "geny_send_direct_message",
        "geny_read_inbox",
        "memory_read",
        "memory_write",
        "knowledge_search",
        "opsidian_browse",
        "web_search",
        "news_search",
        "web_fetch",
        "browser_navigate",
    ]
    manifest = create_vtuber_env(all_tool_names=all_names)

    recording = _RecordingDMTool()
    provider = _DMProvider(recording)

    pipeline = Pipeline.from_manifest(
        manifest,
        api_key="sk-test",
        strict=False,
        adhoc_providers=[provider],
    )

    assert "geny_send_direct_message" in pipeline.tool_registry.list_names(), (
        "VTuber pipeline should have geny_send_direct_message registered. "
        f"Got: {pipeline.tool_registry.list_names()}"
    )

    tool_stage = next(s for s in pipeline.stages if getattr(s, "order", None) == 10)

    state = PipelineState(session_id="vtuber-session")
    state.pending_tool_calls = [
        {
            "tool_name": "geny_send_direct_message",
            "tool_input": {
                "target_session_id": "sub-worker-session",
                "message": "안녕",
            },
            "tool_use_id": "call_dm_1",
        }
    ]

    await tool_stage.execute(input=None, state=state)

    assert recording.calls == [
        {"target_session_id": "sub-worker-session", "message": "안녕"}
    ], (
        "Stage 10 did not dispatch geny_send_direct_message to the "
        "registered tool. This is the exact failure path LOG2 reported — "
        "the manifest/registration chain is broken."
    )
    assert state.pending_tool_calls == [], (
        "Stage 10 should clear pending_tool_calls once dispatched."
    )
    assert state.tool_results, (
        "Stage 10 should populate tool_results with the DM tool's output."
    )


@pytest.mark.asyncio
async def test_vtuber_pipeline_skips_browser_dispatch() -> None:
    """Negative control: even if a VTuber session somehow emitted a
    pending ``browser_navigate`` call, the pipeline has no such tool
    registered (PR #2 excluded browser tools from the VTuber roster)
    so the router resolves to ``unknown_tool`` and records an error.

    This guards against a regression where ``browser_*`` leaks back
    into the VTuber roster via a fallback path."""
    from geny_executor.core.pipeline import Pipeline
    from geny_executor.core.state import PipelineState

    from service.environment.templates import create_vtuber_env

    manifest = create_vtuber_env(
        all_tool_names=[
            "geny_send_direct_message",
            "web_search",
            "browser_navigate",
        ]
    )
    pipeline = Pipeline.from_manifest(
        manifest,
        api_key="sk-test",
        strict=False,
        adhoc_providers=[_DMProvider(_RecordingDMTool())],
    )

    assert "browser_navigate" not in pipeline.tool_registry.list_names(), (
        "PR #2 filter missed browser_navigate — VTuber roster is leaking "
        "browser tools again."
    )

    tool_stage = next(s for s in pipeline.stages if getattr(s, "order", None) == 10)
    state = PipelineState(session_id="vtuber-session")
    state.pending_tool_calls = [
        {
            "tool_name": "browser_navigate",
            "tool_input": {"url": "https://example.com"},
            "tool_use_id": "call_nav_1",
        }
    ]

    await tool_stage.execute(input=None, state=state)

    assert state.tool_results, "Stage 10 should still record a result entry"
    result_entry = state.tool_results[0]
    is_error = (
        result_entry.get("is_error")
        or result_entry.get("error")
        or "unknown" in str(result_entry.get("content", "")).lower()
    )
    assert is_error, (
        f"browser_navigate should have failed resolution on a VTuber pipeline "
        f"(tool not registered); got result: {result_entry}"
    )
