"""chain_install.install_affect_tag_emitter (cycle 20260421_9 PR-X3-7).

We stub out the pipeline surface rather than constructing a real one:
the installer only touches ``pipeline.get_stage(EMIT_STAGE_ORDER).emitters.items``
(emit moved 14 → 17 in geny-executor 1.0+), so a minimal fake captures
the contract precisely without dragging in manifest / API-key /
registry machinery.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List

from service.emit import AffectTagEmitter, install_affect_tag_emitter
from service.emit.chain_install import EMIT_STAGE_ORDER


@dataclass
class _FakeChain:
    items: List[Any] = field(default_factory=list)


@dataclass
class _FakeEmitStage:
    emitters: _FakeChain = field(default_factory=_FakeChain)
    name: str = "emit"


class _FakePipeline:
    def __init__(self, stage: Any | None, order: int = EMIT_STAGE_ORDER) -> None:
        self._stage = stage
        self._order = order

    def get_stage(self, order: int) -> Any:
        if order == self._order:
            return self._stage
        return None


class _ExistingEmitter:
    name = "existing"


class _AlreadyAffect:
    name = "affect_tag"


def test_prepends_emitter_to_empty_chain() -> None:
    stage = _FakeEmitStage()
    pipe = _FakePipeline(stage)
    inst = install_affect_tag_emitter(pipe)

    assert isinstance(inst, AffectTagEmitter)
    assert stage.emitters.items == [inst]


def test_prepends_before_existing_emitters() -> None:
    """Ordering matters: affect_tag must strip final_text **before** other
    emitters (vtuber/tts/text) observe it. Plan/04 §4.3."""
    existing = _ExistingEmitter()
    stage = _FakeEmitStage(emitters=_FakeChain(items=[existing]))
    pipe = _FakePipeline(stage)
    inst = install_affect_tag_emitter(pipe)

    assert stage.emitters.items[0] is inst
    assert stage.emitters.items[1] is existing


def test_idempotent_when_affect_already_present() -> None:
    already = _AlreadyAffect()
    stage = _FakeEmitStage(emitters=_FakeChain(items=[already]))
    pipe = _FakePipeline(stage)

    inst = install_affect_tag_emitter(pipe)

    assert inst is None
    assert stage.emitters.items == [already]


def test_returns_none_if_no_emit_stage() -> None:
    pipe = _FakePipeline(None)
    assert install_affect_tag_emitter(pipe) is None


def test_returns_none_if_stage_has_no_emitters_attr() -> None:
    class _BadStage:
        name = "emit"

    pipe = _FakePipeline(_BadStage())
    assert install_affect_tag_emitter(pipe) is None


def test_falls_back_to_private_stages_dict_if_get_stage_missing() -> None:
    """Defensive path: some legacy/test pipelines don't expose
    ``get_stage``. The helper also reads ``._stages`` directly."""

    class _LegacyPipeline:
        def __init__(self, stage: Any) -> None:
            self._stages = {EMIT_STAGE_ORDER: stage}

    stage = _FakeEmitStage()
    inst = install_affect_tag_emitter(_LegacyPipeline(stage))
    assert inst is not None
    assert stage.emitters.items[0] is inst


def test_forwards_max_tags_per_turn_to_emitter() -> None:
    stage = _FakeEmitStage()
    pipe = _FakePipeline(stage)
    inst = install_affect_tag_emitter(pipe, max_tags_per_turn=5)
    assert inst is not None
    assert inst._max_tags_per_turn == 5


def test_emit_stage_order_matches_executor_emit_stage() -> None:
    """Regression guard: EMIT_STAGE_ORDER must equal the actual
    EmitStage class's order property in the installed
    geny-executor. Prevents silent drift when the executor renumbers
    stages (as happened 14 → 17 in Sub-phase 9a)."""
    from geny_executor.stages.s17_emit.artifact.default.stage import EmitStage

    assert EmitStage().order == EMIT_STAGE_ORDER, (
        f"EmitStage().order={EmitStage().order} but EMIT_STAGE_ORDER={EMIT_STAGE_ORDER}; "
        f"update service/emit/chain_install.py:EMIT_STAGE_ORDER to match."
    )


def test_affect_tag_emitter_declares_ordered_chain_hints() -> None:
    """AffectTagEmitter declares ``requires=()`` and
    ``timeout_seconds=None`` so an OrderedEmitterChain wrapper
    (planned executor enhancement) places it correctly without
    further changes here."""
    em = AffectTagEmitter()
    assert em.requires == ()
    assert em.timeout_seconds is None
