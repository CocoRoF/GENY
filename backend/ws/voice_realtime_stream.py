"""WebSocket endpoint for the realtime voice conversation loop (additive).

Full-duplex audio channel Geny didn't have before — all existing TTS/STT
transport is HTTP. This route is the ONLY entry point to
:mod:`service.voice_realtime`; nothing in the existing chat/TTS/STT paths
imports it.

Protocol (JSON text frames; audio is base64 inside JSON for one uniform
channel — binary frames also accepted for the uplink):

  Client → Server
    {"type":"start", "language":"", "voice_profile":null}
    {"type":"utterance", "audio_b64":"<b64>", "format":"webm"}   # or binary frame
    {"type":"speech_started"}                                    # barge-in signal
    {"type":"text", "text":"..."}                                # typed fallback
    {"type":"ping"}

  Server → Client
    {"type":"ready"}
    {"type":"transcript", "data":{"text":..., "final":true}}
    {"type":"turn_start", "data":{"turn":N}}
    {"type":"assistant_text", "data":{"text":..., "emotion":..., "turn":N}}
    {"type":"audio", "data":{"turn":T, "seq":N, "audio_b64":..., "sample_rate":..,"format":"wav"}}
    {"type":"turn_end", "data":{"turn":N, "sentences":K}}
    {"type":"cancelled", "data":{"turn":N}}
    {"type":"error", "data":{"error":...}}
    {"type":"heartbeat", "data":{"ts":...}}
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from logging import getLogger

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from service.auth.auth_middleware import ws_auth_or_close
from service.voice_realtime.session import RealtimeVoiceSession

logger = getLogger(__name__)

router = APIRouter()

_HEARTBEAT_S = 20.0


@router.websocket("/ws/voice/realtime/{session_id}")
async def ws_voice_realtime(websocket: WebSocket, session_id: str):
    """One realtime voice call bound to a Geny agent session."""
    logger.info("[VoiceRT:%s] connection attempt", session_id[:8])

    auth = await ws_auth_or_close(websocket)
    if auth is None:
        logger.info("[VoiceRT:%s] rejected (unauthorized)", session_id[:8])
        return
    await websocket.accept(subprotocol=auth.subprotocol)

    # Resolve the persona's emotion→expression map so realtime TTS emotion
    # matches the avatar's configured emotions (falls back to the standard
    # set inside RealtimeVoiceSession when unavailable).
    emotion_map = None
    try:
        app_state = websocket.app.state
        mm = getattr(app_state, "live2d_model_manager", None)
        if mm is not None:
            model = mm.get_agent_model(session_id)
            if model is not None:
                emotion_map = getattr(model, "emotionMap", None)
    except Exception:  # noqa: BLE001
        logger.debug("[VoiceRT:%s] emotion map resolve failed", session_id[:8], exc_info=True)

    send_lock = asyncio.Lock()

    async def emit(event_type: str, data: dict) -> None:
        # Single writer guard — turn loop + heartbeat both send.
        async with send_lock:
            await websocket.send_json({"type": event_type, "data": data})

    voice = RealtimeVoiceSession(session_id, emit, emotion_map=emotion_map)
    disconnected = asyncio.Event()

    async def _heartbeat() -> None:
        try:
            while not disconnected.is_set():
                await asyncio.sleep(_HEARTBEAT_S)
                try:
                    await emit("heartbeat", {"ts": time.time()})
                except Exception:  # noqa: BLE001
                    disconnected.set()
                    return
        except asyncio.CancelledError:
            pass

    hb_task = asyncio.create_task(_heartbeat())

    try:
        await emit("ready", {"session_id": session_id})
        while not disconnected.is_set():
            try:
                raw = await websocket.receive()
            except (WebSocketDisconnect, RuntimeError):
                break

            if raw.get("type") == "websocket.disconnect":
                break

            # Binary uplink. In server_vad mode it's a raw 16 kHz PCM stream
            # chunk (server detects end-of-speech); in client_vad mode it's a
            # complete utterance blob (browser already segmented it).
            if raw.get("bytes") is not None:
                if voice._input_mode == "server_vad":  # noqa: SLF001
                    await voice.on_audio_frame(raw["bytes"])
                else:
                    await voice.on_utterance(raw["bytes"], fmt="webm")
                continue

            text = raw.get("text")
            if not text:
                continue
            try:
                msg = json.loads(text)
            except (ValueError, json.JSONDecodeError):
                continue

            await _dispatch(voice, msg, emit)

    except Exception:  # noqa: BLE001
        logger.warning("[VoiceRT:%s] loop error", session_id[:8], exc_info=True)
    finally:
        disconnected.set()
        hb_task.cancel()
        try:
            await hb_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        await voice.close()
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        logger.info("[VoiceRT:%s] closed", session_id[:8])


async def _dispatch(voice: RealtimeVoiceSession, msg: dict, emit) -> None:
    mtype = msg.get("type", "")
    if mtype == "start":
        # Reconfigure language / voice / input mode for this call.
        lang = msg.get("language")
        if lang is not None:
            voice._language = lang  # noqa: SLF001 — controlled reconfigure
        vp = msg.get("voice_profile")
        if vp is not None:
            voice._voice_profile = vp  # noqa: SLF001
        mode = msg.get("input_mode")
        if mode in ("server_vad", "client_vad"):
            voice.configure(input_mode=mode)
        if isinstance(msg.get("stt_only"), bool):
            voice.configure(stt_only=msg["stt_only"])
        if isinstance(msg.get("partials"), bool):
            voice.configure(partials=msg["partials"])
        await emit(
            "ready",
            {
                "reconfigured": True,
                "input_mode": voice._input_mode,  # noqa: SLF001
                "stt_only": voice._stt_only,  # noqa: SLF001
                "partials": voice._partials_enabled,  # noqa: SLF001
            },
        )
    elif mtype == "speech_started":
        await voice.on_speech_started()
    elif mtype == "utterance":
        b64 = msg.get("audio_b64") or ""
        if b64:
            try:
                audio = base64.b64decode(b64)
            except Exception:  # noqa: BLE001
                return
            await voice.on_utterance(audio, fmt=msg.get("format", "webm"))
    elif mtype == "text":
        t = (msg.get("text") or "").strip()
        if t:
            await voice.on_text(t)
    elif mtype == "ping":
        await emit("pong", {"ts": time.time()})
