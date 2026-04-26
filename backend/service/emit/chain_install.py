"""Install :class:`AffectTagEmitter` onto a prebuilt pipeline's emit chain.

The executor composes the emit chain from manifest declarations; its
registry only knows the four default emitters (text/callback/vtuber/tts).
Rather than forking that registry or extending the manifest schema,
Geny installs the affect emitter into the already-built pipeline — a
tiny, explicit boundary that keeps the executor oblivious to
CreatureState concerns.

Placement: **prepended** so its ``final_text`` rewrite (tag strip) is
visible to any later emitter (vtuber / tts / text) in the same chain.

Stage order updated for geny-executor 1.0+ — emit moved 14 → 17 in
the 21-stage layout (Sub-phase 9a). The order constant is exported
and asserted in chain_install tests so a future renumber surfaces
loudly.

The :class:`AffectTagEmitter` declares ``requires=()`` and
``timeout_seconds=None`` so an :class:`OrderedEmitterChain`
wrapper (planned in a follow-up executor enhancement) can place it
correctly without further changes here.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from service.emit.affect_tag_emitter import (
    DEFAULT_MAX_TAG_MUTATIONS_PER_TURN,
    AffectTagEmitter,
)

logger = logging.getLogger(__name__)

# geny-executor 1.0+ Sub-phase 9a: emit moved 14 → 17.
EMIT_STAGE_ORDER: int = 17


def _resolve_max_tags(default: int) -> int:
    """G.3 (cycle 20260426_2) — read ``settings.json:affect.max_tags_per_turn``,
    fall back to the supplied default. Same coercion as the other
    settings-section readers across the cycle."""
    try:
        from geny_executor.settings import get_default_loader
    except ImportError:
        return default
    section = get_default_loader().get_section("affect")
    if section is None:
        return default
    if hasattr(section, "model_dump"):
        section_dict = section.model_dump(exclude_none=True)
    elif isinstance(section, dict):
        section_dict = section
    else:
        return default
    raw = section_dict.get("max_tags_per_turn")
    if isinstance(raw, int) and raw >= 0:
        return raw
    return default


def install_affect_tag_emitter(
    pipeline: Any,
    *,
    max_tags_per_turn: Optional[int] = None,
) -> Optional[AffectTagEmitter]:
    """Prepend an :class:`AffectTagEmitter` onto the pipeline's s14 chain.

    Returns the emitter instance on success, or ``None`` if the pipeline
    has no emit stage (e.g. a custom manifest dropped it) or the chain
    already contains one — callers treat ``None`` as "nothing to do".

    The helper is idempotent: calling it twice on the same pipeline
    adds at most one emitter.

    G.3 (cycle 20260426_2): when ``max_tags_per_turn`` is left as
    ``None`` we read it from ``settings.json:affect.max_tags_per_turn``
    (falling back to the executor's
    ``DEFAULT_MAX_TAG_MUTATIONS_PER_TURN``). Callers can still override
    by passing an explicit int.
    """
    if max_tags_per_turn is None:
        max_tags_per_turn = _resolve_max_tags(DEFAULT_MAX_TAG_MUTATIONS_PER_TURN)
    stage = _get_emit_stage(pipeline)
    if stage is None:
        logger.debug(
            "install_affect_tag_emitter: pipeline has no stage at order %d; skipping",
            EMIT_STAGE_ORDER,
        )
        return None

    chain = getattr(stage, "emitters", None)
    if chain is None or not hasattr(chain, "items"):
        logger.debug(
            "install_affect_tag_emitter: stage %r has no emitters chain; skipping",
            getattr(stage, "name", type(stage).__name__),
        )
        return None

    for existing in chain.items:
        if getattr(existing, "name", None) == "affect_tag":
            logger.debug(
                "install_affect_tag_emitter: chain already has an affect_tag emitter; skipping"
            )
            return None

    emitter = AffectTagEmitter(max_tags_per_turn=max_tags_per_turn)
    chain.items.insert(0, emitter)
    logger.info(
        "install_affect_tag_emitter: prepended (chain now: %s)",
        [getattr(e, "name", type(e).__name__) for e in chain.items],
    )
    return emitter


def _get_emit_stage(pipeline: Any) -> Any:
    getter = getattr(pipeline, "get_stage", None)
    if callable(getter):
        return getter(EMIT_STAGE_ORDER)
    stages = getattr(pipeline, "_stages", None)
    if isinstance(stages, dict):
        return stages.get(EMIT_STAGE_ORDER)
    return None
