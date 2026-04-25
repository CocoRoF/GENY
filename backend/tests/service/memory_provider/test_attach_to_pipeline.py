"""Unit tests for MemorySessionRegistry.attach_to_pipeline (G3.1).

Verifies the wiring expansion the registry took on after the
geny-executor 1.0 21-stage layout:

* Stage 2 Context (provider attribute)
* Stage 18 Memory (provider attribute, was Stage 15 pre-1.0)
* state.session_runtime.memory_provider — read by Stage 19 Summarize
"""

from __future__ import annotations

from typing import Any, Dict

from service.memory_provider.registry import (
    MemorySessionRegistry,
    _SimpleRuntimeContainer,
)


class _StageWithProvider:
    provider: Any = None


class _StageWithoutProvider:
    """Some stages have no provider slot — attach must skip them silently."""

    pass


class _FakePipeline:
    def __init__(self, stages: Dict[int, Any], runtime: Any = None) -> None:
        self._stages = dict(stages)
        # Mirror Pipeline._attached_session_runtime semantics.
        self._attached_session_runtime = runtime

    def get_stage(self, order: int):
        return self._stages.get(order)


def _provider() -> Any:
    """Tiny provider stand-in. attach_to_pipeline only needs object
    identity so an empty class instance is enough."""
    return object()


# ── Stage 2 wiring ─────────────────────────────────────────────────


def test_attach_writes_provider_to_stage_2() -> None:
    s2 = _StageWithProvider()
    pipe = _FakePipeline({2: s2})
    p = _provider()
    MemorySessionRegistry().attach_to_pipeline(pipe, p)
    assert s2.provider is p


def test_attach_silently_skips_when_stage_2_missing() -> None:
    pipe = _FakePipeline({})  # no stage at order 2
    p = _provider()
    # Must not raise.
    MemorySessionRegistry().attach_to_pipeline(pipe, p)


def test_attach_silently_skips_stage_2_without_provider_attr() -> None:
    pipe = _FakePipeline({2: _StageWithoutProvider()})
    p = _provider()
    MemorySessionRegistry().attach_to_pipeline(pipe, p)


# ── Stage 18 wiring (was 15 pre-1.0) ──────────────────────────────


def test_attach_writes_provider_to_stage_18() -> None:
    s18 = _StageWithProvider()
    pipe = _FakePipeline({18: s18})
    p = _provider()
    MemorySessionRegistry().attach_to_pipeline(pipe, p)
    assert s18.provider is p


def test_attach_silently_skips_when_stage_18_missing() -> None:
    pipe = _FakePipeline({2: _StageWithProvider()})  # no stage 18
    p = _provider()
    # Must not raise; Stage 2 still gets attached.
    MemorySessionRegistry().attach_to_pipeline(pipe, p)


def test_attach_writes_to_both_stages_when_present() -> None:
    s2 = _StageWithProvider()
    s18 = _StageWithProvider()
    pipe = _FakePipeline({2: s2, 18: s18})
    p = _provider()
    MemorySessionRegistry().attach_to_pipeline(pipe, p)
    assert s2.provider is p
    assert s18.provider is p


# ── session_runtime.memory_provider wiring ────────────────────────


def test_attach_creates_runtime_container_when_none() -> None:
    pipe = _FakePipeline({})
    p = _provider()
    MemorySessionRegistry().attach_to_pipeline(pipe, p)
    runtime = pipe._attached_session_runtime
    assert runtime is not None
    assert isinstance(runtime, _SimpleRuntimeContainer)
    assert runtime.memory_provider is p


def test_attach_writes_to_existing_runtime_container() -> None:
    class _HostRuntime:
        memory_provider: Any = None
        # other host-supplied attributes...
        creature_id: str = "c1"

    runtime = _HostRuntime()
    pipe = _FakePipeline({}, runtime=runtime)
    p = _provider()
    MemorySessionRegistry().attach_to_pipeline(pipe, p)
    assert runtime.memory_provider is p
    # Pre-existing host attributes preserved.
    assert runtime.creature_id == "c1"
    # Pipeline runtime ref unchanged (we wrote to the same object).
    assert pipe._attached_session_runtime is runtime


def test_attach_handles_runtime_with_no_memory_provider_slot() -> None:
    """Some host runtimes use __slots__ without memory_provider — attach
    must swallow the AttributeError silently (the host opted out)."""

    class _SlottedRuntime:
        __slots__ = ("creature_id",)

        def __init__(self) -> None:
            self.creature_id = "c1"

    runtime = _SlottedRuntime()
    pipe = _FakePipeline({}, runtime=runtime)
    p = _provider()
    # Must not raise.
    MemorySessionRegistry().attach_to_pipeline(pipe, p)


# ── End-to-end ─────────────────────────────────────────────────────


def test_attach_writes_all_three_targets_on_full_pipeline() -> None:
    s2 = _StageWithProvider()
    s18 = _StageWithProvider()
    pipe = _FakePipeline({2: s2, 18: s18})
    p = _provider()
    MemorySessionRegistry().attach_to_pipeline(pipe, p)
    assert s2.provider is p
    assert s18.provider is p
    assert pipe._attached_session_runtime.memory_provider is p


def test_attach_is_idempotent() -> None:
    """Re-attaching with a new provider replaces the old binding."""
    s18 = _StageWithProvider()
    pipe = _FakePipeline({18: s18})
    p1 = _provider()
    p2 = _provider()
    reg = MemorySessionRegistry()
    reg.attach_to_pipeline(pipe, p1)
    assert s18.provider is p1
    reg.attach_to_pipeline(pipe, p2)
    assert s18.provider is p2
    assert pipe._attached_session_runtime.memory_provider is p2
