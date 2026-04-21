"""Pure mutation application — shared by all provider implementations.

The provider stack is thin: storage ↔ JSON blob ↔ dataclass. Everything
*interesting* (which op mutates which path, how the ring buffer trims,
what happens on an unknown op) lives here so implementations don't drift.
"""

from __future__ import annotations

import copy
from dataclasses import is_dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

from ..schema.creature_state import CreatureState
from ..schema.mutation import Mutation
from .interface import RECENT_EVENTS_MAX


def _resolve_parent(state: CreatureState, path: str) -> tuple[Any, str]:
    """Return ``(parent_obj, leaf_attr)`` for a dotted path.

    ``path="vitals.hunger"`` → ``(state.vitals, "hunger")``.
    ``path="recent_events"`` → ``(state, "recent_events")``.
    """
    parts = path.split(".")
    if not parts or parts == [""]:
        raise ValueError(f"empty path not supported for this op: {path!r}")
    obj: Any = state
    for p in parts[:-1]:
        if not hasattr(obj, p):
            raise KeyError(f"unknown path segment {p!r} in {path!r}")
        obj = getattr(obj, p)
    leaf = parts[-1]
    if not hasattr(obj, leaf):
        raise KeyError(f"unknown leaf {leaf!r} in {path!r}")
    return obj, leaf


def _apply_add(state: CreatureState, path: str, value: Any) -> None:
    parent, leaf = _resolve_parent(state, path)
    current = getattr(parent, leaf)
    if not isinstance(current, (int, float)):
        raise TypeError(
            f"add op requires numeric target, got {type(current).__name__} at {path!r}"
        )
    if not isinstance(value, (int, float)):
        raise TypeError(
            f"add op requires numeric delta, got {type(value).__name__}"
        )
    setattr(parent, leaf, float(current) + float(value))


def _apply_set(state: CreatureState, path: str, value: Any) -> None:
    parent, leaf = _resolve_parent(state, path)
    setattr(parent, leaf, value)


def _apply_append(state: CreatureState, path: str, value: Any) -> None:
    parent, leaf = _resolve_parent(state, path)
    target = getattr(parent, leaf)
    if not isinstance(target, list):
        raise TypeError(
            f"append op requires list target, got {type(target).__name__} at {path!r}"
        )
    target.append(value)
    # Trim ring buffer on the well-known recent_events path.
    if parent is state and leaf == "recent_events":
        overflow = len(target) - RECENT_EVENTS_MAX
        if overflow > 0:
            del target[:overflow]


def _apply_event(state: CreatureState, value: Any) -> None:
    # event op: push a semantic tag onto recent_events regardless of path.
    # plan/02 §2.3 example uses empty path — we tolerate anything.
    tag = value if isinstance(value, str) else str(value)
    state.recent_events.append(tag)
    overflow = len(state.recent_events) - RECENT_EVENTS_MAX
    if overflow > 0:
        del state.recent_events[:overflow]


def apply_mutations(
    snapshot: CreatureState,
    mutations: Sequence[Mutation],
    *,
    now: datetime | None = None,
) -> CreatureState:
    """Return a new ``CreatureState`` with ``mutations`` replayed in order.

    Input ``snapshot`` is not touched — work happens on a deep copy so a
    partial failure (e.g. unknown op) can be raised to the caller without
    leaving half-applied state.

    ``last_interaction_at`` is bumped to ``now`` (defaulting to UTC now)
    only when at least one mutation lands. Empty mutation list = no-op.
    """
    if not isinstance(snapshot, CreatureState) or not is_dataclass(snapshot):
        raise TypeError("apply_mutations requires a CreatureState instance")
    if not mutations:
        return snapshot  # fast path — caller keeps the same instance

    new_state = copy.deepcopy(snapshot)
    for m in mutations:
        if m.op == "add":
            _apply_add(new_state, m.path, m.value)
        elif m.op == "set":
            _apply_set(new_state, m.path, m.value)
        elif m.op == "append":
            _apply_append(new_state, m.path, m.value)
        elif m.op == "event":
            _apply_event(new_state, m.value)
        else:
            raise ValueError(f"unknown mutation op: {m.op!r}")

    new_state.last_interaction_at = now or datetime.now(timezone.utc)
    return new_state


def mutation_sources(mutations: Iterable[Mutation]) -> list[str]:
    return [m.source for m in mutations]
