"""Unit tests for the Whisper STT client.

These avoid the real httpx network — every test injects a stub
config and a stub ``_get_client`` so the asserts focus on the
contract the rest of Geny expects:

  * Best-effort: every exception path → TranscriptionResult with
    source="unavailable" and an error string. Never raises.
  * Config gating: WhisperConfig.enabled=False short-circuits to
    source="disabled" without touching the network.
  * Response parsing: the three response_format modes
    (json / verbose_json / text) all decode to TranscriptionResult.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx
import pytest

from service.stt import whisper_client as wc
from service.stt.whisper_client import (
    TranscriptionResult,
    WhisperClient,
)


# ── Helpers ──────────────────────────────────────────────────────────


@dataclass
class _StubConfig:
    enabled: bool = True
    api_url: str = "http://whisper-stt:8001"
    timeout_seconds: float = 30.0
    model: str = "openai/whisper-large-v3"
    language: str = ""
    response_format: str = "json"
    temperature: float = 0.0


class _StubClient:
    """Drop-in for httpx.AsyncClient. Records the last call."""

    def __init__(self, *, response: Optional[httpx.Response] = None, raise_exc: Optional[Exception] = None):
        self._response = response
        self._raise = raise_exc
        self.last_endpoint: Optional[str] = None
        self.last_data: Optional[dict] = None
        self.last_files: Optional[dict] = None
        self.is_closed = False

    async def post(self, endpoint: str, *, files=None, data=None):
        if self._raise:
            raise self._raise
        self.last_endpoint = endpoint
        self.last_files = files
        self.last_data = data
        return self._response


def _make_response(status: int, json_body: Any = None, text_body: Optional[str] = None) -> httpx.Response:
    if text_body is not None:
        return httpx.Response(
            status, text=text_body, request=httpx.Request("POST", "http://x/")
        )
    return httpx.Response(
        status,
        json=json_body or {},
        request=httpx.Request("POST", "http://x/"),
    )


def _async_run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ── Tests ────────────────────────────────────────────────────────────


def test_disabled_config_short_circuits(monkeypatch: pytest.MonkeyPatch) -> None:
    client = WhisperClient(config=_StubConfig(enabled=False))
    result = _async_run(client.atranscribe(b"some-bytes"))
    assert result.source == "disabled"
    assert result.text == ""
    assert "enabled is False" in (result.error or "")


def test_empty_audio_returns_unavailable() -> None:
    client = WhisperClient(config=_StubConfig())
    result = _async_run(client.atranscribe(b""))
    assert result.source == "unavailable"
    assert "empty" in (result.error or "").lower()


def test_happy_path_json_response(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _StubClient(
        response=_make_response(
            200,
            json_body={"text": "안녕하세요", "language": "ko", "duration": 1.5},
        ),
    )

    async def _fake_get_client(api_url, timeout):  # noqa: ARG001
        return stub

    monkeypatch.setattr(wc, "_get_client", _fake_get_client)

    client = WhisperClient(config=_StubConfig())
    result = _async_run(client.atranscribe(b"\x00\x00", filename="a.webm"))

    assert result.source == "whisper"
    assert result.text == "안녕하세요"
    assert result.language == "ko"
    assert result.duration_seconds == 1.5
    assert result.is_ok()

    # Endpoint and form-field shape are part of the public contract.
    assert stub.last_endpoint == "http://whisper-stt:8001/v1/audio/transcriptions"
    assert stub.last_data["model"] == "openai/whisper-large-v3"
    assert stub.last_data["response_format"] == "json"
    assert "language" not in stub.last_data  # empty config → omitted


def test_language_override_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _StubClient(
        response=_make_response(200, json_body={"text": "hi", "language": "en"}),
    )

    async def _fake_get_client(api_url, timeout):  # noqa: ARG001
        return stub

    monkeypatch.setattr(wc, "_get_client", _fake_get_client)

    client = WhisperClient(config=_StubConfig(language="en"))
    _async_run(client.atranscribe(b"\x00\x00"))
    assert stub.last_data["language"] == "en"

    # Per-call override beats the config-level value.
    _async_run(client.atranscribe(b"\x00\x00", language="ja"))
    assert stub.last_data["language"] == "ja"


def test_text_response_format(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _StubClient(response=_make_response(200, text_body="plain transcript"))

    async def _fake_get_client(api_url, timeout):  # noqa: ARG001
        return stub

    monkeypatch.setattr(wc, "_get_client", _fake_get_client)

    client = WhisperClient(config=_StubConfig(response_format="text"))
    result = _async_run(client.atranscribe(b"\x00\x00"))
    assert result.source == "whisper"
    assert result.text == "plain transcript"
    assert result.language is None


def test_connect_error_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _StubClient(raise_exc=httpx.ConnectError("conn refused"))

    async def _fake_get_client(api_url, timeout):  # noqa: ARG001
        return stub

    monkeypatch.setattr(wc, "_get_client", _fake_get_client)

    client = WhisperClient(config=_StubConfig())
    result = _async_run(client.atranscribe(b"\x00\x00"))
    assert result.source == "unavailable"
    assert "connect failed" in (result.error or "")
    assert result.text == ""  # never raises into the caller


def test_read_timeout_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _StubClient(raise_exc=httpx.ReadTimeout("timeout"))

    async def _fake_get_client(api_url, timeout):  # noqa: ARG001
        return stub

    monkeypatch.setattr(wc, "_get_client", _fake_get_client)

    client = WhisperClient(config=_StubConfig(timeout_seconds=5.0))
    result = _async_run(client.atranscribe(b"\x00\x00"))
    assert result.source == "unavailable"
    assert "timeout" in (result.error or "").lower()


def test_http_5xx_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _StubClient(
        response=_make_response(503, text_body="model loading"),
    )

    async def _fake_get_client(api_url, timeout):  # noqa: ARG001
        return stub

    monkeypatch.setattr(wc, "_get_client", _fake_get_client)

    client = WhisperClient(config=_StubConfig())
    result = _async_run(client.atranscribe(b"\x00\x00"))
    assert result.source == "unavailable"
    assert "HTTP 503" in (result.error or "")


def test_malformed_json_body(monkeypatch: pytest.MonkeyPatch) -> None:
    # 200 OK but body isn't valid JSON.
    stub = _StubClient(response=_make_response(200, text_body="not json"))

    async def _fake_get_client(api_url, timeout):  # noqa: ARG001
        return stub

    monkeypatch.setattr(wc, "_get_client", _fake_get_client)

    client = WhisperClient(config=_StubConfig(response_format="json"))
    result = _async_run(client.atranscribe(b"\x00\x00"))
    assert result.source == "unavailable"
    assert "invalid JSON" in (result.error or "")


def test_sync_wrapper_outside_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """The sync ``transcribe`` should work from a no-loop context."""
    stub = _StubClient(response=_make_response(200, json_body={"text": "ok"}))

    async def _fake_get_client(api_url, timeout):  # noqa: ARG001
        return stub

    monkeypatch.setattr(wc, "_get_client", _fake_get_client)

    client = WhisperClient(config=_StubConfig())
    result = client.transcribe(b"\x00\x00")
    assert result.source == "whisper"
    assert result.text == "ok"


def test_empty_api_url_returns_unavailable() -> None:
    client = WhisperClient(config=_StubConfig(api_url=""))
    result = _async_run(client.atranscribe(b"\x00\x00"))
    assert result.source == "unavailable"
    assert "api_url" in (result.error or "")


def test_result_is_ok_predicate() -> None:
    assert TranscriptionResult(text="hi", source="whisper").is_ok()
    assert not TranscriptionResult(text="", source="whisper").is_ok()
    assert not TranscriptionResult(text="hi", source="unavailable").is_ok()
    assert not TranscriptionResult(text="hi", source="disabled").is_ok()
