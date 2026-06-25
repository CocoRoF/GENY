"""Persona Presets — a Geny-only structured persona builder.

A preset captures a character's personality as structured data (MBTI / Enneagram /
archetype + OCEAN + expressive-style sliders + Korean speech register + emotion
defaults + identity); :func:`compile_persona` turns it into a persona prompt that
Geny injects into a session's system prompt when an environment opts in via
``host_selections.extras.persona_preset_id``.

Deliberately not in geny-executor — persona authoring is a Geny product feature.
"""

from __future__ import annotations

from service.persona_presets.compiler import compile_persona
from service.persona_presets.frameworks import list_frameworks
from service.persona_presets.models import (
    EmotionDefaults,
    Identity,
    OceanTraits,
    PersonaPresetDefinition,
    SpeechStyle,
    StyleTraits,
)
from service.persona_presets.store import (
    PersonaPresetNameTaken,
    PersonaPresetNotFound,
    PersonaPresetStore,
    get_persona_preset_store,
)
from service.persona_presets.templates import install_persona_templates

__all__ = [
    "PersonaPresetDefinition",
    "OceanTraits",
    "StyleTraits",
    "SpeechStyle",
    "EmotionDefaults",
    "Identity",
    "compile_persona",
    "list_frameworks",
    "PersonaPresetStore",
    "PersonaPresetNotFound",
    "PersonaPresetNameTaken",
    "get_persona_preset_store",
    "install_persona_templates",
]
