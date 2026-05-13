"""
Whisper STT Configuration.

Settings for the in-cluster ``geny-whisper-stt`` service (see
``Geny/whisper-stt/`` + the docker-compose ``audio-local`` profile).
Hosts ``openai/whisper-large-v3`` behind vLLM's OpenAI-compatible
``/v1/audio/transcriptions`` endpoint.

Default config matches the docker-compose service exactly so a fresh
deploy "just works" — no field is required to be filled in by the
operator unless they're overriding the model or pointing to an
external host.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class WhisperConfig(BaseConfig):
    """Whisper STT (vLLM) settings."""

    # ── Server ──────────────────────────────────────────────────────
    enabled: bool = True
    api_url: str = "http://whisper-stt:8001"
    timeout_seconds: float = 120.0

    # ── Model ───────────────────────────────────────────────────────
    # Match the container's WHISPER_MODEL env default. If you swap to
    # whisper-large-v3-turbo for faster inference, change both this
    # field AND the docker-compose env in lockstep.
    model: str = "openai/whisper-large-v3"

    # ── Transcription parameters ────────────────────────────────────
    # Empty = let Whisper auto-detect the spoken language. Override
    # with an ISO 639-1 code (e.g. "ko", "en", "ja") when the audio
    # is reliably one language and detection slows the request.
    language: str = ""

    # vLLM's OpenAI-compatible endpoint supports json | text |
    # verbose_json. We use json (text + language + duration) because
    # the hook needs the language string for the transcript header.
    response_format: str = "json"

    # 0.0 = deterministic decoding (recommended for transcripts).
    # Bump above 0 only if you're chasing diversity in long-form
    # audio with repetitive segments — and even then, 0.2 is plenty.
    temperature: float = 0.0

    @classmethod
    def get_config_name(cls) -> str:
        return "stt_whisper"

    @classmethod
    def get_display_name(cls) -> str:
        return "Whisper STT"

    @classmethod
    def get_description(cls) -> str:
        return (
            "vLLM-hosted openai/whisper-large-v3 transcription service. "
            "Enabled when docker-compose is started with --profile audio-local."
        )

    @classmethod
    def get_category(cls) -> str:
        return "stt"

    @classmethod
    def get_icon(cls) -> str:
        return "mic-vocal"

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="enabled",
                field_type=FieldType.BOOLEAN,
                label="Enabled",
                description=(
                    "Whisper service must be running "
                    "(docker compose --profile audio-local)."
                ),
                group="server",
            ),
            ConfigField(
                name="api_url",
                field_type=FieldType.URL,
                label="API URL",
                description=(
                    "Whisper service URL "
                    "(Docker: http://whisper-stt:8001)"
                ),
                group="server",
                placeholder="http://whisper-stt:8001",
            ),
            ConfigField(
                name="timeout_seconds",
                field_type=FieldType.NUMBER,
                label="HTTP Timeout (s)",
                description=(
                    "Per-request read timeout. Long-form audio (5 min+) "
                    "needs at least 90 s on RTX 5070-class hardware."
                ),
                group="server",
                min_value=10.0,
                max_value=600.0,
            ),
            ConfigField(
                name="model",
                field_type=FieldType.TEXT,
                label="Model",
                description=(
                    "HuggingFace ID. Must match the container's "
                    "WHISPER_MODEL env. Defaults to openai/whisper-large-v3."
                ),
                group="model",
                placeholder="openai/whisper-large-v3",
            ),
            ConfigField(
                name="language",
                field_type=FieldType.TEXT,
                label="Force language",
                description=(
                    "ISO 639-1 code (e.g. 'ko', 'en'). Empty = let "
                    "Whisper auto-detect."
                ),
                group="model",
                placeholder="",
            ),
            ConfigField(
                name="response_format",
                field_type=FieldType.SELECT,
                label="Response format",
                description="vLLM/OpenAI transcription response shape.",
                group="model",
                options=[
                    {"label": "JSON (text + language + duration)", "value": "json"},
                    {"label": "Plain text", "value": "text"},
                    {"label": "Verbose JSON (with segments)", "value": "verbose_json"},
                ],
            ),
            ConfigField(
                name="temperature",
                field_type=FieldType.NUMBER,
                label="Temperature",
                description=(
                    "0.0 = deterministic (recommended). Raise above 0 "
                    "only if you're chasing diversity on long-form audio."
                ),
                group="model",
                min_value=0.0,
                max_value=1.0,
            ),
        ]
