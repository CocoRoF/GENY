"""
OpenAI TTS Engine — Uses OpenAI's /v1/audio/speech API.

Supports tts-1 (fast) and tts-1-hd (high quality) models
with multiple voice options. Requires API key.
"""

from logging import getLogger
from typing import AsyncIterator, Optional

import httpx

from service.vtuber.tts.base import (
    AudioFormat,
    TTSChunk,
    TTSEngine,
    TTSRequest,
    VoiceInfo,
)

logger = getLogger(__name__)

# Available OpenAI voices
_OPENAI_VOICES = [
    ("alloy", "Alloy", "neutral"),
    ("ash", "Ash", "male"),
    ("coral", "Coral", "female"),
    ("echo", "Echo", "male"),
    ("fable", "Fable", "male"),
    ("nova", "Nova", "female"),
    ("onyx", "Onyx", "male"),
    ("sage", "Sage", "female"),
    ("shimmer", "Shimmer", "female"),
]


class OpenAITTSEngine(TTSEngine):
    """OpenAI TTS engine using /v1/audio/speech endpoint"""

    engine_name = "openai"

    # ── Studio metadata (Phase 3) ───────────────────────────────────
    display_name = "OpenAI TTS"
    sample_rate = 24000
    supported_languages = ["multi"]  # 50+ via tts-1 / tts-1-hd
    gpu_compat = ("cloud",)
    supports_voice_design = False
    supports_clone = False
    license = "OpenAI ToS"

    @staticmethod
    def _resolve_key(config) -> str:
        """Engine-specific key if set, else the central LLM & Provider
        OpenAI key — one paste in settings covers TTS too."""
        key = (config.api_key or "").strip()
        if key:
            return key
        try:
            from service.config.credentials import resolve_provider_key

            return resolve_provider_key("openai")
        except Exception:  # noqa: BLE001
            return ""

    async def is_available(self) -> tuple[bool, str]:
        try:
            from service.config.manager import get_config_manager
            from service.config.sub_config.tts.openai_tts_config import OpenAITTSConfig

            cfg = get_config_manager().load_config(OpenAITTSConfig)
            if not self._resolve_key(cfg):
                return False, "missing OpenAI API key (LLM & Provider settings)"
            return True, "ok"
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"

    async def synthesize_stream(self, request: TTSRequest) -> AsyncIterator[TTSChunk]:
        """Stream audio from OpenAI TTS API"""
        from service.config.manager import get_config_manager
        from service.config.sub_config.tts.openai_tts_config import OpenAITTSConfig

        config = get_config_manager().load_config(OpenAITTSConfig)

        api_key = self._resolve_key(config)
        if not api_key:
            raise ValueError(
                "OpenAI API key is not configured (LLM & Provider settings)"
            )

        request = await self.apply_emotion(request)

        # Map audio format
        response_format = request.audio_format.value
        if response_format == "pcm":
            response_format = "mp3"  # PCM not supported, fallback

        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream(
                "POST",
                "https://api.openai.com/v1/audio/speech",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": config.model,
                    "input": request.text,
                    "voice": config.voice,
                    "response_format": response_format,
                    "speed": request.speed,
                },
            ) as resp:
                resp.raise_for_status()
                chunk_index = 0
                async for chunk in resp.aiter_bytes(4096):
                    yield TTSChunk(audio_data=chunk, chunk_index=chunk_index)
                    chunk_index += 1

        yield TTSChunk(audio_data=b"", is_final=True, chunk_index=chunk_index)

    async def get_voices(self, language: Optional[str] = None) -> list[VoiceInfo]:
        """OpenAI voices are multilingual — return all"""
        return [
            VoiceInfo(
                id=vid,
                name=vname,
                language="multilingual",
                gender=vgender,
                engine=self.engine_name,
            )
            for vid, vname, vgender in _OPENAI_VOICES
        ]

    async def health_check(self) -> bool:
        """Check if API key is configured"""
        try:
            from service.config.manager import get_config_manager
            from service.config.sub_config.tts.openai_tts_config import OpenAITTSConfig

            config = get_config_manager().load_config(OpenAITTSConfig)
            return bool(self._resolve_key(config))
        except Exception:
            return False
