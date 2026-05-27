"""
Voice Studio service layer.

Hosts the Pydantic models + business helpers used by the
``controller/voice_studio/*`` routers. Kept separate from the legacy
``service/vtuber/tts/`` package so the existing chat TTS path stays
untouched.
"""
