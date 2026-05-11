"""
VTuber Controller

REST API endpoints for:
- Live2D model CRUD and listing
- Agent-model assignment
- Avatar state queries
- Touch interaction events
- Manual emotion override (debugging/demo)

Avatar state streaming is handled by ws/avatar_stream.py (WebSocket).
"""

import asyncio
import json
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
from logging import getLogger

logger = getLogger(__name__)

router = APIRouter(prefix="/api/vtuber", tags=["vtuber"])


def _inject_character_prompt(session_id: str, model_name: str) -> None:
    """Stage a per-model character prompt through the PersonaProvider.

    Replaces the legacy ``agent._system_prompt`` append (cycle 20260421_7
    PR-X1-3). The provider owns file caching and duplicate-write
    suppression; the pipeline picks up the change on the next turn via
    ``DynamicPersonaSystemBuilder``.
    """
    try:
        from service.executor import get_agent_session_manager
        manager = get_agent_session_manager()
        agent = manager.get_agent(session_id)
        if not agent or getattr(agent, '_session_type', None) != 'vtuber':
            return
        manager.persona_provider.set_character(session_id, model_name)
        logger.info(
            f"[{session_id}] Character persona staged via PersonaProvider "
            f"(model={model_name})"
        )
    except Exception as e:
        logger.debug(f"Character prompt injection failed: {e}", exc_info=True)


# ── Request/Response Models ──────────────────────────────────


class ModelAssignRequest(BaseModel):
    model_name: str


class InteractRequest(BaseModel):
    hit_area: str  # "HitAreaHead", "HitAreaBody"
    x: Optional[float] = None
    y: Optional[float] = None


class EmotionOverrideRequest(BaseModel):
    emotion: str
    intensity: float = 1.0
    transition_ms: int = 300


# ── Model Management ────────────────────────────────────────


@router.get("/models")
async def list_models(request: Request):
    """List all registered Live2D models."""
    manager = request.app.state.live2d_model_manager
    models = manager.list_models()
    return {"models": [m.to_dict() for m in models]}


