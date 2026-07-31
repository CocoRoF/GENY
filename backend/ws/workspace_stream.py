"""``/ws/workspace/{session_id}`` — thin change-notification channel for
workspace sync replicas (desktop connectors on any number of PCs).

Protocol (server envelope ``{type, data}`` like every other Geny WS):

  client → ``{type:"hello", data:{device_id, device_name?, cursor?}}``
  server → ``{type:"state", data:{latest_seq, devices:[...]}}``
  server → ``{type:"changed", data:{latest_seq}}``   (on workspace writes)
  either → ``{type:"heartbeat", ts}``                 (idle keepalive)

Deliberately THIN: the socket only says "something moved past seq N" —
replicas pull the actual delta over ``GET /storage/changes?since=``.
That keeps multi-device fan-out trivial and loss-tolerant (a missed
frame is healed by the next poll or reconnect).

Unlike the connector capability bridge (one-connection-per-session,
last-writer-wins), this registry holds a SET of connections per session
— the whole point is several PCs at once.

While replicas are connected, a light poll loop runs the throttled
incremental rescan so agent-driven writes (executor tools, GAPT) are
noticed within seconds without hooking the executor.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from service.auth.auth_middleware import ws_auth_or_close

router = APIRouter()
logger = logging.getLogger(__name__)

_HEARTBEAT_S = 20.0
_AGENT_SCAN_S = 3.0  # how often connected replicas force an index refresh


@dataclass(eq=False)  # identity hash — instances live in per-session sets
class _Device:
    ws: WebSocket
    device_id: str
    device_name: str
    user: str
    connected_at: float = field(default_factory=time.time)


class WorkspaceHub:
    """Per-process registry: session_id → set of replica connections +
    one asyncio.Event used as the change signal (chat-WS pattern)."""

    def __init__(self) -> None:
        self._devices: Dict[str, Set[_Device]] = {}
        self._events: Dict[str, asyncio.Event] = {}
        self._latest: Dict[str, int] = {}
        self._watches: Dict[str, tuple] = {}

    def event_for(self, session_id: str) -> asyncio.Event:
        ev = self._events.get(session_id)
        if ev is None:
            ev = self._events[session_id] = asyncio.Event()
        return ev

    def add(self, session_id: str, dev: _Device, storage_path: str = "") -> None:
        self._devices.setdefault(session_id, set()).add(dev)
        if storage_path:
            self._ensure_watch(session_id, storage_path)

    def remove(self, session_id: str, dev: _Device) -> None:
        devs = self._devices.get(session_id)
        if devs:
            devs.discard(dev)
            if not devs:
                self._devices.pop(session_id, None)
                self._stop_watch(session_id)

    # ── inotify watch (watchfiles) — real-time agent-write detection ──
    #
    # One watcher task per session while ANY replica is connected. Events
    # trigger the throttled incremental rescan; seq movement → notify.
    # watchfiles unavailable → the connection loop's slow poll covers it.

    def _ensure_watch(self, session_id: str, storage_path: str) -> None:
        if session_id in self._watches:
            return
        try:
            from watchfiles import awatch  # noqa: F401
        except ImportError:
            return
        stop = asyncio.Event()
        task = asyncio.create_task(self._watch_loop(session_id, storage_path, stop))
        self._watches[session_id] = (task, stop)

    def _stop_watch(self, session_id: str) -> None:
        entry = self._watches.pop(session_id, None)
        if entry:
            task, stop = entry
            stop.set()
            task.cancel()

    def watch_active(self, session_id: str) -> bool:
        return session_id in self._watches

    async def _watch_loop(self, session_id: str, storage_path: str,
                          stop: asyncio.Event) -> None:
        from pathlib import Path

        from watchfiles import awatch

        from service.utils import workspace_sync

        ws_dir = Path(storage_path) / "workspace"
        ws_dir.mkdir(parents=True, exist_ok=True)
        try:
            async for _changes in awatch(
                ws_dir, stop_event=stop, debounce=400, step=100,
            ):
                stats = await asyncio.to_thread(
                    workspace_sync.refresh_index, storage_path, session_id
                )
                seq = int(stats.get("latest_seq", 0))
                if seq > (self._latest.get(session_id) or 0):
                    self.notify(session_id, seq)
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # noqa: BLE001
            logger.info("[WorkspaceWS:%s] watch loop ended: %s", session_id[:8], exc)
            self._watches.pop(session_id, None)

    def devices(self, session_id: str) -> List[dict]:
        return [
            {
                "device_id": d.device_id,
                "device_name": d.device_name,
                "user": d.user,
                "connected_at": d.connected_at,
            }
            for d in self._devices.get(session_id, set())
        ]

    def has_devices(self, session_id: str) -> bool:
        return bool(self._devices.get(session_id))

    def notify(self, session_id: str, latest_seq: Optional[int] = None) -> None:
        """Signal every connected replica. Safe from any coroutine on the
        main loop; no-op when nobody listens."""
        if latest_seq is not None:
            self._latest[session_id] = latest_seq
        ev = self._events.get(session_id)
        if ev is not None:
            ev.set()

    def latest(self, session_id: str) -> Optional[int]:
        return self._latest.get(session_id)


_hub = WorkspaceHub()


def get_workspace_hub() -> WorkspaceHub:
    return _hub


def notify_workspace_changed(session_id: str, latest_seq: Optional[int] = None) -> None:
    """Fire-and-forget change signal — call after any workspace write."""
    _hub.notify(session_id, latest_seq)


async def _send(ws: WebSocket, type_: str, data: dict) -> None:
    await ws.send_text(json.dumps({"type": type_, "data": data}, ensure_ascii=False))


@router.websocket("/ws/workspace/{session_id}")
async def workspace_ws(websocket: WebSocket, session_id: str) -> None:
    auth = await ws_auth_or_close(websocket)
    if auth is None:
        return
    # Same posture as the connector bridge: replicas write into the
    # workspace, so anonymous is refused even in no-DB mode.
    user = (auth.payload or {}).get("sub")
    if user in (None, "", "anonymous"):
        await websocket.close(code=4401)
        return

    # Resolve the storage root (live or dormant) up front — 4404 if the
    # session doesn't exist.
    from controller.agent_controller import _storage_root_live_or_dormant

    try:
        storage_path = _storage_root_live_or_dormant(session_id)
    except Exception:
        await websocket.close(code=4404)
        return

    await websocket.accept(subprotocol=auth.subprotocol)

    from service.utils import workspace_sync

    try:
        hello = json.loads(await websocket.receive_text())
    except (WebSocketDisconnect, ValueError):
        return
    data = hello.get("data") or {} if isinstance(hello, dict) else {}
    dev = _Device(
        ws=websocket,
        device_id=str(data.get("device_id") or "unknown")[:64],
        device_name=str(data.get("device_name") or "")[:64],
        user=str(user),
    )
    _hub.add(session_id, dev, storage_path)
    event = _hub.event_for(session_id)
    logger.info("[WorkspaceWS:%s] replica %s (%s) connected",
                session_id[:8], dev.device_id[:8], dev.device_name)

    async def _refresh() -> int:
        stats = await asyncio.to_thread(
            workspace_sync.refresh_index, storage_path, session_id
        )
        return int(stats.get("latest_seq", 0))

    try:
        latest = await _refresh()
        await _send(websocket, "state", {
            "latest_seq": latest,
            "devices": _hub.devices(session_id),
        })

        # Reader task: replicas only ever send heartbeats (and may close).
        async def _reader() -> None:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(msg, dict) and msg.get("type") == "heartbeat":
                    await _send(websocket, "heartbeat", {"ts": msg.get("ts")})

        reader = asyncio.create_task(_reader())
        last_scan = time.monotonic()
        last_beat = time.monotonic()
        try:
            while True:
                if reader.done():
                    reader.result()  # surface disconnect
                    break
                # Primary agent-write signal is the inotify watcher; the
                # poll is a slow belt-and-braces (fast only as fallback).
                scan_interval = 30.0 if _hub.watch_active(session_id) else _AGENT_SCAN_S
                try:
                    await asyncio.wait_for(event.wait(), timeout=min(scan_interval, _AGENT_SCAN_S))
                    event.clear()
                    latest = _hub.latest(session_id) or await _refresh()
                    await _send(websocket, "changed", {"latest_seq": latest})
                    last_beat = time.monotonic()
                except asyncio.TimeoutError:
                    # Poll for agent-driven writes the watcher might miss.
                    if time.monotonic() - last_scan >= scan_interval:
                        last_scan = time.monotonic()
                        new_latest = await _refresh()
                        if new_latest > latest:
                            latest = new_latest
                            _hub.notify(session_id, new_latest)
                            # own event fires next iteration for ALL replicas
                            continue
                    if time.monotonic() - last_beat >= _HEARTBEAT_S:
                        last_beat = time.monotonic()
                        await _send(websocket, "heartbeat", {"ts": time.time()})
        finally:
            reader.cancel()
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.info("[WorkspaceWS:%s] closed: %s", session_id[:8], exc)
    finally:
        _hub.remove(session_id, dev)
        logger.info("[WorkspaceWS:%s] replica %s disconnected",
                    session_id[:8], dev.device_id[:8])
