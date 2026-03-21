"""
Chat Controller

Provides:
  - Chat room CRUD (create, list, get, update, delete)
  - Fire-and-forget broadcast — agent processing runs in background, results
    are persisted independently of client connection
  - Reconnectable SSE event stream — clients subscribe to new messages and
    can reconnect at any time without losing data
  - Message history persistence — all messages are stored and restorable
"""
import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from logging import getLogger
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from starlette.responses import StreamingResponse

from service.chat.conversation_store import get_chat_store
from service.langgraph import get_agent_session_manager

logger = getLogger(__name__)

router = APIRouter(prefix="/api/chat", tags=["chat"])

agent_manager = get_agent_session_manager()


# ============================================================================
# Background Broadcast Tracking
# ============================================================================

@dataclass
class BroadcastState:
    """Tracks a single in-flight broadcast."""
    broadcast_id: str
    room_id: str
    total: int
    completed: int = 0
    responded: int = 0
    finished: bool = False
    started_at: float = field(default_factory=time.time)


# room_id → BroadcastState for the currently active broadcast
_active_broadcasts: Dict[str, BroadcastState] = {}
# room_id → asyncio.Event signalling "new message was saved"
_room_new_msg_events: Dict[str, asyncio.Event] = {}


def _notify_room(room_id: str):
    """Signal all SSE listeners that a new message appeared for this room."""
    ev = _room_new_msg_events.get(room_id)
    if ev:
        ev.set()


def _get_room_event(room_id: str) -> asyncio.Event:
    """Get-or-create the notification event for a room."""
    if room_id not in _room_new_msg_events:
        _room_new_msg_events[room_id] = asyncio.Event()
    return _room_new_msg_events[room_id]


# ============================================================================
# Request / Response Models
# ============================================================================

# ── Room models ──

class CreateRoomRequest(BaseModel):
    name: str = Field(..., description="Chat room display name")
    session_ids: List[str] = Field(..., description="Session IDs to include")


class UpdateRoomRequest(BaseModel):
    name: Optional[str] = None
    session_ids: Optional[List[str]] = None


class RoomResponse(BaseModel):
    id: str
    name: str
    session_ids: List[str]
    created_at: str
    updated_at: str
    message_count: int


class RoomListResponse(BaseModel):
    rooms: List[RoomResponse]
    total: int


# ── Message models ──

class MessageResponse(BaseModel):
    model_config = {"extra": "ignore"}  # ignore unexpected keys from storage

    id: str
    type: str  # 'user' | 'agent' | 'system'
    content: str
    timestamp: str
    session_id: Optional[str] = None
    session_name: Optional[str] = None
    role: Optional[str] = None
    duration_ms: Optional[int] = None


class MessageListResponse(BaseModel):
    room_id: str
    messages: List[MessageResponse]
    total: int


# ── Broadcast models ──

class RoomBroadcastRequest(BaseModel):
    message: str = Field(..., description="Chat message to send")


# ============================================================================
# Room CRUD Endpoints
# ============================================================================

@router.get("/rooms", response_model=RoomListResponse)
async def list_rooms():
    """List all chat rooms (sorted by last activity)."""
    store = get_chat_store()
    rooms = store.list_rooms()
    return RoomListResponse(
        rooms=[RoomResponse(**r) for r in rooms],
        total=len(rooms),
    )


@router.post("/rooms", response_model=RoomResponse)
async def create_room(request: CreateRoomRequest):
    """Create a new chat room with selected sessions."""
    store = get_chat_store()
    room = store.create_room(name=request.name, session_ids=request.session_ids)
    return RoomResponse(**room)


@router.get("/rooms/{room_id}", response_model=RoomResponse)
async def get_room(room_id: str):
    """Get a single chat room by ID."""
    store = get_chat_store()
    room = store.get_room(room_id)
    if not room:
        raise HTTPException(status_code=404, detail=f"Room not found: {room_id}")
    return RoomResponse(**room)


@router.patch("/rooms/{room_id}", response_model=RoomResponse)
async def update_room(room_id: str, request: UpdateRoomRequest):
    """Update a chat room (name and/or sessions)."""
    store = get_chat_store()
    room = store.get_room(room_id)
    if not room:
        raise HTTPException(status_code=404, detail=f"Room not found: {room_id}")

    if request.name is not None:
        store.update_room_name(room_id, request.name)
    if request.session_ids is not None:
        store.update_room_sessions(room_id, request.session_ids)

    updated = store.get_room(room_id)
    return RoomResponse(**updated)


