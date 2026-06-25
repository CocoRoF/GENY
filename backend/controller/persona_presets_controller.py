"""Persona Presets REST API — the Geny persona builder.

    GET    /api/persona-presets               list (summaries)
    GET    /api/persona-presets/frameworks     MBTI / Enneagram / archetype / axis catalog (for the UI)
    GET    /api/persona-presets/{id}           full preset
    POST   /api/persona-presets               create
    POST   /api/persona-presets/compile        compile a (possibly unsaved) definition → preview prompt
    PUT    /api/persona-presets/{id}           replace
    DELETE /api/persona-presets/{id}           delete

A preset is a structured persona definition (MBTI/Enneagram/archetype + OCEAN +
expressive-style sliders + Korean register + emotion defaults + identity) that
compiles to a persona prompt; an environment opts in via
``host_selections.extras.persona_preset_id``.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from controller.auth_controller import require_auth
from service.persona_presets import (
    PersonaPresetDefinition,
    compile_persona,
    get_persona_preset_store,
    list_frameworks,
)
from service.persona_presets.store import (
    PersonaPresetNameTaken,
    PersonaPresetNotFound,
)

logger = getLogger(__name__)

router = APIRouter(prefix="/api/persona-presets", tags=["persona-presets"])


class PresetSummary(BaseModel):
    id: str
    name: str
    description: str
    mbti: str
    enneagram: str
    archetype: str
    is_template: bool


def _summary(p: PersonaPresetDefinition) -> PresetSummary:
    return PresetSummary(
        id=p.id, name=p.name, description=p.description,
        mbti=p.mbti, enneagram=p.enneagram, archetype=p.archetype,
        is_template=p.is_template,
    )


# ── reads ────────────────────────────────────────────────────────────


@router.get("")
async def list_presets(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    presets = get_persona_preset_store().list_all()
    return {"presets": [_summary(p).model_dump() for p in presets]}


@router.get("/frameworks")
async def get_frameworks(_auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    """MBTI/Enneagram/archetype lists + OCEAN/style axis definitions + emotion
    tags — everything the builder UI needs to render its controls."""
    return list_frameworks()


@router.get("/{preset_id}")
async def get_preset(preset_id: str, _auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    try:
        defn = get_persona_preset_store().get(preset_id)
    except PersonaPresetNotFound:
        raise HTTPException(404, detail={"code": "persona_preset.not_found", "reason": preset_id})
    out = defn.model_dump()
    out["compiled_prompt"] = compile_persona(defn)
    return out


# ── compile (preview, no persistence) ────────────────────────────────


@router.post("/compile")
async def compile_preview(
    defn: PersonaPresetDefinition, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    """Compile a definition the client is editing into its persona prompt — live
    preview without saving."""
    text = compile_persona(defn)
    return {"compiled_prompt": text, "char_count": len(text)}


# ── writes ───────────────────────────────────────────────────────────


@router.post("")
async def create_preset(
    defn: PersonaPresetDefinition, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    defn.is_template = False  # user-created presets are never templates
    try:
        saved = get_persona_preset_store().create(defn.normalized())
    except PersonaPresetNameTaken:
        raise HTTPException(409, detail={"code": "persona_preset.name_taken", "reason": defn.name})
    out = saved.model_dump()
    out["compiled_prompt"] = compile_persona(saved)
    return out


@router.put("/{preset_id}")
async def update_preset(
    preset_id: str, defn: PersonaPresetDefinition, _auth: dict = Depends(require_auth)
) -> Dict[str, Any]:
    store = get_persona_preset_store()
    try:
        existing = store.get(preset_id)
    except PersonaPresetNotFound:
        raise HTTPException(404, detail={"code": "persona_preset.not_found", "reason": preset_id})
    # Editing a built-in template forks it into a user preset (keep id stable).
    defn.is_template = False if existing.is_template else defn.is_template
    try:
        saved = store.replace(preset_id, defn.normalized())
    except PersonaPresetNameTaken:
        raise HTTPException(409, detail={"code": "persona_preset.name_taken", "reason": defn.name})
    out = saved.model_dump()
    out["compiled_prompt"] = compile_persona(saved)
    return out


@router.delete("/{preset_id}")
async def delete_preset(preset_id: str, _auth: dict = Depends(require_auth)) -> Dict[str, Any]:
    try:
        get_persona_preset_store().delete(preset_id)
    except PersonaPresetNotFound:
        raise HTTPException(404, detail={"code": "persona_preset.not_found", "reason": preset_id})
    return {"ok": True, "id": preset_id}
