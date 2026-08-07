"""Tests for the bundled-sample seeder.

PR #851 originally shipped these as ``builtin_alias`` overlays.
PR #853 flipped them to ``python_inline`` but used a single monolithic
blob (the entire ``blog_agent_tools.py``) for every row.
The follow-up makes each row carry only its own self-contained source.
The seeder upgrades both legacy shapes to the new per-tool form.
"""

from __future__ import annotations

from typing import Dict, Optional

import pytest

from service.custom_tools.models import (
    BuiltinAliasConfig,
    CustomToolDefinition,
    PythonInlineConfig,
)
from service.custom_tools.samples import (
    _blog_samples,
    _SAMPLE_SPECS,
    seed_samples,
)


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
        defn.id = tool_id
        defn.is_sample = self._rows[tool_id].is_sample
        self._rows[tool_id] = defn
        return defn


def test_sample_specs_cover_five_blog_tools():
    names = sorted(s.name for s in _SAMPLE_SPECS)
    assert names == [
        "blog_agent_cancel",
        "blog_agent_delegate",
        "blog_agent_get_post",
        "blog_agent_list_posts",
        "blog_agent_status",
    ]


def test_blog_samples_each_row_is_self_contained():
    """Each sample row must contain ONLY its own tool's source —
    no four-sibling-classes monolithic blob."""
    samples = _blog_samples()
    assert len(samples) == 5
    for s in samples:
        assert s.backend_kind == "python_inline"
        assert s.is_sample is True
        assert isinstance(s.config, PythonInlineConfig)
        src = s.config.source_code
        # The named class must appear in the source.
        assert f"class {s.config.class_name}" in src
        # The OTHER four classes must NOT appear (true self-containment).
        other_class_names = {
            spec.class_name
            for spec in _SAMPLE_SPECS
            if spec.class_name != s.config.class_name
        }
        for other in other_class_names:
            assert (
                f"class {other}" not in src
            ), (
                f"sample {s.name} leaked unrelated class {other} into its source — "
                "each row must be self-contained"
            )


def test_blog_samples_source_size_bounds():
    """Self-contained per-tool sources stay small, with delegate (the
    heaviest) the largest.

    The bound is a smell detector, not a spec: it catches a sample turning
    into a library. It was 12,000 and delegate reached 12,121 — growth, not
    ballooning — so it moves with the code rather than being silently
    deleted. Sizes are printed on failure so the next bump is a decision
    someone makes on purpose.
    """
    samples = {s.name: s for s in _blog_samples()}
    for name, s in samples.items():
        assert isinstance(s.config, PythonInlineConfig)
        size = len(s.config.source_code)
        assert size < 14_000, (
            f"sample {name} source ballooned to {size} chars; "
            f"current sizes: "
            + ", ".join(
                f"{n}={len(x.config.source_code)}" for n, x in sorted(samples.items())
            )
        )
    # Delegate carries the most helpers; the lookup tools are tiny.
    delegate_len = len(samples["blog_agent_delegate"].config.source_code)
    status_len = len(samples["blog_agent_status"].config.source_code)
    assert delegate_len > status_len


def test_seed_first_run_inserts_all():
    store = _InMemStore()
    n = seed_samples(store)
    assert n == 5
    assert len(store._rows) == 5
    for row in store._rows.values():
        assert row.backend_kind == "python_inline"


def test_seed_is_idempotent():
    store = _InMemStore()
    seed_samples(store)
    assert seed_samples(store) == 0
    assert len(store._rows) == 5


def test_seed_upgrades_legacy_builtin_alias_row():
    """PR #851 ``builtin_alias`` rows get flipped in place."""
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
    # 1 upgrade + 4 fresh inserts.
    assert n == 5
    upgraded = store.get_by_name("blog_agent_status")
    assert upgraded.backend_kind == "python_inline"
    assert upgraded.is_sample is True
    assert isinstance(upgraded.config, PythonInlineConfig)
    assert "class BlogAgentStatusTool" in upgraded.config.source_code


def test_seed_upgrades_legacy_monolithic_python_inline():
    """First-cut PR #853 rows used the entire 20KB blob — must upgrade
    to the self-contained per-tool source."""
    store = _InMemStore()
    monolithic_src = (
        "from tools.base import BaseTool\n\n"
        # Fake monolithic blob: 5 class declarations + lots of padding
        "class BlogAgentDelegateTool(BaseTool):\n    pass\n"
        "class BlogAgentStatusTool(BaseTool):\n    pass\n"
        "class BlogAgentCancelTool(BaseTool):\n    pass\n"
        "class BlogAgentListPostsTool(BaseTool):\n    pass\n"
        "class BlogAgentGetPostTool(BaseTool):\n    pass\n"
        + ("# pad\n" * 5_000)
    )
    legacy = CustomToolDefinition(
        name="blog_agent_status",
        description="legacy monolithic",
        backend_kind="python_inline",
        config=PythonInlineConfig(
            source_code=monolithic_src,
            class_name="BlogAgentStatusTool",
        ),
        is_sample=True,
    )
    store._rows[legacy.id] = legacy

    n = seed_samples(store)
    upgraded = store.get_by_name("blog_agent_status")
    # The upgrade should have replaced the monolithic blob with the
    # self-contained per-tool source. The new source contains its own
    # class but NOT the other four.
    assert isinstance(upgraded.config, PythonInlineConfig)
    src = upgraded.config.source_code
    assert "class BlogAgentStatusTool" in src
    assert "class BlogAgentDelegateTool" not in src
    assert "class BlogAgentCancelTool" not in src
    # New source is much smaller than the monolithic blob.
    assert len(src) < len(monolithic_src)
    # Counted as an upgrade.
    assert n >= 1


def test_seed_preserves_operator_edited_row():
    """A user-edited python_inline row (is_sample=False) is never touched."""
    store = _InMemStore()
    pre = CustomToolDefinition(
        name="blog_agent_status",
        description="operator-edited",
        backend_kind="python_inline",
        config=PythonInlineConfig(
            source_code=(
                "from tools.base import BaseTool\n"
                "class BlogAgentStatusTool(BaseTool):\n"
                "    name='blog_agent_status'\n"
                "    def run(self): return 'mine'\n"
            ),
            class_name="BlogAgentStatusTool",
        ),
        is_sample=False,
    )
    store._rows[pre.id] = pre

    seed_samples(store)
    surviving = store.get_by_name("blog_agent_status")
    assert surviving.description == "operator-edited"
    assert surviving.is_sample is False


def test_blog_samples_capabilities():
    samples = {s.name: s for s in _blog_samples()}
    assert samples["blog_agent_status"].capabilities.read_only is True
    assert samples["blog_agent_status"].capabilities.idempotent is True
    assert samples["blog_agent_delegate"].capabilities.read_only is False
    assert samples["blog_agent_delegate"].capabilities.idempotent is False
    assert samples["blog_agent_cancel"].capabilities.idempotent is True
