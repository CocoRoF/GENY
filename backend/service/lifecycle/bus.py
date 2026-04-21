"""Async pub/sub bus for session lifecycle events.

Design decisions (see plan/01 §2):
- Handlers are async-only; use ``asyncio.iscoroutinefunction`` check.
- Handlers per event are invoked sequentially in registration order —
  ordering is observable and downstream handlers may depend on the
  side-effects of earlier ones.
- An exception in one handler is logged and isolated; subsequent
  handlers still fire.
- ``subscribe`` / ``unsubscribe`` are safe to call during an in-flight
  ``emit`` — the event dispatch snapshots the handler list before
  iterating (copy-on-write).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .events import LifecycleEvent, LifecyclePayload

logger = logging.getLogger(__name__)

Handler = Callable[[LifecyclePayload], Awaitable[None]]


class SubscriptionToken:
    __slots__ = ("_id", "_event")

    def __init__(self, event: Optional[LifecycleEvent]) -> None:
        self._id = uuid.uuid4().hex
        self._event = event  # None = subscribe_all

    @property
    def event(self) -> Optional[LifecycleEvent]:
        return self._event

    def __repr__(self) -> str:
        scope = self._event.value if self._event else "*"
        return f"<SubscriptionToken {scope}:{self._id[:8]}>"

    def __hash__(self) -> int:
        return hash(self._id)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, SubscriptionToken) and other._id == self._id


class SessionLifecycleBus:
    def __init__(self) -> None:
        self._per_event: Dict[LifecycleEvent, List[_Registration]] = {
            ev: [] for ev in LifecycleEvent
        }
        self._catch_all: List[_Registration] = []

    def subscribe(
        self, event: LifecycleEvent, handler: Handler
    ) -> SubscriptionToken:
        _ensure_async(handler)
        token = SubscriptionToken(event)
        self._per_event[event] = self._per_event[event] + [
            _Registration(token, handler)
        ]
        return token

    def subscribe_all(self, handler: Handler) -> SubscriptionToken:
        _ensure_async(handler)
        token = SubscriptionToken(None)
        self._catch_all = self._catch_all + [_Registration(token, handler)]
        return token

    def unsubscribe(self, token: SubscriptionToken) -> None:
        if token.event is None:
            self._catch_all = [r for r in self._catch_all if r.token != token]
            return
        bucket = self._per_event[token.event]
        self._per_event[token.event] = [r for r in bucket if r.token != token]

    async def emit(
        self,
        event: LifecycleEvent,
        session_id: str,
        **meta: Any,
    ) -> None:
        payload = LifecyclePayload(
            event=event,
            session_id=session_id,
            when=time.time(),
            meta=dict(meta),
        )
        handlers = self._per_event[event] + self._catch_all
        for reg in handlers:
            try:
                await reg.handler(payload)
            except Exception:
                logger.exception(
                    "lifecycle handler raised for event=%s session_id=%s "
                    "handler=%s",
                    event.value,
                    session_id,
                    reg.handler,
                )


class _Registration:
    __slots__ = ("token", "handler")

    def __init__(self, token: SubscriptionToken, handler: Handler) -> None:
        self.token = token
        self.handler = handler


def _ensure_async(handler: Handler) -> None:
    if not asyncio.iscoroutinefunction(handler):
        raise TypeError(
            "SessionLifecycleBus handler must be an async function; "
            f"got {handler!r}"
        )
