"""Creature state layer — long-lived per-character game state (X3).

Cycle 20260421_9 introduces ``CreatureState`` as an **external wrapper**
around the pipeline — hydrated before ``pipeline.run`` and persisted after.
Stages mutate state by appending ``Mutation`` entries to a buffer on
``state.shared``; the wrapper commits them atomically through a
``CreatureStateProvider``.

See ``dev_docs/20260421_6/plan/02_creature_state_contract.md`` for the
full contract; this package is layered as:

- ``schema/`` — pure dataclasses (this PR-X3-1).
- ``provider/`` — storage protocol + sqlite impl (PR-X3-2).
- ``registry`` / ``hydrator`` — pipeline integration (PR-X3-3).
- ``decay`` — TickEngine handler (PR-X3-4).
"""

from __future__ import annotations

from .schema import (
    SCHEMA_VERSION,
    Bond,
    CreatureState,
    MoodVector,
    Mutation,
    MutationBuffer,
    MutationOp,
    Progression,
    Vitals,
)

__all__ = [
    "SCHEMA_VERSION",
    "Bond",
    "CreatureState",
    "MoodVector",
    "Mutation",
    "MutationBuffer",
    "MutationOp",
    "Progression",
    "Vitals",
]
