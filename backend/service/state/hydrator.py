"""Free-function wrappers around ``SessionRuntimeRegistry``.

Some call sites only need a one-shot hydrate/persist with an already-
constructed registry; these helpers let them do so without importing the
class directly. Kept intentionally thin — anything interesting belongs
in the registry.
"""

from __future__ import annotations

from typing import Any

from .registry import SessionRuntimeRegistry
from .schema.creature_state import CreatureState


async def hydrate_state(
    state: Any,
    registry: SessionRuntimeRegistry,
) -> CreatureState:
    return await registry.hydrate(state)


async def persist_state(
    state: Any,
    registry: SessionRuntimeRegistry,
) -> CreatureState:
    return await registry.persist(state)
