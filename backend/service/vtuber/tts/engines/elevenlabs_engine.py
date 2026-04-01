"""
ElevenLabs TTS Engine — High-quality voice synthesis with emotion control.

Uses ElevenLabs' streaming API with per-emotion voice_settings adjustments.
Supports voice cloning, multiple models, and fine-grained emotion parameters.
"""

from logging import getLogger
from typing import AsyncIterator, Optional

import httpx

from service.vtuber.tts.base import (
    TTSChunk,
    TTSEngine,
    TTSRequest,
    VoiceInfo,
)

logger = getLogger(__name__)


class ElevenLabsEngine(TTSEngine):
    """ElevenLabs TTS engine with emotion-based voice_settings"""

    engine_name = "elevenlabs"

    # Emotion → ElevenLabs voice_settings overrides
    EMOTION_SETTINGS = {
        "neutral":  {"stability": 0.50, "similarity_boost": 0.75, "style": 0.00},
        "joy":      {"stability": 0.30, "similarity_boost": 0.75, "style": 0.80},
        "anger":    {"stability": 0.70, "similarity_boost": 0.85, "style": 0.60},
        "sadness":  {"stability": 0.60, "similarity_boost": 0.70, "style": 0.40},
        "fear":     {"stability": 0.40, "similarity_boost": 0.65, "style": 0.50},
        "surprise": {"stability": 0.20, "similarity_boost": 0.75, "style": 0.90},
        "disgust":  {"stability": 0.65, "similarity_boost": 0.80, "style": 0.30},
        "smirk":    {"stability": 0.45, "similarity_boost": 0.75, "style": 0.60},
    }

    async def synthesize_stream(self, request: TTSRequest) -> AsyncIterator[TTSChunk]:
        """Stream audio from ElevenLabs API with emotion-aware voice settings"""
        from service.config.manager import get_config_manager
        from service.config.sub_config.tts.elevenlabs_config import ElevenLabsConfig

        config = get_config_manager().load_config(ElevenLabsConfig)

        if not config.api_key:
            raise ValueError("ElevenLabs API key is not configured")
        if not config.voice_id:
            raise ValueError("ElevenLabs Voice ID is not configured")

        # Apply emotion-specific voice settings
        voice_settings = self.EMOTION_SETTINGS.get(
            request.emotion, self.EMOTION_SETTINGS["neutral"]
        ).copy()

        # Blend with user-configured base values
        voice_settings["stability"] = min(
            1.0, voice_settings["stability"] * (config.stability / 0.5)
        ) if config.stability > 0 else voice_settings["stability"]
        voice_settings["similarity_boost"] = config.similarity_boost

        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream(
                "POST",
                f"https://api.elevenlabs.io/v1/text-to-speech/{config.voice_id}/stream",
                headers={
                    "xi-api-key": config.api_key,
                    "Content-Type": "application/json",
                },
                json={
                    "text": request.text,
                    "model_id": config.model_id,
                    "voice_settings": voice_settings,
                },
            ) as resp:
                resp.raise_for_status()
                chunk_index = 0
                async for chunk in resp.aiter_bytes(4096):
                    yield TTSChunk(audio_data=chunk, chunk_index=chunk_index)
                    chunk_index += 1

        yield TTSChunk(audio_data=b"", is_final=True, chunk_index=chunk_index)

    async def get_voices(self, language: Optional[str] = None) -> list[VoiceInfo]:
        """List voices from user's ElevenLabs account"""
        try:
            from service.config.manager import get_config_manager
            from service.config.sub_config.tts.elevenlabs_config import ElevenLabsConfig

            config = get_config_manager().load_config(ElevenLabsConfig)
            if not config.api_key:
                return []

            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(
                    "https://api.elevenlabs.io/v1/voices",
                    headers={"xi-api-key": config.api_key},
                )
                resp.raise_for_status()
                data = resp.json()

            voices = []
            for v in data.get("voices", []):
                voices.append(
                    VoiceInfo(
                        id=v["voice_id"],
                        name=v.get("name", v["voice_id"]),
                        language="multilingual",
                        gender=v.get("labels", {}).get("gender", "unknown"),
                        engine=self.engine_name,
                    )
                )
            return voices
        except Exception as e:
            logger.warning(f"Failed to list ElevenLabs voices: {e}")
            return []

    async def health_check(self) -> bool:
        """Check if API key and voice ID are configured"""
        try:
            from service.config.manager import get_config_manager
            from service.config.sub_config.tts.elevenlabs_config import ElevenLabsConfig

            config = get_config_manager().load_config(ElevenLabsConfig)
            return bool(config.api_key and config.voice_id)
        except Exception:
            return False
