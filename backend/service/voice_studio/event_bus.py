"""
Tiny in-memory pub/sub for the Voice Studio SSE channel.

Single-process only — Geny prod runs a single backend container. If
we later scale horizontally this needs Redis pub/sub or similar.

Each subscriber gets its own bounded ``asyncio.Queue`` so a slow
client can't backpressure the publisher; ``publish`` is fire-and-forget
and drops on a full queue.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Set

logger = logging.getLogger(__name__)


class EventBus:
    QUEUE_MAXSIZE = 256

    def __init__(self) -> None:
        self._subscribers: Set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self.QUEUE_MAXSIZE)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    async def publish(self, kind: str, payload: Dict[str, Any]) -> None:
        event = {"kind": kind, "payload": payload}
        # Snapshot the set so concurrent unsubscribe doesn't surprise us.
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("voice-studio event_bus: subscriber queue full, dropping %s", kind)
            except Exception:  # pragma: no cover - defensive
                logger.exception("voice-studio event_bus: publish failed")


_bus: EventBus | None = None


def get_event_bus() -> EventBus:
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus
