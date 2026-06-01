"""Tests for the Phase-D/E sample seeder.

PR #851 originally shipped these as ``builtin_alias`` overlays. The
follow-up flipped them to real ``python_inline`` samples (full Python
source in the DB row, the operator edits the actual code) and added a
legacy-row upgrade path so existing alias rows get rewritten in place
on next boot.
"""

from __future__ import annotations

from typing import Dict, List, Optional

import pytest

from service.custom_tools.models import (
    BuiltinAliasConfig,
    CustomToolDefinition,
    PythonInlineConfig,
)
from service.custom_tools.samples import _blog_samples, seed_samples


class _InMemStore:
    """Minimal CustomToolStore replacement for unit tests."""

    def __init__(self) -> None:
        self._rows: Dict[str, CustomToolDefinition] = {}

    def get_by_name(self, name: str) -> Optional[CustomToolDefinition]:
        for d in self._rows.values():
            if d.name == name:
                return d
        return None

    def get(self, tool_id: str) -> CustomToolDefinition:
        if tool_id not in self._rows:
            from service.custom_tools.store import CustomToolNotFound
            raise CustomToolNotFound(tool_id)
        return self._rows[tool_id]

    def create(self, defn: CustomToolDefinition) -> CustomToolDefinition:
        if self.get_by_name(defn.name) is not None:
            from service.custom_tools.store import CustomToolNameTaken
            raise CustomToolNameTaken(defn.name)
        self._rows[defn.id] = defn
        return defn

    def replace(
        self, tool_id: str, defn: CustomToolDefinition
    ) -> CustomToolDefinition:
        if tool_id not in self._rows:
            from service.custom_tools.store import CustomToolNotFound
            raise CustomToolNotFound(tool_id)
        # Pin immutable fields (mirrors real store contract).
        defn.id = tool_id
        defn.is_sample = self._rows[tool_id].is_sample
        self._rows[tool_id] = defn
        return defn


def test_blog_samples_returns_five_python_inline_rows():
    samples = _blog_samples()
    # When run from a checkout where blog_agent_tools.py is still
    # present, the seeder loads its source and emits five rows.
    assert len(samples) == 5
    names = sorted(s.name for s in samples)
    assert names == [
        "blog_agent_cancel",
        "blog_agent_delegate",
        "blog_agent_get_post",
        "blog_agent_list_posts",
        "blog_agent_status",
    ]
    for s in samples:
        assert s.backend_kind == "python_inline"
        assert s.is_sample is True
        # The source body is the file content — sanity-check it's not
        # empty and parses as Python (contains a known class name).
        assert isinstance(s.config, PythonInlineConfig)
        assert "class Blog" in s.config.source_code
        assert s.config.class_name.startswith("BlogAgent")


def test_seed_samples_first_run_inserts_all():
    store = _InMemStore()
    n = seed_samples(store)
    assert n == 5
    assert len(store._rows) == 5
    for row in store._rows.values():
        assert row.backend_kind == "python_inline"


def test_seed_samples_is_idempotent():
    store = _InMemStore()
    seed_samples(store)
    assert seed_samples(store) == 0  # nothing new on re-run
    assert len(store._rows) == 5


def test_seed_samples_skips_existing_python_inline_row():
    """If the operator already edited a sample (python_inline), the
    seeder must leave it alone."""
    store = _InMemStore()
    pre_src = "from tools.base import BaseTool\nclass BlogAgentStatusTool(BaseTool):\n    name='blog_agent_status'\n    description='operator-edited'\n    def run(self): return 'mine'\n"
    pre = CustomToolDefinition(
        name="blog_agent_status",
        description="operator-edited",
        backend_kind="python_inline",
        config=PythonInlineConfig(
            source_code=pre_src,
            class_name="BlogAgentStatusTool",
        ),
        is_sample=False,
    )
    store._rows[pre.id] = pre

    n = seed_samples(store)
    # 4 new (5 minus the one that already existed)
    assert n == 4
    surviving = store.get_by_name("blog_agent_status")
    assert surviving.description == "operator-edited"
    assert surviving.is_sample is False


def test_seed_samples_upgrades_legacy_alias_row():
    """Legacy ``builtin_alias`` rows from PR #851 must be flipped to
    ``python_inline`` in place when the new seeder runs."""
    store = _InMemStore()
    legacy = CustomToolDefinition(
        name="blog_agent_status",
        description="legacy alias",
        backend_kind="builtin_alias",
        config=BuiltinAliasConfig(
            source_module="blog_agent_tools",
            source_class="BlogAgentStatusTool",
        ),
        is_sample=True,
    )
    store._rows[legacy.id] = legacy

    n = seed_samples(store)
    # All 5 changed: 1 upgrade + 4 fresh inserts.
    assert n == 5
    upgraded = store.get_by_name("blog_agent_status")
    assert upgraded.backend_kind == "python_inline"
    assert upgraded.is_sample is True
    assert isinstance(upgraded.config, PythonInlineConfig)


def test_blog_samples_capabilities():
    """Read-only lookups must be marked idempotent+concurrency_safe;
    delegate must NOT be (it's a fire-and-poll write)."""
    samples = {s.name: s for s in _blog_samples()}
    assert samples["blog_agent_status"].capabilities.read_only is True
    assert samples["blog_agent_status"].capabilities.idempotent is True
    assert samples["blog_agent_delegate"].capabilities.read_only is False
    assert samples["blog_agent_delegate"].capabilities.idempotent is False
    assert samples["blog_agent_cancel"].capabilities.idempotent is True
