"""Pydantic models for Persona Presets — a Geny-only persona builder.

A Persona Preset is a *structured* description of a character's personality —
MBTI / Enneagram / character-archetype framework picks, OCEAN (Big Five) core
traits, expressive-style sliders, Korean speech register, emotion defaults, and
free-form identity. The :mod:`service.persona_presets.compiler` turns this struct
into a natural-language persona prompt that Geny injects into a session's system
prompt (see ``AgentSessionManager`` ``_env_persona_preset_id``).

This is deliberately NOT in geny-executor: persona authoring is a Geny product
feature, not a general agent-runtime capability.

The whole struct is persisted as one JSONB ``data`` payload (same pattern as
:class:`SandboxToolPackDefinition`), so adding a field never needs a migration.
"""

from __future__ import annotations

import uuid
from typing import List, Optional

from pydantic import BaseModel, Field


def _clamp(v: int) -> int:
    return max(0, min(100, int(v)))


class OceanTraits(BaseModel):
    """Big Five (OCEAN) core personality — the *inner* disposition. 0–100 each."""

    openness: int = 50
    conscientiousness: int = 50
    extraversion: int = 50
    agreeableness: int = 50
    neuroticism: int = 50  # low = emotionally stable; high = sensitive/reactive


class StyleTraits(BaseModel):
    """Expressive-style axes — *how* the persona comes across. 0–100 each."""

    warmth: int = 50          # cold/detached ↔ warm/affectionate
    humor: int = 50           # serious ↔ very funny
    playfulness: int = 50     # composed ↔ teasing/playful
    formality: int = 50       # casual/반말 ↔ formal/존댓말
    assertiveness: int = 50   # soft-spoken ↔ assertive/leading
    verbosity: int = 50       # terse ↔ elaborate
    emoji: int = 50           # no emoticons ↔ heavy emoticon/emoji use
    enthusiasm: int = 50      # calm ↔ high-energy/excitable
    directness: int = 50      # indirect/euphemistic ↔ blunt/direct


class SpeechStyle(BaseModel):
    """Korean-aware speech register + verbal signature."""

    # auto = let the formality slider decide; otherwise force a register.
    # (Named ``honorific`` rather than ``register`` to avoid shadowing
    # ``ABCMeta.register`` on pydantic's BaseModel.)
    honorific: str = "auto"  # auto | banmal | jondaetmal | mixed
    self_reference: str = ""           # how the persona refers to itself (이름/저/나/…)
    catchphrases: List[str] = Field(default_factory=list)
    verbal_tics: List[str] = Field(default_factory=list)  # sentence-enders, habits


class EmotionDefaults(BaseModel):
    """Default affect — ties into the VTuber emotion-tag system (RECOGNIZED_TAGS)."""

    default_mood: str = "neutral"          # one of RECOGNIZED_TAGS
    expressiveness: int = 50               # how strongly emotions surface, 0–100
    preferred_tags: List[str] = Field(default_factory=list)  # subset of RECOGNIZED_TAGS


class Identity(BaseModel):
    """Free-form character identity."""

    display_name: str = ""
    age_vibe: str = ""        # "20대 초반 느낌", "또래 친구", …
    role: str = ""           # "다정한 AI 친구", "츤데레 비서", …
    interests: List[str] = Field(default_factory=list)
    backstory: str = ""      # short free text


class PersonaPresetDefinition(BaseModel):
    """A reusable, structured persona definition."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    name: str
    description: str = ""

    # ── Framework picks (all optional; user fills what they want) ──
    mbti: str = ""            # e.g. "ENFP"
    enneagram: str = ""       # e.g. "7" or "7w8"
    archetype: str = ""       # e.g. "tsundere" (see frameworks.ARCHETYPES)

    # ── Tunable axes ──
    ocean: OceanTraits = Field(default_factory=OceanTraits)
    style: StyleTraits = Field(default_factory=StyleTraits)
    speech: SpeechStyle = Field(default_factory=SpeechStyle)
    emotion: EmotionDefaults = Field(default_factory=EmotionDefaults)
    identity: Identity = Field(default_factory=Identity)

    # If set, this verbatim text is used as the persona prompt instead of the
    # compiled output — lets a power user hand-tune the generated result.
    prompt_override: str = ""

    # Seed presets (MBTI/archetype/… starters) carry is_template=True so the
    # boot installer can skip ones the user already customised.
    is_template: bool = False

    created_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    def normalized(self) -> "PersonaPresetDefinition":
        """Return a copy with all slider values clamped to 0–100."""
        self.ocean = OceanTraits(**{k: _clamp(v) for k, v in self.ocean.model_dump().items()})
        self.style = StyleTraits(**{k: _clamp(v) for k, v in self.style.model_dump().items()})
        self.emotion.expressiveness = _clamp(self.emotion.expressiveness)
        return self


__all__ = [
    "OceanTraits",
    "StyleTraits",
    "SpeechStyle",
    "EmotionDefaults",
    "Identity",
    "PersonaPresetDefinition",
]