@router.get("/models/stream")
async def stream_models(request: Request) -> StreamingResponse:
    """Server-sent stream that emits a `models_changed` event every
    time the model registry mutates. Frontend subscribes once and
    re-fetches `/api/vtuber/models` on each notification so the
    dropdown reflects auto-publish renames / installs / deletes
    without polling.

    Implementation: subscribe a per-connection asyncio.Queue to the
    manager's listener set, drain it as SSE events. A keepalive
    comment goes out every 25s so intermediaries (nginx, browsers)
    don't time out idle connections.
    """
    manager = request.app.state.live2d_model_manager
    queue = manager.subscribe_changes()

    async def gen():
        # Initial connect frame — comment line, treated as a no-op
        # event by EventSource. Tells the browser the stream is live
        # and triggers any onopen handler.
        yield ": connected\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    return
                try:
                    await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield 'data: {"event":"models_changed"}\n\n'
                except asyncio.TimeoutError:
                    # Keepalive comment so connection stays open
                    # through proxies that drop idle streams.
                    yield ": keepalive\n\n"
        finally:
            manager.unsubscribe_changes(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Nginx-specific; harmless on other proxies.
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/models/{name}")
async def get_model(name: str, request: Request):
    """Get details for a specific Live2D model."""
    manager = request.app.state.live2d_model_manager
    model = manager.get_model(name)
    if not model:
        raise HTTPException(404, f"Model not found: {name}")
    return model.to_dict()


# ── Agent-Model Assignment ──────────────────────────────────


@router.put("/agents/{session_id}/model")
async def assign_model(session_id: str, req: ModelAssignRequest, request: Request):
    """Assign a Live2D model to an agent session."""
    manager = request.app.state.live2d_model_manager
    try:
        manager.assign_model_to_agent(session_id, req.model_name)
    except ValueError as e:
        raise HTTPException(400, str(e))

    # Register per-model emotion→motion mapping if available
    model = manager.get_model(req.model_name)
    if model and hasattr(request.app.state, "avatar_state_manager"):
        state_manager = request.app.state.avatar_state_manager
        # Always register the puppet's actual idle group name so the
        # state manager's fallback can substitute it for the hardcoded
        # "Idle" placeholder when no explicit emotion→motion mapping
        # exists for a given emotion.
        idle_group_name = model.idleMotionGroupName or ""
        if idle_group_name and idle_group_name.strip():
            state_manager.set_session_idle_group(session_id, idle_group_name)
        # `model.emotionMotionMap` is "really" populated only if at least
        # one entry maps to a non-blank group name. Old/legacy installs
        # baked before the empty-group-key fix (#13) may have stored
        # `{"joy": "", "anger": "", ...}`, which is non-empty as a dict
        # but useless at runtime — every emotion would resolve to the
        # blank string and motion() calls would silently fail.
        registry_map_usable = bool(model.emotionMotionMap) and any(
            isinstance(v, str) and v.strip() for v in model.emotionMotionMap.values()
        )
        if registry_map_usable:
            state_manager.set_emotion_motion_map(session_id, model.emotionMotionMap)
        elif idle_group_name and idle_group_name.strip():
            # No explicit emotion→motion mapping registered (this is the
            # case for every existing model_registry.json entry — none of
            # them carry emotionMotionMap, only freshly baked imports do).
            # Without one, the state manager would fall through to
            # `_DEFAULT_EMOTION_MOTION` whose joy/anger/surprise rows
            # name "TapBody" — a Cubism convention that doesn't hold for
            # custom puppets that only define an idle group. Routing
            # everything to the puppet's idle group is a safe default:
            # the motion always exists and plays, even if the visual
            # variety is reduced.
            state_manager.set_emotion_motion_map(
                session_id,
                {
                    emo: idle_group_name
                    for emo in (
                        "neutral",
                        "joy",
                        "anger",
                        "disgust",
                        "fear",
                        "sadness",
                        "surprise",
                        "smirk",
                    )
                },
            )

    # Inject per-model character prompt into VTuber system prompt
    _inject_character_prompt(session_id, req.model_name)

    return {"status": "ok", "session_id": session_id, "model_name": req.model_name}


@router.get("/agents/{session_id}/model")
async def get_agent_model(session_id: str, request: Request):
    """Get the model currently assigned to an agent session."""
    manager = request.app.state.live2d_model_manager
    model = manager.get_agent_model(session_id)
    if not model:
        return {"session_id": session_id, "model": None}
    return {"session_id": session_id, "model": model.to_dict()}


@router.delete("/agents/{session_id}/model")
async def unassign_model(session_id: str, request: Request):
    """Remove model assignment from an agent session."""
    manager = request.app.state.live2d_model_manager
    manager.unassign_model(session_id)
    return {"status": "ok", "session_id": session_id}


@router.get("/assignments")
async def list_assignments(request: Request):
    """List all agent-model assignments."""
    manager = request.app.state.live2d_model_manager
    return {"assignments": manager.get_all_assignments()}


# ── Avatar State ────────────────────────────────────────────


@router.get("/agents/{session_id}/state")
async def get_avatar_state(session_id: str, request: Request):
    """Get current avatar display state for a session."""
    state_manager = request.app.state.avatar_state_manager
    state = state_manager.get_state(session_id)
    return state.to_sse_data()


# ── Touch Interaction ───────────────────────────────────────


@router.post("/agents/{session_id}/interact")
async def interact_with_avatar(
    session_id: str, req: InteractRequest, request: Request
):
    """Handle touch/click interaction with the Live2D avatar."""
    model_manager = request.app.state.live2d_model_manager
    state_manager = request.app.state.avatar_state_manager

    model = model_manager.get_agent_model(session_id)
    if not model:
        raise HTTPException(404, "No model assigned to this session")

    # Look up tap motion for the hit area
    tap_motions = model.tapMotions.get(req.hit_area, {})
    if tap_motions:
        motion_index = list(tap_motions.values())[0]
        motion_group = "TapBody" if "Body" in req.hit_area else "TapHead"
        await state_manager.update_state(
            session_id=session_id,
            motion_group=motion_group,
            motion_index=motion_index,
            trigger="user_interact",
        )

    return {"status": "ok", "hit_area": req.hit_area}


# ── Emotion Override (Debug/Demo) ───────────────────────────


@router.post("/agents/{session_id}/emotion")
async def override_emotion(
    session_id: str, req: EmotionOverrideRequest, request: Request
):
    """
    Manually set avatar emotion (for debugging and demo purposes).
    Maps the emotion name to the model's emotionMap index.
    """
    model_manager = request.app.state.live2d_model_manager
    state_manager = request.app.state.avatar_state_manager

    model = model_manager.get_agent_model(session_id)
    if not model:
        raise HTTPException(404, "No model assigned to this session")

    emotion_map = model.emotionMap
    expression_index = emotion_map.get(req.emotion, 0)

    await state_manager.update_state(
        session_id=session_id,
        emotion=req.emotion,
        expression_index=expression_index,
        intensity=req.intensity,
        transition_ms=req.transition_ms,
        trigger="manual_override",
    )

    return {
        "status": "ok",
        "emotion": req.emotion,
        "expression_index": expression_index,
    }
