"""Regression coverage for G6.1 — every Geny custom Tool exposes a
``ToolCapabilities`` declaration that the bridge forwards to Stage 10.

Two layers of assertion:

1. **Per-tool inventory** — every tool we ship has a non-default
   ``CAPABILITIES`` (so the executor's PartitionExecutor can group
   read-only batches without falling back to the fail-closed serial
   default). Tools that *should* serialize still declare
   ``concurrency_safe=False`` explicitly — the difference between
   "we considered it" and "we forgot" matters when the partition
   strategy lands in G6.2.

2. **Bridge forwarding** — :class:`_GenyToolAdapter.capabilities()`
   reads the wrapped tool's class-level ``CAPABILITIES`` attribute
   and returns it verbatim. A bridge that drops the attribute would
   defeat the entire point of G6.1.
"""

from __future__ import annotations

import pytest

pytest.importorskip("geny_executor")
from geny_executor.tools.base import ToolCapabilities  # noqa: E402

from service.executor.tool_bridge import _GenyToolAdapter  # noqa: E402


# ── Inventory: read every tool module and assert CAPABILITIES is set ──


def _tool_classes():
    """Walk every Geny custom Tool subclass that should declare flags.

    Imported lazily inside the function so a missing module only fails
    its own assertion, not the whole file collection.
    """
    out = []

    # Game tools (4)
    from service.game.tools.feed import FeedTool
    from service.game.tools.gift import GiftTool
    from service.game.tools.play import PlayTool
    from service.game.tools.talk import TalkTool

    out.extend([FeedTool, GiftTool, PlayTool, TalkTool])

    # Web tools (4)
    from tools.custom.web_fetch_tools import WebFetchTool, WebFetchMultipleTool
    from tools.custom.web_search_tools import WebSearchTool, NewsSearchTool

    out.extend([WebFetchTool, WebFetchMultipleTool, WebSearchTool, NewsSearchTool])

    # Browser tools (7)
    from tools.custom.browser_tools import (
        BrowserNavigateTool, BrowserClickTool, BrowserFillTool,
        BrowserScreenshotTool, BrowserEvaluateTool, BrowserGetPageInfoTool,
        BrowserCloseTool,
    )

    out.extend([
        BrowserNavigateTool, BrowserClickTool, BrowserFillTool,
        BrowserScreenshotTool, BrowserEvaluateTool, BrowserGetPageInfoTool,
        BrowserCloseTool,
    ])

    # Memory tools (7)
    from tools.built_in.memory_tools import (
        MemoryWriteTool, MemoryReadTool, MemoryUpdateTool, MemoryDeleteTool,
        MemorySearchTool, MemoryListTool, MemoryLinkTool,
    )

    out.extend([
        MemoryWriteTool, MemoryReadTool, MemoryUpdateTool, MemoryDeleteTool,
        MemorySearchTool, MemoryListTool, MemoryLinkTool,
    ])

    # Knowledge / Opsidian tools (6)
    from tools.built_in.knowledge_tools import (
        KnowledgeSearchTool, KnowledgeReadTool, KnowledgeListTool,
        KnowledgePromoteTool, OpsidianBrowseTool, OpsidianReadTool,
    )

    out.extend([
        KnowledgeSearchTool, KnowledgeReadTool, KnowledgeListTool,
        KnowledgePromoteTool, OpsidianBrowseTool, OpsidianReadTool,
    ])

    # Geny platform tools (12)
    from tools.built_in.geny_tools import (
        SessionListTool, SessionInfoTool, SessionCreateTool,
        RoomListTool, RoomCreateTool, RoomInfoTool, RoomAddMembersTool,
        SendRoomMessageTool, SendDirectMessageExternalTool,
        SendDirectMessageInternalTool, ReadRoomMessagesTool, ReadInboxTool,
    )

    out.extend([
        SessionListTool, SessionInfoTool, SessionCreateTool,
        RoomListTool, RoomCreateTool, RoomInfoTool, RoomAddMembersTool,
        SendRoomMessageTool, SendDirectMessageExternalTool,
        SendDirectMessageInternalTool, ReadRoomMessagesTool, ReadInboxTool,
    ])

    return out


@pytest.mark.parametrize("tool_cls", _tool_classes())
def test_tool_class_declares_capabilities(tool_cls) -> None:
    caps = getattr(tool_cls, "CAPABILITIES", None)
    assert isinstance(caps, ToolCapabilities), (
        f"{tool_cls.__name__} is missing a CAPABILITIES = ToolCapabilities(...) "
        "class attribute. Stage 10's PartitionExecutor needs every tool to "
        "declare its concurrency / read-only / destructive traits explicitly."
    )


def test_total_tool_count_unchanged() -> None:
    """Sanity: if a tool moves out of the inventory, this test loudly fails
    so the author updates the matrix instead of silently shrinking coverage."""
    assert len(_tool_classes()) == 40


# ── Bridge forwarding ────────────────────────────────────────────────


class _StubToolWithCaps:
    """Minimal stand-in for a Geny BaseTool with a CAPABILITIES attr."""

    name = "stub_caps"
    description = "stub"
    parameters = {"type": "object", "properties": {}}
    CAPABILITIES = ToolCapabilities(
        concurrency_safe=True, read_only=True, idempotent=True,
        network_egress=False, max_result_chars=12345,
    )

    async def arun(self, **_: object) -> str:  # pragma: no cover - not exercised
        return ""


class _StubToolNoCaps:
    name = "stub_nocaps"
    description = "stub"
    parameters = {"type": "object", "properties": {}}

    async def arun(self, **_: object) -> str:  # pragma: no cover
        return ""


def test_bridge_returns_declared_capabilities() -> None:
    adapter = _GenyToolAdapter(_StubToolWithCaps())
    caps = adapter.capabilities({})
    assert caps is _StubToolWithCaps.CAPABILITIES
    assert caps.concurrency_safe is True
    assert caps.read_only is True
    assert caps.max_result_chars == 12345


def test_bridge_falls_back_to_fail_closed_default() -> None:
    """When the wrapped tool has no CAPABILITIES, the bridge returns a
    fresh ``ToolCapabilities()`` — Stage 10 then treats it as
    serialize-by-default."""
    adapter = _GenyToolAdapter(_StubToolNoCaps())
    caps = adapter.capabilities({})
    assert isinstance(caps, ToolCapabilities)
    assert caps.concurrency_safe is False
    assert caps.read_only is False
    assert caps.destructive is False
