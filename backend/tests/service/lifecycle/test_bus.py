"""SessionLifecycleBus contract tests (plan/01 §5)."""

from __future__ import annotations

import asyncio
import time

import pytest

from service.lifecycle import (
    LifecycleEvent,
    LifecyclePayload,
    SessionLifecycleBus,
)


@pytest.mark.asyncio
async def test_emit_fires_subscribed_handler() -> None:
    bus = SessionLifecycleBus()
    received: list[LifecyclePayload] = []

    async def handler(payload: LifecyclePayload) -> None:
        received.append(payload)

    bus.subscribe(LifecycleEvent.SESSION_CREATED, handler)
    await bus.emit(LifecycleEvent.SESSION_CREATED, "sid-1", role="worker")

    assert len(received) == 1
    p = received[0]
    assert p.event is LifecycleEvent.SESSION_CREATED
    assert p.session_id == "sid-1"
    assert p.meta == {"role": "worker"}


@pytest.mark.asyncio
async def test_subscribe_all_fires_for_every_event() -> None:
    bus = SessionLifecycleBus()
    seen: list[LifecycleEvent] = []

    async def handler(payload: LifecyclePayload) -> None:
        seen.append(payload.event)

    bus.subscribe_all(handler)
    for ev in LifecycleEvent:
        await bus.emit(ev, "sid")
    assert seen == list(LifecycleEvent)


@pytest.mark.asyncio
async def test_multiple_handlers_invoked_in_registration_order() -> None:
    bus = SessionLifecycleBus()
    order: list[str] = []

    async def h1(_: LifecyclePayload) -> None:
        order.append("h1")

    async def h2(_: LifecyclePayload) -> None:
        order.append("h2")

    async def h3(_: LifecyclePayload) -> None:
        order.append("h3")

    bus.subscribe(LifecycleEvent.SESSION_IDLE, h1)
    bus.subscribe(LifecycleEvent.SESSION_IDLE, h2)
    bus.subscribe(LifecycleEvent.SESSION_IDLE, h3)
    await bus.emit(LifecycleEvent.SESSION_IDLE, "sid")
    assert order == ["h1", "h2", "h3"]


@pytest.mark.asyncio
async def test_unsubscribe_removes_handler() -> None:
    bus = SessionLifecycleBus()
    calls = 0

    async def handler(_: LifecyclePayload) -> None:
        nonlocal calls
        calls += 1

    token = bus.subscribe(LifecycleEvent.SESSION_DELETED, handler)
    await bus.emit(LifecycleEvent.SESSION_DELETED, "sid")
    assert calls == 1
    bus.unsubscribe(token)
    await bus.emit(LifecycleEvent.SESSION_DELETED, "sid")
    assert calls == 1


@pytest.mark.asyncio
async def test_unsubscribe_all_token_works() -> None:
    bus = SessionLifecycleBus()
    calls = 0

    async def handler(_: LifecyclePayload) -> None:
        nonlocal calls
        calls += 1

    token = bus.subscribe_all(handler)
    await bus.emit(LifecycleEvent.SESSION_CREATED, "sid")
    assert calls == 1
    bus.unsubscribe(token)
    await bus.emit(LifecycleEvent.SESSION_CREATED, "sid")
    assert calls == 1


@pytest.mark.asyncio
async def test_handler_exception_does_not_break_subsequent_handlers() -> None:
    bus = SessionLifecycleBus()
    downstream_called = False

    async def bad(_: LifecyclePayload) -> None:
        raise RuntimeError("boom")

    async def good(_: LifecyclePayload) -> None:
        nonlocal downstream_called
        downstream_called = True

    bus.subscribe(LifecycleEvent.SESSION_REVIVED, bad)
    bus.subscribe(LifecycleEvent.SESSION_REVIVED, good)
    await bus.emit(LifecycleEvent.SESSION_REVIVED, "sid")
    assert downstream_called is True


@pytest.mark.asyncio
async def test_emit_without_subscribers_is_noop() -> None:
    bus = SessionLifecycleBus()
    # No subscribers for any event; emit must not raise.
    for ev in LifecycleEvent:
        await bus.emit(ev, "sid")


@pytest.mark.asyncio
async def test_emit_fills_when_timestamp() -> None:
    bus = SessionLifecycleBus()
    captured: list[LifecyclePayload] = []

    async def handler(payload: LifecyclePayload) -> None:
        captured.append(payload)

    bus.subscribe(LifecycleEvent.SESSION_ABANDONED, handler)
    before = time.time()
    await bus.emit(LifecycleEvent.SESSION_ABANDONED, "sid")
    after = time.time()
    assert before <= captured[0].when <= after


@pytest.mark.asyncio
async def test_meta_is_passed_through() -> None:
    bus = SessionLifecycleBus()
    captured: list[LifecyclePayload] = []

    async def handler(payload: LifecyclePayload) -> None:
        captured.append(payload)

    bus.subscribe(LifecycleEvent.SESSION_PAIRED, handler)
    await bus.emit(
        LifecycleEvent.SESSION_PAIRED,
        "vtuber-1",
        vtuber_id="vtuber-1",
        worker_id="worker-2",
    )
    assert captured[0].meta == {
        "vtuber_id": "vtuber-1",
        "worker_id": "worker-2",
    }


@pytest.mark.asyncio
async def test_copy_on_write_during_emit() -> None:
    """Subscribing a new handler mid-emission must not affect the current dispatch."""
    bus = SessionLifecycleBus()
    late_called = False

    async def late(_: LifecyclePayload) -> None:
        nonlocal late_called
        late_called = True

    async def adder(_: LifecyclePayload) -> None:
        bus.subscribe(LifecycleEvent.SESSION_CREATED, late)

    bus.subscribe(LifecycleEvent.SESSION_CREATED, adder)
    await bus.emit(LifecycleEvent.SESSION_CREATED, "sid")
    assert late_called is False  # registered after snapshot
    # Next emission sees the newly-added handler.
    await bus.emit(LifecycleEvent.SESSION_CREATED, "sid")
    assert late_called is True


@pytest.mark.asyncio
async def test_sync_handler_rejected() -> None:
    bus = SessionLifecycleBus()

    def sync_handler(_: LifecyclePayload) -> None:
        pass

    with pytest.raises(TypeError, match="async function"):
        bus.subscribe(LifecycleEvent.SESSION_CREATED, sync_handler)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_handlers_awaited_sequentially() -> None:
    """Registration-order guarantee must hold even when handlers yield."""
    bus = SessionLifecycleBus()
    order: list[str] = []

    async def first(_: LifecyclePayload) -> None:
        await asyncio.sleep(0.01)
        order.append("first")

    async def second(_: LifecyclePayload) -> None:
        order.append("second")

    bus.subscribe(LifecycleEvent.SESSION_IDLE, first)
    bus.subscribe(LifecycleEvent.SESSION_IDLE, second)
    await bus.emit(LifecycleEvent.SESSION_IDLE, "sid")
    assert order == ["first", "second"]
