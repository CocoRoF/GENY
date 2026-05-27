"""
``POST /api/voice-studio/synth/save-as-ref`` — promote a stored
synthesis result into a voice profile's reference-audio slot.

Equivalent to ``GET .../synth/history/{id}/audio`` + ``POST
/api/tts/profiles/{name}/ref`` rolled into one server-side hop. The
copy preserves the existing ``static/voices/<profile>/profile.json``
schema by reusing the same helpers ``tts_controller.upload_reference_audio``
uses (``_atomic_write_json`` + ``_migrate_emotion_refs`` + template
guard) so callers see the result through the existing
``GET /api/tts/profiles`` contract.
"""

from __future__ import annotations

import json
import shutil
from logging import getLogger
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from service.voice_studio.history_store import get_history_store

router = APIRouter()
logger = getLogger(__name__)


# Mirrors the ``valid_emotions`` set in ``tts_controller.upload_reference_audio``.
EMOTIONS = ("neutral", "joy", "anger", "sadness", "fear", "surprise", "disgust", "smirk")


class SaveAsRefRequest(BaseModel):
    history_id: str = Field(..., min_length=1)
    profile: str = Field(..., min_length=1)
    emotion: Literal[
        "neutral", "joy", "anger", "sadness", "fear", "surprise", "disgust", "smirk"
    ]
    prompt_text: Optional[str] = None
    prompt_lang: Optional[str] = None


@router.post("/synth/save-as-ref")
async def save_as_ref(body: SaveAsRefRequest) -> dict:
    # Late imports to keep the controller package's import graph cheap.
    from controller.tts_controller import (
        VOICES_DIR,
        _atomic_write_json,
        _ensure_builtin_profiles,
        _guard_template,
        _migrate_emotion_refs,
    )

    # 1) Path-traversal guard (same shape as upload_reference_audio).
    if "/" in body.profile or "\\" in body.profile or ".." in body.profile:
        raise HTTPException(status_code=400, detail="Invalid profile name")

    _ensure_builtin_profiles()

    profile_dir: Path = VOICES_DIR / body.profile
    if not profile_dir.exists() or not profile_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Profile '{body.profile}' not found")

    # 2) Block template profiles.
    _guard_template(body.profile)

    # 3) Resolve the history wav.
    store = get_history_store()
    src = store.audio_path(body.history_id)
    if not src:
        raise HTTPException(status_code=404, detail=f"history id not found: {body.history_id}")

    # 4) Copy bytes into the profile's ref slot.
    dst = profile_dir / f"ref_{body.emotion}.wav"
    try:
        shutil.copyfile(src, dst)
    except OSError as e:
        logger.exception("save-as-ref copy failed")
        raise HTTPException(status_code=500, detail=f"copy failed: {e}") from e

    # 5) Update profile.json's emotion_refs entry (same fields as upload route).
    profile_json = profile_dir / "profile.json"
    data: dict = {}
    if profile_json.exists():
        try:
            data = json.loads(profile_json.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("name", body.profile)
    data.setdefault("display_name", body.profile)
    data.setdefault("language", body.prompt_lang or "ko")
    data.setdefault("emotion_refs", {})

    # Fallback prompt_text from the stored history row, when caller omitted it.
    if not body.prompt_text:
        row = store.get(body.history_id)
        fallback_text = (row or {}).get("text") or data.get("prompt_text", "")
    else:
        fallback_text = body.prompt_text

    ref_entry = {
        "file": dst.name,
        "prompt_text": fallback_text or "",
        "prompt_lang": body.prompt_lang or data.get("prompt_lang") or "ko",
    }
    data["emotion_refs"][body.emotion] = ref_entry
    _migrate_emotion_refs(data)
    _atomic_write_json(profile_json, data)

    logger.info(
        "voice-studio save-as-ref: history=%s → %s/%s (bytes=%d)",
        body.history_id, body.profile, body.emotion, dst.stat().st_size,
    )
    return {
        "ok": True,
        "profile": body.profile,
        "emotion": body.emotion,
        "file": dst.name,
        "bytes": dst.stat().st_size,
    }
