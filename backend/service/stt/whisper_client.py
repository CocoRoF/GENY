"""
WhisperClient — adapter for the in-cluster ``geny-whisper-stt`` service.

Talks to vLLM's OpenAI-compatible ``POST /v1/audio/transcriptions``
endpoint over the docker bridge network. Mirrors the
``OmnivoiceEngine`` shape:

  * Persistent process-wide ``httpx.AsyncClient`` pool, keyed by
    ``(api_url, timeout)``.
  * Sync + async public surface (async-native, sync wrapper via
    asyncio.run for CLI / scripts).
  * **Best-effort** — every external failure (connect refused,
    timeout, 5xx, malformed body) is caught and surfaced as
    ``TranscriptionResult(text="", source="unavailable", error=...)``.
    The audio capture path NEVER fails because of the STT service.

Per docs/voice-notes/01_DESIGN.md §2.2: a happy result looks like

    TranscriptionResult(
        text="...",
        language="ko",
        duration_seconds=12.3,
        source="whisper",
        error=None,
    )

and a degraded result like

    TranscriptionResult(
        text="",
        language=None,
        duration_seconds=None,
        source="unavailable",
        error="ConnectError: ...",
    )
"""

from __future__ import annotations

import asyncio
import io
from dataclasses import dataclass
from logging import getLogger
from typing import Optional

import httpx

logger = getLogger(__name__)


# ── Result ────────────────────────────────────────────────────────────


@dataclass(slots=True)
class TranscriptionResult:
    text: str
    language: Optional[str] = None
    duration_seconds: Optional[float] = None
    source: str = "whisper"  # "whisper" | "unavailable" | "disabled"
    error: Optional[str] = None

    def is_ok(self) -> bool:
        return self.source == "whisper" and bool(self.text)


# ── Persistent client pool ────────────────────────────────────────────


_clients_lock = asyncio.Lock()
_clients: dict[tuple[str, float], httpx.AsyncClient] = {}


async def _get_client(api_url: str, read_timeout: float) -> httpx.AsyncClient:
    """Return the process-wide persistent client for (url, timeout)."""
    key = (api_url.rstrip("/"), float(read_timeout))
    client = _clients.get(key)
    if client is not None and not client.is_closed:
        return client
    async with _clients_lock:
        client = _clients.get(key)
        if client is not None and not client.is_closed:
            return client
        timeout = httpx.Timeout(
            connect=10.0,
            read=read_timeout,
            write=30.0,
            pool=read_timeout,
        )
        limits = httpx.Limits(
            # Whisper requests serialise on the GPU side anyway —
            # vLLM single-replica throughput is the bottleneck. 8
            # keepalive connections is plenty for the capture path
            # (image hook + audio hook + diagnostic endpoint).
            max_keepalive_connections=8,
            max_connections=32,
            keepalive_expiry=60.0,
        )
        client = httpx.AsyncClient(timeout=timeout, limits=limits)
        _clients[key] = client
        return client


async def _close_all_clients() -> None:
    """Tear down every pooled client. Called from tests / shutdown."""
    async with _clients_lock:
        for client in _clients.values():
            try:
                await client.aclose()
            except Exception:  # noqa: BLE001
                pass
        _clients.clear()


# ── Client ────────────────────────────────────────────────────────────


