"""J.1 (cycle 20260426_3) — persona tail-block resolver tests.

Verifies role-driven block selection from settings.json:persona with
fallback to historical default.
"""

from __future__ import annotations

import pytest

pytest.importorskip("geny_executor")

from service.persona import blocks_resolver as resolver


@pytest.fixture
def stub_section(monkeypatch):
    """Replace ``_settings_section`` with a controllable dict."""
    holder = {"value": {}}

    def fake() -> dict:
        return holder["value"]

    monkeypatch.setattr(resolver, "_settings_section", fake)
    return holder


def test_default_when_section_absent(stub_section) -> None:
    """No settings → cycle 20260503_7 default
    [datetime, memory_context, host_memory_tools]."""
    stub_section["value"] = {}
    blocks = resolver.resolve_tail_blocks("worker")
    assert len(blocks) == 3
    names = [b.name for b in blocks]
    assert names == ["datetime", "memory_context", "host_memory_tools"]


def test_role_specific_override(stub_section) -> None:
    """Role-specific list wins over the default."""
    stub_section["value"] = {
        "tail_blocks_by_role": {"vtuber": ["datetime"]},
    }
    vtuber_blocks = resolver.resolve_tail_blocks("vtuber")
    worker_blocks = resolver.resolve_tail_blocks("worker")
    assert len(vtuber_blocks) == 1  # datetime only
    assert len(worker_blocks) == 3  # falls back to default (3 blocks now)


def test_default_key_overrides_historical(stub_section) -> None:
    """The 'default' key replaces the historical list when no role-specific
    entry is set."""
    stub_section["value"] = {
        "tail_blocks_by_role": {"default": ["memory_context"]},
    }
    blocks = resolver.resolve_tail_blocks("worker")
    assert len(blocks) == 1


def test_unknown_block_key_skipped(stub_section, caplog) -> None:
    """Unknown block keys log a warning + are skipped, not crash."""
    import logging

    stub_section["value"] = {
        "tail_blocks_by_role": {"worker": ["datetime", "not-a-block", "memory_context"]},
    }
    with caplog.at_level(logging.WARNING):
        blocks = resolver.resolve_tail_blocks("worker")
    assert len(blocks) == 2  # datetime + memory_context; bad one skipped
    assert any("not-a-block" in rec.message for rec in caplog.records)


def test_empty_list_falls_back_to_default(stub_section) -> None:
    """An explicitly-empty list for a role still falls back to the
    historical chain — operators editing the section probably mistyped."""
    stub_section["value"] = {
        "tail_blocks_by_role": {"worker": []},
    }
    blocks = resolver.resolve_tail_blocks("worker")
    # Assert the chain itself, not just its length — a count says nothing
    # about which blocks a fallback actually restored, and this one grew by
    # a block without the test noticing.
    assert [b.name for b in blocks] == [
        "datetime", "memory_context", "host_memory_tools",
    ]


def test_garbage_section_falls_back(stub_section) -> None:
    """Section with non-dict value → defaults applied."""
    stub_section["value"] = {"tail_blocks_by_role": "not-a-dict"}
    blocks = resolver.resolve_tail_blocks("worker")
    assert len(blocks) == 3


def test_host_memory_tools_block_renders_catalogue(stub_section) -> None:
    """Cycle 20260503_7 — the host's HostMemoryToolsBlock surfaces
    Geny's concrete tool ladder text in the system prompt tail.
    """
    stub_section["value"] = {}
    blocks = resolver.resolve_tail_blocks("worker")
    last = blocks[-1]
    assert last.name == "host_memory_tools"
    rendered = last.render(state=None)
    # The block no longer enumerates tool names. They reach the model as tool
    # SCHEMAS, and the prompt points at those — naming them here as well
    # duplicated a roster that drifts every time a tool is added or renamed.
    # What the block must still carry is the usage contract around them.
    assert "tools' schemas are provided to you" in rendered
    assert "Pinned Facts" in rendered
    assert "Vault Map" in rendered
    # Policy is present too, so the agent gets policy and tools in one
    # coherent block. Asserted by MEANING rather than by an exact phrase —
    # the wording has been rewritten once already and an exact-string match
    # fails on a rewrite that changes nothing about the contract.
    assert "consult memory" in rendered
    assert "already answered" in rendered
    assert "don't announce" in rendered
