"""Tests for the Phase-D sample seeder."""

from __future__ import annotations

from typing import Dict, List, Optional
from unittest.mock import MagicMock

import pytest

from service.custom_tools.models import CustomToolDefinition
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

    def create(self, defn: CustomToolDefinition) -> CustomToolDefinition:
        if self.get_by_name(defn.name) is not None:
            from service.custom_tools.store import CustomToolNameTaken
            raise CustomToolNameTaken(defn.name)
        self._rows[defn.id] = defn
        return defn


def test_blog_samples_returns_five_builtin_aliases():
    samples = _blog_samples()
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
        assert s.backend_kind == "builtin_alias"
        assert s.is_sample is True


def test_seed_samples_first_run_inserts_all():
    store = _InMemStore()
    n = seed_samples(store)
    assert n == 5
    assert len(store._rows) == 5


def test_seed_samples_is_idempotent():
    store = _InMemStore()
    seed_samples(store)
    assert seed_samples(store) == 0  # nothing new on re-run
    assert len(store._rows) == 5  # no duplicates


def test_seed_samples_skips_existing_by_name():
    """If the operator already created `blog_agent_status` (e.g. forked),
    the seeder must leave it alone."""
    store = _InMemStore()
    # Pre-populate one of the names with a non-sample row.
    from service.custom_tools.models import BuiltinAliasConfig
    pre = CustomToolDefinition(
        name="blog_agent_status",
        description="user-edited copy",
        backend_kind="builtin_alias",
        config=BuiltinAliasConfig(
            source_module="blog_agent_tools",
            source_class="BlogAgentStatusTool",
            description_override="user-edited copy",
        ),
        is_sample=False,
    )
    store._rows[pre.id] = pre

    n = seed_samples(store)
    # 4 new (5 samples minus the one that already existed)
    assert n == 4
    # Pre-existing row stays
    surviving = store.get_by_name("blog_agent_status")
    assert surviving.is_sample is False
    assert surviving.description == "user-edited copy"


def test_blog_samples_capabilities():
    """Read-only lookups must be marked idempotent+concurrency_safe;
    delegate must NOT be (it's a fire-and-poll write)."""
    samples = {s.name: s for s in _blog_samples()}
    assert samples["blog_agent_status"].capabilities.read_only is True
    assert samples["blog_agent_status"].capabilities.idempotent is True
    assert samples["blog_agent_delegate"].capabilities.read_only is False
    assert samples["blog_agent_delegate"].capabilities.idempotent is False
    assert samples["blog_agent_cancel"].capabilities.idempotent is True
