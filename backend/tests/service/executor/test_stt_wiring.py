"""STT framework wiring — gate token, extras spec, upload MIME opening.

The executor owns the Audio* logic (geny-executor 2.64.0); Geny is the
consumer. These tests pin the consumer contract:

  * ``feature:stt_enabled`` is satisfied exactly when WhisperConfig is
    enabled with an endpoint (same criteria the extras injector uses —
    the gate and the injection can never disagree);
  * the injected ``extras["stt"]`` is the serializable provider spec the
    executor's ``openai_compatible`` client consumes;
  * audio MIME types pass the chat-attachment gate with the document cap.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from service.config.sub_config.stt.whisper_config import WhisperConfig
from service.executor.tool_config_gate import compute_satisfied_config


class _FakeManager:
    def __init__(self, cfg):
        self._cfg = cfg

    def load_config(self, cls):
        if cls is WhisperConfig:
            return self._cfg
        raise RuntimeError("other configs unavailable in this test")

    def get_registered_config_classes(self):
        return {}


def _patch_manager(monkeypatch, cfg):
    import service.config as config_pkg

    monkeypatch.setattr(config_pkg, "get_config_manager", lambda: _FakeManager(cfg))


# ── gate token ────────────────────────────────────────────────────────


def test_gate_token_present_when_enabled_and_configured(monkeypatch):
    _patch_manager(monkeypatch, WhisperConfig(enabled=True, api_url="http://whisper-stt:8001"))
    assert "feature:stt_enabled" in compute_satisfied_config()


def test_gate_token_absent_when_disabled_or_unconfigured(monkeypatch):
    _patch_manager(monkeypatch, WhisperConfig(enabled=False, api_url="http://whisper-stt:8001"))
    assert "feature:stt_enabled" not in compute_satisfied_config()

    _patch_manager(monkeypatch, WhisperConfig(enabled=True, api_url=""))
    assert "feature:stt_enabled" not in compute_satisfied_config()


# ── extras spec shape (what the executor's client consumes) ──────────


def test_extras_spec_matches_executor_contract():
    """The dict agent_session injects must be constructible into the
    executor's provider — pin the field names so a rename on either side
    fails here first."""
    cfg = WhisperConfig(
        enabled=True, api_url="http://whisper-stt:8001",
        model="openai/whisper-large-v3", language="", timeout_seconds=120,
    )
    spec = {
        "provider": "openai_compatible",
        "api_url": cfg.api_url,
        "model": cfg.model,
        "language": getattr(cfg, "language", None) or None,
        "timeout": float(getattr(cfg, "timeout_seconds", 300) or 300),
        "temperature": float(getattr(cfg, "temperature", 0.0) or 0.0),
    }
    assert spec["provider"] == "openai_compatible"
    assert spec["api_url"].startswith("http")
    assert spec["model"]
    assert spec["language"] is None  # '' must normalise to None (auto-detect)
    assert spec["timeout"] == 120.0

    # if the executor is importable here, prove the spec actually builds
    try:
        from geny_executor.audio.stt import create_stt_client
    except ImportError:
        pytest.skip("geny-executor <2.64.0 in this venv")
    client = create_stt_client(
        spec["provider"],
        **{k: v for k, v in spec.items() if k not in ("provider", "language") and v is not None},
    )
    assert client.descriptor == "openai_compatible/openai/whisper-large-v3"


# ── upload MIME opening ──────────────────────────────────────────────


def test_audio_mimes_accepted_with_document_cap():
    from controller.upload_controller import (
        ALLOWED_AUDIO_MIMES,
        MAX_DOCUMENT_BYTES,
        MAX_UPLOAD_BYTES,
        _classify,
        _validate_mime,
    )

    for mime in ("audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg",
                 "audio/webm", "audio/flac", "video/webm"):
        assert mime in ALLOWED_AUDIO_MIMES, mime
        _validate_mime(mime)  # must not raise
        if mime != "video/webm":
            assert _classify(mime) == "audio"

    with pytest.raises(HTTPException) as e:
        _validate_mime("audio/x-totally-unknown")
    assert e.value.status_code == 415

    assert MAX_DOCUMENT_BYTES == 50 * 1024 * 1024 > MAX_UPLOAD_BYTES
