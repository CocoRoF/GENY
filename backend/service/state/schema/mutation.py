"""Mutation protocol — stages append ``Mutation`` entries to a buffer
which the pipeline wrapper commits through the provider after a turn.

Only four ops are allowed:

- ``add``    — delta on a numeric path (e.g. ``vitals.hunger``)
- ``set``    — absolute value on any path
- ``append`` — push onto a list path (e.g. ``recent_events``)
- ``event``  — record a semantic tag (aggregation only)

``remove`` / ``delete`` are deliberately excluded — rollbacks are a
provider-level (transactional) concern, not a mutation-level one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, List, Literal, Optional, Tuple

MutationOp = Literal["add", "set", "append", "event"]


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class Mutation:
    op: MutationOp
    path: str
    value: Any
    source: str
    at: datetime = field(default_factory=_utcnow)
    note: Optional[str] = None


class MutationBuffer:
    """Ordered, append-only collector of ``Mutation`` entries.

    Order matters: ``apply`` replays in append order, so an ``add +2``
    followed by a ``set 50`` on the same path yields 50, not 52.
    """

    __slots__ = ("_items",)

    def __init__(self) -> None:
        self._items: List[Mutation] = []

    def append(
        self,
        *,
        op: MutationOp,
        path: str,
        value: Any,
        source: str,
        note: Optional[str] = None,
    ) -> Mutation:
        m = Mutation(
            op=op,
            path=path,
            value=value,
            source=source,
            at=datetime.now(timezone.utc),
            note=note,
        )
        self._items.append(m)
        return m

    @property
    def items(self) -> Tuple[Mutation, ...]:
        return tuple(self._items)

    def __len__(self) -> int:
        return len(self._items)

    def __iter__(self):
        return iter(self._items)

    def __bool__(self) -> bool:
        return bool(self._items)
