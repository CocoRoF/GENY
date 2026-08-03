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


# ── staging + hint path resolution (the two-bases contract) ──────────


def _stage(tmp_path, attachments):
    """Drive the real staging helper on a minimal session stand-in."""
    import types

    from service.executor.agent_session import AgentSession

    fake = types.SimpleNamespace(storage_path=str(tmp_path), _session_id="t")
    return AgentSession._stage_attachments_to_workspace(fake, attachments)


def _make_upload(tmp_path, name, data: bytes):
    src = tmp_path / "store" / name
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(data)
    return f"file://{src}"


def test_staged_paths_resolve_in_both_tool_families(tmp_path):
    """EFFECT PROOF (the rel_path P0): the audio hint's path must open
    through the EXECUTOR resolver (working_dir = workspace), and the
    office hint's path through GENY's doc-tool base (storage root).
    One shared string cannot satisfy both — the entry carries two."""
    url = _make_upload(tmp_path, "회의.mp3", b"ID3fakemp3")
    staged = _stage(tmp_path, [{"name": "회의.mp3", "mime_type": "audio/mpeg", "url": url}])
    assert len(staged) == 1
    entry = staged[0]
    assert entry["rel_path"] == "workspace/uploads/회의.mp3"
    assert entry["ws_rel_path"] == "uploads/회의.mp3"

    # executor family base: working_dir = <storage>/workspace
    try:
        from geny_executor.tools.built_in._path_guard import resolve_and_validate
    except ImportError:
        pytest.skip("geny-executor unavailable")
    ws = str(tmp_path / "workspace")
    resolved = resolve_and_validate(entry["ws_rel_path"], ws, [ws])
    assert resolved.exists(), "AudioTranscribe hint path must resolve"

    # Geny doc family base: storage root
    assert (tmp_path / entry["rel_path"]).exists(), "doc_analyze hint path must resolve"


def test_extensionless_audio_gets_mime_extension(tmp_path):
    """An audio upload without a usable extension would draw a hint the
    suffix-gated tool rejects — staging backfills from the MIME."""
    url = _make_upload(tmp_path, "voicememo", b"opusdata")
    staged = _stage(tmp_path, [{"name": "voicememo", "mime_type": "audio/webm", "url": url}])
    assert staged[0]["name"].endswith(".webm")
    assert staged[0]["ws_rel_path"].endswith(".webm")


def test_same_name_different_bytes_gets_unique_path(tmp_path):
    """EFFECT PROOF: a second upload with the same name but different
    content must NOT silently reuse/clobber — it lands at a unique name
    (the hint always shows the final name)."""
    import hashlib as _h

    a = b"first version bytes"
    b = b"second DIFFERENT bytes!"  # different size → collision branch
    url1 = _make_upload(tmp_path, "메모.mp3", a)
    s1 = _stage(tmp_path, [{"name": "메모.mp3", "mime_type": "audio/mpeg", "url": url1,
                            "sha256": _h.sha256(a).hexdigest()}])
    url2 = _make_upload(tmp_path, "메모2.mp3", b)
    s2 = _stage(tmp_path, [{"name": "메모.mp3", "mime_type": "audio/mpeg", "url": url2,
                            "sha256": _h.sha256(b).hexdigest()}])
    assert s1[0]["name"] == "메모.mp3"
    assert s2[0]["name"] != "메모.mp3", "collision must uniquify, not reuse stale bytes"
    ws = tmp_path / "workspace" / "uploads"
    assert (ws / s1[0]["name"]).read_bytes() == a
    assert (ws / s2[0]["name"]).read_bytes() == b

    # identical re-upload (same sha) reuses the existing path
    s3 = _stage(tmp_path, [{"name": "메모.mp3", "mime_type": "audio/mpeg", "url": url1,
                            "sha256": _h.sha256(a).hexdigest()}])
    assert s3[0]["name"] == "메모.mp3"


def test_aac_no_longer_promised():
    from controller.upload_controller import ALLOWED_AUDIO_MIMES

    assert "audio/aac" not in ALLOWED_AUDIO_MIMES, (
        "the executor's Audio* family rejects .aac — accepting the MIME "
        "creates a hint the tool can only refuse (ghost-promise)"
    )