@router.delete("/rooms/{room_id}")
async def delete_room(room_id: str):
    """Delete a chat room and all its history."""
    store = get_chat_store()
    deleted = store.delete_room(room_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Room not found: {room_id}")
    return {"success": True, "room_id": room_id}


# ============================================================================
# Message History Endpoint
# ============================================================================

@router.get("/rooms/{room_id}/messages", response_model=MessageListResponse)
async def get_room_messages(room_id: str):
    """Get all messages for a chat room (for history restoration)."""
    store = get_chat_store()
    room = store.get_room(room_id)
    if not room:
        raise HTTPException(status_code=404, detail=f"Room not found: {room_id}")

    raw_messages = store.get_messages(room_id)
    messages: List[MessageResponse] = []
    for m in raw_messages:
        try:
            messages.append(MessageResponse(**m))
        except Exception as e:
            logger.warning("Skipping malformed message %s: %s", m.get("id", "?"), e)

    return MessageListResponse(
        room_id=room_id,
        messages=messages,
        total=len(messages),
    )


# ============================================================================
# Room-Scoped Broadcast Endpoint (Fire-and-Forget)
# ============================================================================

def _sse_event(event_type: str, data: Any) -> str:
    """Format a single SSE event."""
    payload = json.dumps(data, ensure_ascii=False, default=str)
    return f"event: {event_type}\ndata: {payload}\n\n"


@router.post("/rooms/{room_id}/broadcast")
async def broadcast_to_room(room_id: str, request: RoomBroadcastRequest):
    """
    Send a message to all sessions in a chat room.

    Processing is fire-and-forget — agent results are persisted in the
    background regardless of whether any client is connected.  Clients
    subscribe to live updates via GET /rooms/{room_id}/events.

    Returns the saved user message immediately.
    """
    store = get_chat_store()
    room = store.get_room(room_id)
    if not room:
        raise HTTPException(status_code=404, detail=f"Room not found: {room_id}")

    # 1. Save user message
    try:
        user_msg = store.add_message(room_id, {
            "type": "user",
            "content": request.message,
        })
    except Exception as e:
        logger.error("Failed to save user message: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to save message: {e}")

    _notify_room(room_id)

    # 2. Resolve alive agents
    all_agents = agent_manager.list_agents()
    room_session_ids = set(room["session_ids"])
    target_agents = [
        a for a in all_agents
        if a.session_id in room_session_ids and a.is_alive()
    ]

    if not target_agents:
        sys_msg = store.add_message(room_id, {
            "type": "system",
            "content": "No active sessions in this room.",
        })
        _notify_room(room_id)
        return {
            "user_message": user_msg,
            "broadcast_id": None,
            "target_count": 0,
        }

    # 3. Create broadcast state and launch background processing
    broadcast_id = str(uuid.uuid4())
    broadcast_state = BroadcastState(
        broadcast_id=broadcast_id,
        room_id=room_id,
        total=len(target_agents),
    )
    _active_broadcasts[room_id] = broadcast_state

    logger.info(
        "Room %s: broadcast %s → %d sessions: %s",
        room_id, broadcast_id, len(target_agents), request.message[:80],
    )

    # Fire-and-forget background task
    asyncio.create_task(
        _run_broadcast(room_id, broadcast_id, broadcast_state, target_agents, request.message, store)
    )

    return {
        "user_message": user_msg,
        "broadcast_id": broadcast_id,
        "target_count": len(target_agents),
    }


async def _run_broadcast(
    room_id: str,
    broadcast_id: str,
    state: BroadcastState,
    agents: list,
    message: str,
    store,
):
    """Background task — invokes all agents and persists results."""
    start_time = time.time()

    async def _invoke_one(agent):
        session_start = time.time()
        sid = agent.session_id
        sname = agent.session_name
        role = agent.role.value if hasattr(agent.role, 'value') else str(agent.role)

        try:
            session_timeout = getattr(agent, 'timeout', 1800.0)
            result = await asyncio.wait_for(
                agent.invoke(input_text=message, is_chat_message=True),
                timeout=session_timeout,
            )
            result_text = result.get("output", "") if isinstance(result, dict) else str(result)
            duration_ms = int((time.time() - session_start) * 1000)
            has_response = bool(result_text and result_text.strip())

            if has_response:
                store.add_message(room_id, {
                    "type": "agent",
                    "content": result_text.strip(),
                    "session_id": sid,
                    "session_name": sname,
                    "role": role,
                    "duration_ms": duration_ms,
                })
                state.responded += 1
                _notify_room(room_id)
            else:
                logger.debug("Session %s skipped (no output)", sid)

        except asyncio.TimeoutError:
            duration_ms = int((time.time() - session_start) * 1000)
            logger.warning("Broadcast timeout for session %s (%dms)", sid, duration_ms)
            store.add_message(room_id, {
                "type": "system",
                "content": f"{sname}: Timeout after {duration_ms / 1000:.1f}s",
            })
            _notify_room(room_id)

        except asyncio.CancelledError:
            logger.warning("Broadcast cancelled for session %s", sid)

        except Exception as e:
            duration_ms = int((time.time() - session_start) * 1000)
            logger.error("Broadcast error for session %s: %s", sid, e)
            store.add_message(room_id, {
                "type": "system",
                "content": f"{sname}: Error — {str(e)[:200]}",
            })
            _notify_room(room_id)

        finally:
            state.completed += 1

    # Launch all concurrently
    tasks = [asyncio.create_task(_invoke_one(a)) for a in agents]
    await asyncio.gather(*tasks, return_exceptions=True)

    # Summary
    total_duration_ms = int((time.time() - start_time) * 1000)
    try:
        store.add_message(room_id, {
            "type": "system",
            "content": f"{state.responded}/{state.total} sessions responded ({total_duration_ms / 1000:.1f}s)",
        })
        _notify_room(room_id)
    except Exception as e:
        logger.error("Failed to save broadcast summary: %s", e)

    state.finished = True

    logger.info(
        "Room %s: broadcast %s complete: %d/%d responded (%dms)",
        room_id, broadcast_id, state.responded, state.total, total_duration_ms,
    )

    # Cleanup broadcast state after a delay (allow clients to read final state)
    await asyncio.sleep(30)
    if _active_broadcasts.get(room_id) is state:
        del _active_broadcasts[room_id]


# ============================================================================
# Reconnectable SSE Event Stream
# ============================================================================

@router.get("/rooms/{room_id}/events")
async def room_event_stream(
    room_id: str,
    after: Optional[str] = Query(None, description="Last seen message ID — only newer messages will be sent"),
):
    """
    SSE stream of new messages in a room.

    - Reconnectable: pass `after=<last_msg_id>` to resume from where you left off.
    - Sends `message` events for each new message (user, agent, system).
    - Sends `broadcast_status` events with progress info.
    - Sends `heartbeat` events every 5s to keep the connection alive.
    - Sends `broadcast_done` when all agents have finished.

    The stream stays open until the client disconnects.
    """
    store = get_chat_store()
    room = store.get_room(room_id)
    if not room:
        raise HTTPException(status_code=404, detail=f"Room not found: {room_id}")

    async def event_generator():
        last_seen_id = after
        room_event = _get_room_event(room_id)
        heartbeat_interval = 5.0

        # On initial connect: send any messages newer than `after`
        if last_seen_id:
            missed = _get_messages_after(store, room_id, last_seen_id)
            for msg in missed:
                yield _sse_event("message", msg)
                last_seen_id = msg["id"]

        # Send current broadcast status if active
        bstate = _active_broadcasts.get(room_id)
        if bstate and not bstate.finished:
            yield _sse_event("broadcast_status", {
                "broadcast_id": bstate.broadcast_id,
                "total": bstate.total,
                "completed": bstate.completed,
                "responded": bstate.responded,
                "finished": False,
            })

        # Main loop: wait for new messages or heartbeat
        while True:
            room_event.clear()

            # Wait for notification or timeout (heartbeat)
            try:
                await asyncio.wait_for(room_event.wait(), timeout=heartbeat_interval)
            except asyncio.TimeoutError:
                pass
            except asyncio.CancelledError:
                return

            # Check for new messages
            new_msgs = _get_messages_after(store, room_id, last_seen_id)
            for msg in new_msgs:
                yield _sse_event("message", msg)
                last_seen_id = msg["id"]

            # Broadcast status update
            bstate = _active_broadcasts.get(room_id)
            if bstate:
                yield _sse_event("broadcast_status", {
                    "broadcast_id": bstate.broadcast_id,
                    "total": bstate.total,
                    "completed": bstate.completed,
                    "responded": bstate.responded,
                    "finished": bstate.finished,
                })
                if bstate.finished:
                    yield _sse_event("broadcast_done", {
                        "broadcast_id": bstate.broadcast_id,
                        "total": bstate.total,
                        "responded": bstate.responded,
                    })
            elif not new_msgs:
                # No active broadcast, no new messages — just heartbeat
                yield _sse_event("heartbeat", {"ts": time.time()})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _get_messages_after(store, room_id: str, after_id: Optional[str]) -> List[dict]:
    """Return messages in the room that come after the given message ID."""
    all_msgs = store.get_messages(room_id)
    if not after_id:
        return []  # No reference point — return nothing (history was loaded separately)

    # Find the index of after_id
    idx = -1
    for i, m in enumerate(all_msgs):
        if m.get("id") == after_id:
            idx = i
            break

    if idx == -1:
        # after_id not found — return all messages (client may have stale reference)
        return all_msgs

    return all_msgs[idx + 1:]
