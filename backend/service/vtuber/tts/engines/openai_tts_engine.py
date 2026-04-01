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

    async def synthesize_stream(self, request: TTSRequest) -> AsyncIterator[TTSChunk]:
        """Stream audio from OpenAI TTS API"""
        from service.config.manager import get_config_manager
        from service.config.sub_config.tts.openai_tts_config import OpenAITTSConfig

        config = get_config_manager().load_config(OpenAITTSConfig)

        if not config.api_key:
            raise ValueError("OpenAI TTS API key is not configured")

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
                    "Authorization": f"Bearer {config.api_key}",
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
            return bool(config.api_key)
        except Exception:
            return False
