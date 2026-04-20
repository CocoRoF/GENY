"""Pipeline-level registry parity tests for the seed env rosters.

These tests go one layer deeper than ``test_templates.py``. Instead of
asserting what the manifest ``external`` field declares, they build a
real :class:`~geny_executor.core.pipeline.Pipeline` from that manifest
with a fake :class:`AdhocToolProvider` and check which names land in
``pipeline.tool_registry``.

The 20260420_5 defect class lived in the gap between declaration and
registration:

- ``manifest.tools.built_in`` was being populated at boot but
  ``Pipeline.from_manifest`` only consumes ``.external`` via
  ``_register_external_tools``. Platform tools (``geny_*``,
  ``memory_*``, ``knowledge_*``, ``opsidian_*``) were declared but
  never registered, so sessions reported "I only have web tools".
- ``install_environment_templates`` at boot was passing
  ``tool_loader.get_custom_names()`` — custom-only, missing every
  platform builtin. The worker env on disk was missing half its
  tools; the VTuber env was hardcoded to a three-web-tool roster.

Unit tests in ``test_templates.py`` would catch those two if someone
re-declares them wrong, but they can't catch a regression in
``Pipeline.from_manifest`` itself — e.g. if a future executor refactor
stops walking ``.external``, or switches precedence. These pipeline
tests are the next line of defence.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest
from geny_executor.tools.base import Tool, ToolContext, ToolResult


class _StubTool(Tool):
    """Minimal executor Tool used by the fake provider below."""

    def __init__(self, name: str) -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return f"stub for {self._name}"

    @property
    def input_schema(self) -> Dict[str, Any]:
        return {"type": "object", "properties": {}, "required": []}

    async def execute(self, input: Dict[str, Any], context: ToolContext) -> ToolResult:
        return ToolResult(content=f"stub:{self._name}")


class _FakeProvider:
    """Adapts a flat name list as the AdhocToolProvider Protocol.

    Mirrors ``service.langgraph.geny_tool_provider.GenyToolProvider``
    shape without dragging in ToolLoader / tool_bridge — tests build
    a provider from a literal list and never touch the filesystem.
    """

    def __init__(self, names: List[str]) -> None:
        self._names = list(names)
        self._cache: Dict[str, _StubTool] = {}

    def list_names(self) -> List[str]:
        return list(self._names)

    def get(self, name: str) -> Optional[_StubTool]:
        if name not in self._names:
            return None
        if name not in self._cache:
            self._cache[name] = _StubTool(name)
        return self._cache[name]


_REPRESENTATIVE_ROSTER = [
    "geny_send_direct_message",
    "geny_read_inbox",
    "geny_session_list",
    "memory_read",
    "memory_write",
    "knowledge_search",
    "opsidian_browse",
    "web_search",
    "news_search",
    "web_fetch",
    "browser_navigate",
    "browser_click",
]


def test_worker_pipeline_registry_contains_platform_tools() -> None:
    """The worker seed env, built through the real Pipeline factory
    with a provider that can supply every name, must end up with
    every platform + custom tool registered. This is the registration
    path that the VTuber/Sub-Worker defect exposed."""
    from geny_executor.core.pipeline import Pipeline

    from service.environment.templates import create_worker_env

    manifest = create_worker_env(external_tool_names=_REPRESENTATIVE_ROSTER)
    provider = _FakeProvider(_REPRESENTATIVE_ROSTER)

    pipeline = Pipeline.from_manifest(
        manifest,
        api_key="sk-test",
        strict=False,
        adhoc_providers=[provider],
    )

    registered = set(pipeline.tool_registry.list_names())

    for required in (
        "geny_send_direct_message",
        "geny_read_inbox",
        "memory_read",
        "knowledge_search",
        "web_search",
        "browser_navigate",
    ):
        assert required in registered, (
            f"Worker pipeline.tool_registry missing {required!r}. "
            f"Got: {sorted(registered)}"
        )


def test_vtuber_pipeline_registry_excludes_browser_tools() -> None:
    """The VTuber env filters ``browser_*`` at the manifest level
    (:func:`_vtuber_tool_roster`). Even when the provider can supply
    ``browser_navigate``, the pipeline's tool_registry must not
    contain it — the manifest never declared the name so the
    registration walk never asks for it."""
    from geny_executor.core.pipeline import Pipeline

    from service.environment.templates import create_vtuber_env

    manifest = create_vtuber_env(all_tool_names=_REPRESENTATIVE_ROSTER)
    provider = _FakeProvider(_REPRESENTATIVE_ROSTER)

    pipeline = Pipeline.from_manifest(
        manifest,
        api_key="sk-test",
        strict=False,
        adhoc_providers=[provider],
    )

    registered = set(pipeline.tool_registry.list_names())

    # Platform tools present
    assert "geny_send_direct_message" in registered, sorted(registered)
    assert "memory_read" in registered, sorted(registered)
    # Conversational web tools present
    assert "web_search" in registered, sorted(registered)
    # Browser tools filtered out
    for name in registered:
        assert not name.startswith("browser_"), (
            f"VTuber pipeline registered browser tool: {name}. "
            f"Full set: {sorted(registered)}"
        )


def test_worker_pipeline_registry_empty_when_provider_missing() -> None:
    """Smoke-guard on the failure mode the defect caused in production.

    Before PR #1 the boot path wired ``get_custom_names()`` into the
    worker env *and* passed ``GenyToolProvider(loader)`` — the provider
    could supply every name, but the manifest only declared custom
    ones, so platform tools were absent from the registry. This test
    models the inverse: a manifest that declares platform tools with
    *no* provider supplying them must produce an empty registry
    (every name skipped with a warning), not silently fall back to
    some other source. Demonstrates that ``.external`` + providers is
    the only path that matters."""
    from geny_executor.core.pipeline import Pipeline

    from service.environment.templates import create_worker_env

    manifest = create_worker_env(
        external_tool_names=["geny_send_direct_message", "memory_read"]
    )
    pipeline = Pipeline.from_manifest(
        manifest, api_key="sk-test", strict=False, adhoc_providers=[]
    )

    registered = set(pipeline.tool_registry.list_names())
    assert registered == set(), (
        "With no provider, manifest names must be skipped — not resolved "
        f"from elsewhere. Got: {sorted(registered)}"
    )


def test_worker_pipeline_registers_zero_tools_when_roster_empty() -> None:
    """A worker manifest built with ``external_tool_names=[]`` must
    register zero tools, even when the provider could supply many.
    The pipeline does not fabricate a default roster from the
    provider's catalog — ``.external`` is authoritative."""
    from geny_executor.core.pipeline import Pipeline

    from service.environment.templates import create_worker_env

    manifest = create_worker_env(external_tool_names=[])
    pipeline = Pipeline.from_manifest(
        manifest,
        api_key="sk-test",
        strict=False,
        adhoc_providers=[_FakeProvider(_REPRESENTATIVE_ROSTER)],
    )
    assert pipeline.tool_registry.list_names() == []


def test_vtuber_pipeline_registers_legacy_three_when_called_without_roster() -> None:
    """VTuber factory has a back-compat fallback: an empty / missing
    ``all_tool_names`` falls through to the legacy three-web-tool
    roster (``web_search``, ``news_search``, ``web_fetch``). Lock
    this in so callers that haven't adopted the new signature yet
    continue to work — the test_templates unit test covers the
    manifest-level assertion; this one confirms it survives the
    full pipeline construction path."""
    from geny_executor.core.pipeline import Pipeline

    from service.environment.templates import create_vtuber_env

    manifest = create_vtuber_env()
    pipeline = Pipeline.from_manifest(
        manifest,
        api_key="sk-test",
        strict=False,
        adhoc_providers=[_FakeProvider(_REPRESENTATIVE_ROSTER)],
    )
    assert set(pipeline.tool_registry.list_names()) == {
        "web_search",
        "news_search",
        "web_fetch",
    }
