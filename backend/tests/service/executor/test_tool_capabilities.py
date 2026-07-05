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

2. **capabilities() forwarding** — ``BaseTool.capabilities()`` reads the
   tool's class-level ``CAPABILITIES`` attribute and returns it verbatim
   (Geny tools are executor ``Tool``s now, so there is no separate bridge;
   ``capabilities()`` lives on the tool itself). A tool that drops the
   attribute would defeat the entire point of G6.1.
"""

from __future__ import annotations

import pytest

pytest.importorskip("geny_executor")
from geny_executor.tools.base import ToolCapabilities  # noqa: E402

from tools.base import BaseTool  # noqa: E402


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

    # Web search tools (2) — web_fetch*/browser_* custom tools were
    # replaced by the executor's an-web built-ins (2.43 migration).
    from tools.custom.web_search_tools import WebSearchTool, NewsSearchTool

    out.extend([WebSearchTool, NewsSearchTool])

    # Document tools (4) — edit2docs-backed (2.43 migration)
    from tools.built_in.document_tools import (
        DocAnalyzeTool, DocConvertTool, DocEditTool, DocGenerateTool,
    )

    out.extend([DocAnalyzeTool, DocConvertTool, DocEditTool, DocGenerateTool])

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
    assert len(_tool_classes()) == 35


# ── capabilities() forwarding ────────────────────────────────────────


class _StubToolWithCaps(BaseTool):
    """A Geny BaseTool with a CAPABILITIES attr."""

    name = "stub_caps"
    description = "stub"
    parameters = {"type": "object", "properties": {}}
    CAPABILITIES = ToolCapabilities(
        concurrency_safe=True, read_only=True, idempotent=True,
        network_egress=False, max_result_chars=12345,
    )

    def run(self, **_: object) -> str:  # pragma: no cover - not exercised
        return ""


class _StubToolNoCaps(BaseTool):
    name = "stub_nocaps"
    description = "stub"
    parameters = {"type": "object", "properties": {}}

    def run(self, **_: object) -> str:  # pragma: no cover
        return ""


def test_tool_returns_declared_capabilities() -> None:
    caps = _StubToolWithCaps().capabilities({})
    assert caps is _StubToolWithCaps.CAPABILITIES
    assert caps.concurrency_safe is True
    assert caps.read_only is True
    assert caps.max_result_chars == 12345


def test_tool_falls_back_to_fail_closed_default() -> None:
    """When the tool has no CAPABILITIES, ``capabilities()`` returns a fresh
    ``ToolCapabilities()`` — Stage 10 treats it as serialize-by-default."""
    caps = _StubToolNoCaps().capabilities({})
    assert isinstance(caps, ToolCapabilities)
    assert caps.concurrency_safe is False
    assert caps.read_only is False
    assert caps.destructive is False
