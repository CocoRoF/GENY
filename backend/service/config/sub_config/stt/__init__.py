"""STT (Speech-to-Text) configuration sub-package.

Mirrors `service.config.sub_config.tts` — one sub-module per
backend engine. Phase W1 ships only the Whisper engine (vLLM-hosted
openai/whisper-large-v3), more can plug in here later.
"""

from .audio_backfill_config import AudioBackfillConfig
from .whisper_config import WhisperConfig

__all__ = ["AudioBackfillConfig", "WhisperConfig"]
