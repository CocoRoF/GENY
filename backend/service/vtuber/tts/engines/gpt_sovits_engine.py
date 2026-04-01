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

# GPT-SoVITS API v2 가 지원하는 media_type 목록
_SOVITS_SUPPORTED_MEDIA = {"wav", "raw", "ogg", "aac"}
_SOVITS_DEFAULT_MEDIA = "wav"


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

        # Select emotion-specific reference audio (GPT-SoVITS 컨테이너 기준 경로)
        ref_audio_path = self._get_emotion_ref(request.emotion, config)
        if not ref_audio_path:
            logger.warning(
                "No reference audio found for GPT-SoVITS. "
                "Set ref_audio_dir (backend path) and container_ref_dir (GPT-SoVITS container path) in config."
            )

        # Map language code to GPT-SoVITS format
        text_lang = self._lang_to_sovits(request.language)

        # GPT-SoVITS는 mp3를 지원하지 않음 — wav로 강제 변환
        media_type = request.audio_format.value
        if media_type not in _SOVITS_SUPPORTED_MEDIA:
            logger.info(
                f"GPT-SoVITS does not support '{media_type}', using '{_SOVITS_DEFAULT_MEDIA}' instead"
            )
            media_type = _SOVITS_DEFAULT_MEDIA

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
            "media_type": media_type,
            "streaming_mode": True,
            "parallel_infer": True,
            "repetition_penalty": 1.35,
        }

        logger.info(
            f"GPT-SoVITS request: url={config.api_url}/tts, "
            f"text_lang={text_lang}, ref={ref_audio_path}, media={media_type}"
        )

        chunk_index = 0
        try:
            async with self._client.stream(
                "POST", f"{config.api_url}/tts", json=payload
            ) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    logger.error(
                        f"GPT-SoVITS API returned {resp.status_code}: {body.decode(errors='replace')}"
                    )
                    raise ValueError(
                        f"GPT-SoVITS API error {resp.status_code}: {body.decode(errors='replace')}"
                    )
                async for chunk in resp.aiter_bytes(chunk_size=4096):
                    yield TTSChunk(audio_data=chunk, chunk_index=chunk_index)
                    chunk_index += 1
        except httpx.HTTPStatusError as e:
            logger.error(f"GPT-SoVITS HTTP error: {e}")
            raise
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
                logger.debug("GPT-SoVITS is disabled in config")
                return False

            # GPT-SoVITS API v2는 루트(/)에 엔드포인트가 없으므로
            # FastAPI 자동 생성 /docs 또는 /openapi.json 사용
            resp = await self._client.get(
                f"{config.api_url}/tts",
                params={"text": "", "text_lang": "ko", "ref_audio_path": "", "prompt_lang": "ko"},
                timeout=5.0,
            )
            # 400 = 서버 동작 중 (파라미터 부족 에러), 200 = 정상
            is_healthy = resp.status_code in (200, 400, 422)
            if not is_healthy:
                logger.warning(
                    f"GPT-SoVITS health check failed: {config.api_url} → {resp.status_code}"
                )
            return is_healthy
        except Exception as e:
            logger.warning(f"GPT-SoVITS health check error: {e}")
            return False

    def _get_emotion_ref(self, emotion: str, config) -> str:
        """Get the reference audio path for a given emotion, with neutral fallback.

        Backend의 ref_audio_dir 에서 파일 존재를 확인한 뒤,
        GPT-SoVITS 컨테이너 기준 경로(container_ref_dir)로 변환하여 반환.
        """
        ref_dir = config.ref_audio_dir
        if not ref_dir:
            return ""

        # GPT-SoVITS 컨테이너 내부 경로 (docker volume mount 기준)
        container_dir = getattr(config, "container_ref_dir", "") or ref_dir

        emotion_file = f"ref_{emotion}.wav"
        full_path = os.path.join(ref_dir, emotion_file)

        if os.path.exists(full_path):
            return os.path.join(container_dir, emotion_file)

        # Fallback to neutral
        neutral_file = "ref_neutral.wav"
        neutral_path = os.path.join(ref_dir, neutral_file)
        if os.path.exists(neutral_path):
            return os.path.join(container_dir, neutral_file)

        # ref_dir에 파일이 없으면 container_dir 경로를 그대로 전달 (GPT-SoVITS가 확인)
        container_path = os.path.join(container_dir, emotion_file)
        logger.warning(
            f"ref audio not found locally at {full_path}, "
            f"sending container path as-is: {container_path}"
        )
        return container_path

    @staticmethod
    def _lang_to_sovits(language: str) -> str:
        """Map BCP-47 language code to GPT-SoVITS language format"""
        return {
            "ko": "ko",
            "ja": "ja",
            "en": "en",
            "zh": "zh",
        }.get(language, "ko")
