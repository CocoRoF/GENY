"""
Fish Speech TTS Engine — Open-source fast TTS with OpenAI-compatible API.

Connects to a locally running Fish Speech server using the
/v1/audio/speech endpoint (OpenAI API compatible).
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


class FishSpeechEngine(TTSEngine):
    """Fish Speech engine using OpenAI-compatible API"""

    engine_name = "fish_speech"

    async def synthesize_stream(self, request: TTSRequest) -> AsyncIterator[TTSChunk]:
        """Stream audio from Fish Speech's OpenAI-compatible API"""
        from service.config.manager import get_config_manager
        from service.config.sub_config.tts.fish_speech_config import FishSpeechConfig

        config = get_config_manager().load_config(FishSpeechConfig)

        if not config.enabled:
            raise ValueError("Fish Speech is not enabled")

        request = await self.apply_emotion(request)

        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream(
                "POST",
                f"{config.api_url}/v1/audio/speech",
                json={
                    "model": "fish-speech-1.5",
                    "input": request.text,
                    "voice": config.reference_id or "default",
                    "response_format": request.audio_format.value,
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
        """List available Fish Speech models/voices"""
        try:
            from service.config.manager import get_config_manager
            from service.config.sub_config.tts.fish_speech_config import FishSpeechConfig

            config = get_config_manager().load_config(FishSpeechConfig)
            if not config.enabled:
                return []

            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{config.api_url}/v1/models")
                resp.raise_for_status()
                data = resp.json()

            voices = []
            for model in data.get("data", []):
                voices.append(
                    VoiceInfo(
                        id=model.get("id", "default"),
                        name=model.get("id", "Fish Speech"),
                        language="multilingual",
                        gender="unknown",
                        engine=self.engine_name,
                    )
                )
            return voices if voices else [
                VoiceInfo(
                    id="default",
                    name="Fish Speech Default",
                    language="multilingual",
                    gender="unknown",
                    engine=self.engine_name,
                )
            ]
        except Exception as e:
            logger.warning(f"Failed to list Fish Speech voices: {e}")
            return []

    async def health_check(self) -> bool:
        """Check if Fish Speech server is running"""
        try:
            from service.config.manager import get_config_manager
            from service.config.sub_config.tts.fish_speech_config import FishSpeechConfig

            config = get_config_manager().load_config(FishSpeechConfig)
            if not config.enabled:
                return False

            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{config.api_url}/v1/models")
                return resp.status_code == 200
        except Exception:
            return False
