"""Lifecycle event types and payload.

The enum is the closed set of events the bus knows about. Payload is
constructed inside ``SessionLifecycleBus.emit`` — subscribers receive it
but never build it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping


class LifecycleEvent(str, Enum):
    """The 7 canonical session lifecycle events.

    Recommended ``meta`` keys per event are documented in
    ``dev_docs/20260421_8/plan/01_bus_contract.md §1``.
    """

    SESSION_CREATED = "session_created"
    SESSION_DELETED = "session_deleted"
    SESSION_RESTORED = "session_restored"
    SESSION_PAIRED = "session_paired"
    SESSION_IDLE = "session_idle"
    SESSION_REVIVED = "session_revived"
    SESSION_ABANDONED = "session_abandoned"


@dataclass(frozen=True)
class LifecyclePayload:
    event: LifecycleEvent
    session_id: str
    when: float
    meta: Mapping[str, Any] = field(default_factory=dict)