class WhisperClient:
    """Single-tenant adapter for the Whisper STT service.

    Instances are cheap — the heavy lifting (TCP pool, keepalive) is
    shared via the module-level client pool. One instance per process
    is enough; reach for it via :func:`get_whisper_client`.
    """

    def __init__(self, *, config=None):
        # Late import to keep this module testable without the host
        # config manager.
        self._config_override = config

    # ── config snapshot ─────────────────────────────────────────────

    def _load_config(self):
        if self._config_override is not None:
            return self._config_override
        from service.config import get_config_manager
        from service.config.sub_config.stt.whisper_config import WhisperConfig
        return get_config_manager().load_config(WhisperConfig)

    # ── public API ──────────────────────────────────────────────────

    async def atranscribe(
        self,
        audio_bytes: bytes,
        *,
        filename: str = "audio.webm",
        language: Optional[str] = None,
    ) -> TranscriptionResult:
        """Transcribe ``audio_bytes`` to text.

        Args:
            audio_bytes: Raw audio. Whisper accepts most container
                formats — webm/ogg/mp3/wav/m4a all work via vLLM's
                librosa-backed decoder.
            filename: Used only for the multipart filename field;
                helps server-side mime detection.
            language: ISO-639-1 override. ``None`` falls back to the
                config-level setting (which itself defaults to empty
                = auto-detect).

        Returns:
            A :class:`TranscriptionResult`. Never raises into the
            caller — service failures are encoded in ``source`` and
            ``error``.
        """
        if not audio_bytes:
            return TranscriptionResult(
                text="",
                source="unavailable",
                error="audio_bytes is empty",
            )

        cfg = self._load_config()
        if not getattr(cfg, "enabled", True):
            return TranscriptionResult(
                text="",
                source="disabled",
                error="WhisperConfig.enabled is False",
            )

        api_url = (getattr(cfg, "api_url", "") or "").rstrip("/")
        if not api_url:
            return TranscriptionResult(
                text="",
                source="unavailable",
                error="WhisperConfig.api_url is empty",
            )

        timeout = float(getattr(cfg, "timeout_seconds", 120.0))
        model = getattr(cfg, "model", "openai/whisper-large-v3")
        response_format = getattr(cfg, "response_format", "json")
        temperature = float(getattr(cfg, "temperature", 0.0))
        lang_cfg = (getattr(cfg, "language", "") or "").strip()
        chosen_language = (language or lang_cfg).strip()

        # vLLM exposes the OpenAI transcription contract verbatim —
        # form fields are: file (binary), model, language?, prompt?,
        # response_format, temperature.
        form: dict[str, tuple] = {
            "file": (filename, io.BytesIO(audio_bytes), "application/octet-stream"),
        }
        data: dict[str, str] = {
            "model": model,
            "response_format": response_format,
            "temperature": str(temperature),
        }
        if chosen_language:
            data["language"] = chosen_language

        endpoint = f"{api_url}/v1/audio/transcriptions"
        try:
            client = await _get_client(api_url, timeout)
            resp = await client.post(endpoint, files=form, data=data)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            logger.warning("whisper: connect failed (%s)", exc)
            return TranscriptionResult(
                text="", source="unavailable",
                error=f"connect failed: {type(exc).__name__}: {exc}",
            )
        except (httpx.ReadTimeout, asyncio.TimeoutError) as exc:
            logger.warning("whisper: read timeout (%s)", exc)
            return TranscriptionResult(
                text="", source="unavailable",
                error=f"read timeout after {timeout}s",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("whisper: unexpected client error", exc_info=True)
            return TranscriptionResult(
                text="", source="unavailable",
                error=f"client error: {type(exc).__name__}: {exc}",
            )

        if resp.status_code >= 400:
            body_preview = (resp.text or "")[:200]
            logger.warning(
                "whisper: %s returned HTTP %s (body=%s)",
                endpoint, resp.status_code, body_preview,
            )
            return TranscriptionResult(
                text="", source="unavailable",
                error=f"HTTP {resp.status_code}: {body_preview}",
            )

        return self._parse_response(resp, response_format)

    def transcribe(
        self,
        audio_bytes: bytes,
        *,
        filename: str = "audio.webm",
        language: Optional[str] = None,
    ) -> TranscriptionResult:
        """Synchronous wrapper for CLI / scripts. Inside a running
        event loop, prefer :meth:`atranscribe` directly."""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(
                self.atranscribe(
                    audio_bytes, filename=filename, language=language
                )
            )
        # We're inside a loop — spin a private helper loop on a
        # worker thread so we don't recurse into the existing one.
        import concurrent.futures

        def _runner() -> TranscriptionResult:
            new_loop = asyncio.new_event_loop()
            try:
                return new_loop.run_until_complete(
                    self.atranscribe(
                        audio_bytes, filename=filename, language=language
                    )
                )
            finally:
                new_loop.close()

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            return ex.submit(_runner).result()

    # ── helpers ─────────────────────────────────────────────────────

    @staticmethod
    def _parse_response(
        resp: httpx.Response, response_format: str
    ) -> TranscriptionResult:
        """Decode whichever response shape we asked vLLM for.

        ``response_format=text`` returns plain text in the body.
        ``json`` and ``verbose_json`` return JSON. Whisper's
        ``verbose_json`` includes ``duration`` and ``segments``;
        ``json`` includes ``text`` and ``language``.
        """
        if response_format == "text":
            return TranscriptionResult(
                text=(resp.text or "").strip(),
                source="whisper",
            )
        try:
            payload = resp.json()
        except Exception as exc:  # noqa: BLE001
            return TranscriptionResult(
                text="", source="unavailable",
                error=f"invalid JSON body: {exc}",
            )
        if not isinstance(payload, dict):
            return TranscriptionResult(
                text="", source="unavailable",
                error="expected JSON object",
            )
        text = str(payload.get("text") or "").strip()
        language = payload.get("language")
        duration = payload.get("duration")
        try:
            duration_seconds = float(duration) if duration is not None else None
        except (TypeError, ValueError):
            duration_seconds = None
        return TranscriptionResult(
            text=text,
            language=str(language) if isinstance(language, str) else None,
            duration_seconds=duration_seconds,
            source="whisper",
        )


# ── Singleton accessor ───────────────────────────────────────────────


_singleton: Optional[WhisperClient] = None


def get_whisper_client() -> WhisperClient:
    """Return the process-wide WhisperClient singleton."""
    global _singleton
    if _singleton is None:
        _singleton = WhisperClient()
    return _singleton


def reset_whisper_client_for_tests() -> None:
    """Test hook — drop the singleton and close every pooled client.

    Tests that monkeypatch ``WhisperConfig`` or stub the HTTP client
    should call this in their cleanup to avoid leaking state into
    the next test.
    """
    global _singleton
    _singleton = None
    try:
        asyncio.run(_close_all_clients())
    except RuntimeError:
        # Already inside a loop — schedule and forget.
        loop = asyncio.get_event_loop()
        loop.create_task(_close_all_clients())
