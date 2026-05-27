"""
Pydantic models for ``POST /api/voice-studio/synth/preview``.

The Voice Studio Synthesize card exposes the full OmniVoice parameter
surface. Unlike the chat-path :meth:`OmniVoiceEngine.synthesize_stream`,
which applies adaptive ``num_step`` and config defaults automatically,
the preview path forwards the user-supplied values verbatim — the user
dials in exactly what they want.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

from pydantic import BaseModel, Field

GenerationMode = Literal["clone", "design", "auto"]
AudioFormat = Literal["wav", "mp3", "ogg", "pcm"]


class PreviewParams(BaseModel):
    """Request body for the Synthesize card."""

    text: str = Field(..., min_length=1, max_length=2000)
    profile: Optional[str] = None
    emotion: Optional[str] = "neutral"
    mode: GenerationMode = "clone"
    instruct: Optional[str] = None
    language: Optional[str] = None  # ISO code or empty (= auto-detect)

    # Generation parameters — None means "fall back to OmniVoiceConfig default".
    speed: float = Field(default=1.0, gt=0.0, le=4.0)
    duration_seconds: Optional[float] = Field(default=None, gt=0.0)
    num_step: Optional[int] = Field(default=None, ge=1, le=128)
    guidance_scale: Optional[float] = Field(default=None, ge=0.0, le=10.0)
    denoise: Optional[bool] = None
    auto_asr: Optional[bool] = None
    seed: Optional[int] = Field(default=None, ge=0)

    # Wire format.
    audio_format: AudioFormat = "wav"
    sample_rate: Optional[int] = Field(default=None, ge=8000, le=48000)


@dataclass(slots=True)
class PreviewResult:
    """Engine response wrapper used by the router to populate headers."""

    audio_bytes: bytes
    sample_rate: int
    rtf: float
    seed_used: Optional[int]
    duration: float
