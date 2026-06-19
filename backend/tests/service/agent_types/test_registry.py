"""SubagentType seed tests (PR-A.5.1)."""

from __future__ import annotations

from typing import List

import pytest

pytest.importorskip("geny_executor")

from service.agent_types import DESCRIPTORS, install_subagent_types  # noqa: E402


class _FakeRegistry:
    def __init__(self):
        self.registered: List = []

    def register(self, descriptor):
        self.registered.append(descriptor)


def test_descriptors_are_generalized_catalog():
    types = {d.agent_type for d in DESCRIPTORS}
    # generalized, app-neutral catalog from geny-executor (>=2.8.0)
    assert {"worker", "researcher", "summarizer", "critic"}.issubset(types)
    # app-specific types are not seeded
    assert "vtuber-narrator" not in types


def test_install_registers_all_descriptors():
    reg = _FakeRegistry()
    count = install_subagent_types(reg)
    assert count == len(DESCRIPTORS)
    assert {
        "worker", "researcher", "summarizer", "critic",
    }.issubset({d.agent_type for d in reg.registered})


def test_install_with_none_returns_zero():
    assert install_subagent_types(None) == 0


def test_install_with_extras():
    from geny_executor.stages.s12_agent.subagent_type import (
        SubagentTypeDescriptor,
    )
    reg = _FakeRegistry()
    extra = [
        SubagentTypeDescriptor(
            agent_type="custom", factory=lambda ctx: None, description="x"
        )
    ]
    count = install_subagent_types(reg, extra=extra)
    assert count == len(DESCRIPTORS) + 1


def test_failed_registration_does_not_propagate():
    class _BadReg:
        def register(self, _d):
            raise RuntimeError("registry full")

    # Should not raise — failures logged + count returned anyway.
    count = install_subagent_types(_BadReg())
    assert count == len(DESCRIPTORS)
