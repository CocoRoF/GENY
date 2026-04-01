"""
GPT-SoVITS TTS Engine — Open-source voice cloning with emotion references.

Connects to a locally running GPT-SoVITS API v2 server.
Selects emotion-specific reference audio files for natural voice expression.
"""

import os
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


class GPTSoVITSEngine(TTSEngine):
    """GPT-SoVITS engine with emotion-based reference audio selection"""

    engine_name = "gpt_sovits"

    def __init__(self):
        self._client = httpx.AsyncClient(timeout=60.0)

    async def synthesize_stream(self, request: TTSRequest) -> AsyncIterator[TTSChunk]:
        """Stream audio from GPT-SoVITS API v2"""
        from service.config.manager import get_config_manager
        from service.config.sub_config.tts.gpt_sovits_config import GPTSoVITSConfig

        config = get_config_manager().load_config(GPTSoVITSConfig)

        if not config.enabled:
            raise ValueError("GPT-SoVITS is not enabled")

        # Select emotion-specific reference audio
        ref_audio_path = self._get_emotion_ref(request.emotion, config)

        # Map language code to GPT-SoVITS format
        text_lang = self._lang_to_sovits(request.language)

        payload = {
            "text": request.text,
            "text_lang": text_lang,
            "ref_audio_path": ref_audio_path,
            "prompt_text": config.prompt_text,
            "prompt_lang": config.prompt_lang,
            "top_k": config.top_k,
            "top_p": config.top_p,
            "temperature": config.temperature,
            "speed_factor": request.speed * config.speed,
            "media_type": request.audio_format.value,
            "streaming_mode": True,
            "parallel_infer": True,
            "repetition_penalty": 1.35,
        }

        chunk_index = 0
        try:
            async with self._client.stream(
                "POST", f"{config.api_url}/tts", json=payload
            ) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(chunk_size=4096):
                    yield TTSChunk(audio_data=chunk, chunk_index=chunk_index)
                    chunk_index += 1
        except Exception as e:
            logger.error(f"GPT-SoVITS synthesis error: {e}")
            raise

        yield TTSChunk(audio_data=b"", is_final=True, chunk_index=chunk_index)

    async def get_voices(self, language: Optional[str] = None) -> list[VoiceInfo]:
        """List available voice profiles from the references directory"""
        try:
            from service.config.manager import get_config_manager
            from service.config.sub_config.tts.gpt_sovits_config import GPTSoVITSConfig

            config = get_config_manager().load_config(GPTSoVITSConfig)
            if not config.ref_audio_dir or not os.path.isdir(config.ref_audio_dir):
                return []

            # List reference audio files as "voices"
            voices = []
            for f in os.listdir(config.ref_audio_dir):
                if f.endswith(".wav") and f.startswith("ref_"):
                    emotion = f.replace("ref_", "").replace(".wav", "")
                    voices.append(
                        VoiceInfo(
                            id=f,
                            name=f"레퍼런스: {emotion}",
                            language="multilingual",
                            gender="unknown",
                            engine=self.engine_name,
                        )
                    )
            return voices
        except Exception as e:
            logger.warning(f"Failed to list GPT-SoVITS voices: {e}")
            return []

    async def health_check(self) -> bool:
        """Check if GPT-SoVITS server is running"""
        try:
            from service.config.manager import get_config_manager
            from service.config.sub_config.tts.gpt_sovits_config import GPTSoVITSConfig

            config = get_config_manager().load_config(GPTSoVITSConfig)
            if not config.enabled:
                return False

            resp = await self._client.get(f"{config.api_url}/", timeout=5.0)
            return resp.status_code == 200
        except Exception:
            return False

    def _get_emotion_ref(self, emotion: str, config) -> str:
        """Get the reference audio path for a given emotion, with neutral fallback"""
        ref_dir = config.ref_audio_dir
        if not ref_dir:
            return ""

        emotion_file = f"ref_{emotion}.wav"
        full_path = os.path.join(ref_dir, emotion_file)

        if os.path.exists(full_path):
            return full_path

        # Fallback to neutral
        neutral_path = os.path.join(ref_dir, "ref_neutral.wav")
        if os.path.exists(neutral_path):
            return neutral_path

        return ""

    @staticmethod
    def _lang_to_sovits(language: str) -> str:
        """Map BCP-47 language code to GPT-SoVITS language format"""
        return {
            "ko": "ko",
            "ja": "ja",
            "en": "en",
            "zh": "zh",
        }.get(language, "ko")
