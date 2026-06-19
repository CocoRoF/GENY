"""Per-env precise Sub-Worker roster overlay (SubagentRegistryBuilder)."""

from __future__ import annotations

import pytest

from service.agent_types.builder import SubagentRegistryBuilder
from service.agent_types.registry import DESCRIPTORS

pytestmark = pytest.mark.skipif(not DESCRIPTORS, reason="geny-executor not importable")


def _roster(reg):
    return sorted(reg._descriptors.keys())


def test_no_overrides_uses_seed_roster():
    reg = SubagentRegistryBuilder().build()
    assert _roster(reg) == sorted(d.agent_type for d in DESCRIPTORS)


def test_override_replaces_seed_type_config():
    reg = SubagentRegistryBuilder(
        env_overrides=[
            {
                "agent_type": "worker",
                "model": "claude-haiku-4-5",
                "system_prompt": "Be terse.",
                "allowed_tools": ["Read", "Grep"],
            }
        ]
    ).build()
    w = reg.get("worker")
    assert w.model_override == "claude-haiku-4-5"
    assert w.system_prompt == "Be terse."
    assert tuple(w.allowed_tools) == ("Read", "Grep")
    # other seed types untouched
    assert "researcher" in reg._descriptors


def test_override_adds_new_type():
    reg = SubagentRegistryBuilder(
        env_overrides=[{"agent_type": "translator", "description": "KO<->EN"}]
    ).build()
    t = reg.get("translator")
    assert t is not None and t.description == "KO<->EN"


def test_disabled_type_removed_from_roster():
    reg = SubagentRegistryBuilder(
        env_overrides=[{"agent_type": "critic", "enabled": False}]
    ).build()
    assert "critic" not in reg._descriptors


def test_malformed_entries_ignored():
    reg = SubagentRegistryBuilder(
        env_overrides=[{"no_agent_type": "x"}, "garbage", {"agent_type": ""}]
    ).build()
    # falls back to clean seed roster
    assert _roster(reg) == sorted(d.agent_type for d in DESCRIPTORS)
