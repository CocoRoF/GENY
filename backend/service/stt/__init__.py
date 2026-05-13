"""STT (Speech-to-Text) sub-package.

Phase W1 ships only the Whisper client. Future engines (Vosk,
Faster-Whisper, cloud STT) plug in alongside ``whisper_client.py``.
"""

from .whisper_client import (
    TranscriptionResult,
    WhisperClient,
    get_whisper_client,
    reset_whisper_client_for_tests,
)

__all__ = [
    "TranscriptionResult",
    "WhisperClient",
    "get_whisper_client",
    "reset_whisper_client_for_tests",
]
