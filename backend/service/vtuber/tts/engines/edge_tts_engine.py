"""
Edge TTS Engine — Free Microsoft TTS via edge-tts library.

Uses Microsoft's Edge browser TTS service. No API key required.
Supports multiple languages and voices with speed/pitch control.
"""

from logging import getLogger
from typing import AsyncIterator, Optional

import edge_tts

from service.vtuber.tts.base import (
    AudioFormat,
    TTSChunk,
    TTSEngine,
    TTSRequest,
    VoiceInfo,
)

logger = getLogger(__name__)


class EdgeTTSEngine(TTSEngine):
    """Edge TTS engine using the edge-tts library"""

    engine_name = "edge_tts"

    # Default voice mapping per language
    _DEFAULT_VOICES = {
        "ko": "ko-KR-SunHiNeural",
        "ja": "ja-JP-NanamiNeural",
        "en": "en-US-JennyNeural",
    }

    async def synthesize_stream(self, request: TTSRequest) -> AsyncIterator[TTSChunk]:
        """Stream audio chunks from Edge TTS"""
        voice = self._resolve_voice(request.language)
        request = await self.apply_emotion(request)

        rate_str = self._speed_to_rate(request.speed)
        pitch_str = request.pitch_shift

        communicate = edge_tts.Communicate(
            text=request.text,
            voice=voice,
            rate=rate_str,
            pitch=pitch_str,
        )

        chunk_index = 0
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield TTSChunk(
                    audio_data=chunk["data"],
                    chunk_index=chunk_index,
                )
                chunk_index += 1
            elif chunk["type"] == "WordBoundary":
                yield TTSChunk(
                    audio_data=b"",
                    chunk_index=chunk_index,
                    word_boundary={
                        "text": chunk["text"],
                        "offset": chunk["offset"],
                        "duration": chunk["duration"],
                    },
                )

        yield TTSChunk(audio_data=b"", is_final=True, chunk_index=chunk_index)

    async def get_voices(self, language: Optional[str] = None) -> list[VoiceInfo]:
        """List available Edge TTS voices"""
        try:
            voices_data = await edge_tts.list_voices()
        except Exception as e:
            logger.error(f"Failed to list Edge TTS voices: {e}")
            return []

        result = []
        for v in voices_data:
            lang = v.get("Locale", "")
            if language and not lang.startswith(language):
                continue
            result.append(
                VoiceInfo(
                    id=v["ShortName"],
                    name=v.get("FriendlyName", v["ShortName"]),
                    language=lang,
                    gender=v.get("Gender", "Unknown"),
                    engine=self.engine_name,
                )
            )
        return result

    async def health_check(self) -> bool:
        """Edge TTS is generally available if the library is installed"""
        try:
            voices = await edge_tts.list_voices()
            return len(voices) > 0
        except Exception:
            return False

    def _resolve_voice(self, language: str) -> str:
        """Get the configured voice for a language, with fallback to defaults"""
        try:
            from service.config.manager import get_config_manager
            from service.config.sub_config.tts.edge_tts_config import EdgeTTSConfig

            config = get_config_manager().load_config(EdgeTTSConfig)
            voice_map = {
                "ko": config.voice_ko,
                "ja": config.voice_ja,
                "en": config.voice_en,
            }
            voice = voice_map.get(language)
            if voice:
                return voice
        except Exception as e:
            logger.warning(f"Failed to load Edge TTS config, using defaults: {e}")

        return self._DEFAULT_VOICES.get(language, self._DEFAULT_VOICES["ko"])

    @staticmethod
    def _speed_to_rate(speed: float) -> str:
        """Convert speed multiplier (1.0 = normal) to Edge TTS rate string"""
        percent = int((speed - 1.0) * 100)
        if percent >= 0:
            return f"+{percent}%"
        return f"{percent}%"
