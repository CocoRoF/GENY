"""
``GET /api/voice-studio/events`` — Server-Sent Events stream of
Voice Studio runtime events (currently: batch.* progress).

Single-process pub/sub; see ``service/voice_studio/event_bus.py``.
"""

from __future__ import annotations

import asyncio
import json
from logging import getLogger

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from service.voice_studio.event_bus import get_event_bus

router = APIRouter()
logger = getLogger(__name__)


@router.get("/events")
async def stream_events(request: Request) -> StreamingResponse:
    bus = get_event_bus()
    queue = bus.subscribe()

    async def gen():
        # Initial handshake — lets the client know the channel is open
        # even before any real event lands.
        yield 'event: hello\ndata: {"ok":true}\n\n'
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"event: message\ndata: {json.dumps(item, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    # Keepalive comment so reverse proxies don't drop the conn.
                    yield ": keepalive\n\n"
        finally:
            bus.unsubscribe(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )
