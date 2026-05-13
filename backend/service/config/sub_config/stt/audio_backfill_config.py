"""
Audio Transcript Backfill Configuration.

Background loop that walks every user's Opsidian inbox, finds audio
notes whose body is missing the auto-prepended ``> **Transcript (…):**``
block (because the W2 PostCaptureHook hadn't shipped yet at capture
time, or the Whisper service was momentarily unavailable), and fills
them in one by one.

Defaults are conservative — the loop sleeps long enough between
transcriptions that it never out-prioritises a live capture request:
vLLM serialises whisper jobs on the single GPU and our retry path
should yield to the user-driven flow.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class AudioBackfillConfig(BaseConfig):
    """Settings for the inbox audio-transcript backfill loop."""

    # ── Loop ────────────────────────────────────────────────────────
    enabled: bool = True

    # Seconds to sleep between transcription attempts while there are
    # still notes to process. Short enough that a fresh deploy fills
    # the existing backlog within minutes, long enough that a live
    # capture upload always wins the GPU race.
    idle_seconds: float = 30.0

    # Seconds to sleep when the latest scan found nothing missing.
    # Keeps the loop cheap once the vault is fully transcribed.
    empty_sleep_seconds: float = 300.0

    # Max number of notes to process per cycle. vLLM single-replica
    # throughput is the real throttle; this is a belt-and-braces cap
    # so a bug never bursts the GPU.
    max_per_cycle: int = 1

    @classmethod
    def get_config_name(cls) -> str:
        return "stt_audio_backfill"

    @classmethod
    def get_display_name(cls) -> str:
        return "Audio Backfill"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Idle background loop that fills missing transcripts on "
            "existing inbox audio notes (cleans up audio shared before "
            "Whisper was available, or after a service blip)."
        )

    @classmethod
    def get_category(cls) -> str:
        return "stt"

    @classmethod
    def get_icon(cls) -> str:
        return "refresh-cw"

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="enabled",
                field_type=FieldType.BOOLEAN,
                label="Enabled",
                description=(
                    "Run the inbox audio backfill loop in the "
                    "background. Disable if you want manual control "
                    "via POST /api/stt/backfill."
                ),
                group="loop",
            ),
            ConfigField(
                name="idle_seconds",
                field_type=FieldType.NUMBER,
                label="Idle delay (s)",
                description=(
                    "Sleep between backfills while there are still "
                    "notes to process. Keeps live captures ahead "
                    "in the GPU queue."
                ),
                group="loop",
                min_value=5.0,
                max_value=600.0,
            ),
            ConfigField(
                name="empty_sleep_seconds",
                field_type=FieldType.NUMBER,
                label="Empty-scan sleep (s)",
                description=(
                    "Sleep when the latest scan found no missing "
                    "transcripts. Five minutes by default."
                ),
                group="loop",
                min_value=10.0,
                max_value=3600.0,
            ),
            ConfigField(
                name="max_per_cycle",
                field_type=FieldType.NUMBER,
                label="Max per cycle",
                description="Belt-and-braces cap on backfills per loop iteration.",
                group="loop",
                min_value=1.0,
                max_value=10.0,
            ),
        ]
