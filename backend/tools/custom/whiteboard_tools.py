"""
Whiteboard Analysis Tools — P4.

These tools let an agent describe / extract text from a previously
captured attachment, primarily so non-vision-capable models can still
discuss images the user has shared.

Tools shipped:
  - ``whiteboard_describe``  — call a vision LLM to caption an
    attachment. Falls back to a deterministic placeholder string when
    no vision model is available (so the tool always succeeds —
    callers can rely on the result being non-empty).
  - ``whiteboard_extract_links`` — pull URLs out of a note body.
  - ``whiteboard_transcribe`` — re-run Whisper on an audio attachment
    that the post-capture hook (W2) either failed on or that the
    user has explicitly asked to re-transcribe. The PostCaptureHook
    handles the happy path automatically — this tool exists so the
    agent has a recovery + retry surface (see ``whiteboard-voice-notes``
    skill).

Auto-loaded by ToolLoader (``*_tools.py`` pattern).

Design rules carried over from the rest of the whiteboard surface:
  * Best-effort everywhere — a missing API key, unsupported provider,
    or malformed image must never raise into the agent's hot path.
  * The tool's structured output stays compact (≤ 1.5 KB typical) so
    a chained tool call doesn't blow the context budget.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from logging import getLogger
from pathlib import Path
from typing import Any, Awaitable, Dict, Optional, TypeVar

from geny_executor.tools.base import ToolCapabilities
from tools.base import BaseTool

logger = getLogger(__name__)


_T = TypeVar("_T")


def _ok(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)


def _error(msg: str) -> str:
    return _ok({"error": msg})


def _run_async_in_sync_call(coro: Awaitable[_T]) -> _T:
    """Same shape as the helper used by the knowledge tools — runs an
    async coroutine from a sync ``BaseTool.run``."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)  # type: ignore[arg-type]
    import concurrent.futures

    def _runner() -> _T:
        new_loop = asyncio.new_event_loop()
        try:
            return new_loop.run_until_complete(coro)  # type: ignore[arg-type]
        finally:
            new_loop.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        return executor.submit(_runner).result()


# ── Capture lookup helpers ────────────────────────────────────────────


def _resolve_attachment_path(
    username: str, *, capture_id: Optional[str], attachment_path: Optional[str]
) -> Optional[str]:
    """Resolve a capture identifier OR raw path → vault-relative path."""
    if attachment_path:
        return attachment_path.lstrip("/")
    if not capture_id:
        return None

    try:
        from service.memory.user_opsidian import get_user_opsidian_manager
    except Exception:  # noqa: BLE001
        return None
    mgr = get_user_opsidian_manager(username)
    log_path = Path(mgr.vault_root) / "_captures.jsonl"
    if not log_path.exists():
        return None
    try:
        for line in log_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except (ValueError, json.JSONDecodeError):
                continue
            if row.get("capture_id") == capture_id:
                return row.get("attachment_path")
    except OSError:
        return None
    return None


def _read_attachment_bytes(
    username: str, attachment_path: str
) -> Optional[bytes]:
    try:
        from service.memory.user_opsidian import get_user_opsidian_manager
    except Exception:  # noqa: BLE001
        return None
    mgr = get_user_opsidian_manager(username)
    return mgr.read_attachment(attachment_path)


def _resolve_username(session_id: str) -> Optional[str]:
    try:
        from service.whiteboard.agent_resolver import resolve_user_and_agent
    except Exception:  # noqa: BLE001
        return None
    username, _ = resolve_user_and_agent(session_id)
    return username


# ── whiteboard_describe ──────────────────────────────────────────────


_PLACEHOLDER_DESCRIPTION = (
    "[image attachment, ~{kb} KB. Describe by asking the user about "
    "the visible content, since the active model cannot read the bytes "
    "directly and no vision LLM is configured.]"
)


def _content_type_for(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith(".gif"):
        return "image/gif"
    return "application/octet-stream"


async def _try_vision_describe(
    image_bytes: bytes, *, content_type: str
) -> Optional[str]:
    """Best-effort vision-LLM call. Returns ``None`` on any failure
    so callers can fall back to the placeholder.

    Uses the same client + key configured for memory operations
    (``build_memory_llm``). Vision-capable models will accept the
    image content block; non-vision models will likely error out
    and we'll catch that and return ``None``.
    """
    try:
        from service.memory.memory_llm import build_memory_llm
    except Exception:  # noqa: BLE001
        return None
    llm = build_memory_llm()
    if llm is None:
        return None

    encoded = base64.b64encode(image_bytes).decode("ascii")
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": content_type,
                        "data": encoded,
                    },
                },
                {
                    "type": "text",
                    "text": (
                        "Describe this image in 1–3 sentences. Be concrete: "
                        "what is shown, what text is visible (verbatim), and "
                        "what action would the user reasonably take next?"
                    ),
                },
            ],
        }
    ]
    try:
        response = await llm.client.create_message(
            model_config=llm.model_config,
            messages=messages,
            system="",
            purpose="whiteboard.describe",
        )
        text = (response.text or "").strip()
        return text or None
    except Exception:  # noqa: BLE001
        logger.debug("vision describe failed", exc_info=True)
        return None


async def describe_attachment_async(
    username: str,
    *,
    capture_id: Optional[str] = None,
    attachment_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Resolve → fetch → describe. Always returns a dict with at
    least ``description``; ``source`` is one of {vision, placeholder,
    not_found}."""
    rel = _resolve_attachment_path(
        username, capture_id=capture_id, attachment_path=attachment_path
    )
    if not rel:
        return {
            "description": "",
            "source": "not_found",
            "reason": "could not resolve capture_id / attachment_path",
        }
    data = _read_attachment_bytes(username, rel)
    if data is None:
        return {
            "description": "",
            "source": "not_found",
            "reason": f"attachment {rel} unavailable",
        }
    content_type = _content_type_for(rel)
    if not content_type.startswith("image/"):
        return {
            "description": "",
            "source": "not_found",
            "reason": f"non-image attachment ({content_type})",
        }
    vision = await _try_vision_describe(data, content_type=content_type)
    if vision:
        return {
            "description": vision,
            "source": "vision",
            "attachment_path": rel,
        }
    return {
        "description": _PLACEHOLDER_DESCRIPTION.format(kb=max(1, len(data) // 1024)),
        "source": "placeholder",
        "attachment_path": rel,
    }


class WhiteboardDescribeTool(BaseTool):
    """Caption a previously captured image attachment."""

    name = "whiteboard_describe"
    description = (
        "Describe a captured image attachment from the user's whiteboard. "
        "Pass either capture_id (preferred) or attachment_path. Returns "
        "a short caption sourced from a vision LLM when available; "
        "otherwise returns a placeholder you can use to ask the user "
        "follow-up questions."
    )
    CAPABILITIES = ToolCapabilities(concurrency_safe=True)

    def run(
        self,
        session_id: str,
        capture_id: str = "",
        attachment_path: str = "",
    ) -> str:
        username = _resolve_username(session_id) or "anonymous"
        result = _run_async_in_sync_call(
            describe_attachment_async(
                username,
                capture_id=capture_id or None,
                attachment_path=attachment_path or None,
            )
        )
        return _ok(result)

    async def arun(
        self,
        session_id: str,
        capture_id: str = "",
        attachment_path: str = "",
    ) -> str:
        username = _resolve_username(session_id) or "anonymous"
        result = await describe_attachment_async(
            username,
            capture_id=capture_id or None,
            attachment_path=attachment_path or None,
        )
        return _ok(result)


# ── whiteboard_extract_links ─────────────────────────────────────────


_URL_RE = re.compile(
    r"(?:https?://|www\.)[^\s<>\"'\)]+",
    re.IGNORECASE,
)


def _extract_urls(text: str) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in _URL_RE.findall(text or ""):
        url = raw.rstrip(".,);!?")
        if url not in seen:
            seen.add(url)
            out.append(url)
    return out


class WhiteboardExtractLinksTool(BaseTool):
    """Pull URLs out of an Opsidian note's body."""

    name = "whiteboard_extract_links"
    description = (
        "Extract every URL from a captured note's body. Pass the note "
        "filename (e.g. 'inbox/foo.md'). Useful when the user has "
        "pasted a wall of links and wants you to summarise them."
    )
    CAPABILITIES = ToolCapabilities(concurrency_safe=True)

    def run(self, session_id: str, filename: str) -> str:
        username = _resolve_username(session_id) or "anonymous"
        try:
            from service.memory.user_opsidian import get_user_opsidian_manager
        except Exception:  # noqa: BLE001
            return _error("user opsidian unavailable")
        mgr = get_user_opsidian_manager(username)
        note = mgr.read_note(filename)
        if note is None:
            return _error(f"note not found: {filename}")
        urls = _extract_urls(str(note.get("body") or ""))
        return _ok({"filename": filename, "count": len(urls), "urls": urls})


# ── whiteboard_transcribe ────────────────────────────────────────────


# Audio MIME prefixes that Whisper accepts via vLLM's librosa decoder.
# We don't insist on a strict allowlist here — `whisper_client` returns
# a graceful ``source="unavailable"`` if the bytes can't be decoded, and
# the tool just surfaces that to the agent.
_AUDIO_EXT_HINTS = (
    ".webm",
    ".ogg",
    ".oga",
    ".mp3",
    ".wav",
    ".m4a",
    ".mp4",
    ".aac",
    ".flac",
)


def _looks_like_audio(path: str) -> bool:
    lower = path.lower()
    return any(lower.endswith(ext) for ext in _AUDIO_EXT_HINTS)


async def transcribe_attachment_async(
    username: str,
    *,
    capture_id: Optional[str] = None,
    attachment_path: Optional[str] = None,
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """Resolve → fetch → transcribe. Always returns a dict.

    ``source`` is one of:
      - ``"whisper"`` — vLLM returned text.
      - ``"unavailable"`` — service down / timeout / non-200.
      - ``"disabled"`` — WhisperConfig.enabled is False.
      - ``"not_found"`` — couldn't resolve the attachment.

    The PostCaptureHook (W2) calls the same client on every audio
    capture and prepends the transcript to the draft note. This tool
    is the retry / on-demand surface for when:

      * the hook failed (network blip during initial capture), or
      * the user explicitly asks "transcribe that one again", or
      * an older audio attachment needs a transcript backfill.
    """
    rel = _resolve_attachment_path(
        username, capture_id=capture_id, attachment_path=attachment_path
    )
    if not rel:
        return {
            "text": "",
            "source": "not_found",
            "reason": "could not resolve capture_id / attachment_path",
        }
    if not _looks_like_audio(rel):
        return {
            "text": "",
            "source": "not_found",
            "reason": f"attachment {rel} doesn't look like audio",
            "attachment_path": rel,
        }
    data = _read_attachment_bytes(username, rel)
    if data is None:
        return {
            "text": "",
            "source": "not_found",
            "reason": f"attachment {rel} unavailable",
            "attachment_path": rel,
        }
    try:
        from service.stt.whisper_client import get_whisper_client
    except Exception:  # noqa: BLE001
        return {
            "text": "",
            "source": "unavailable",
            "error": "whisper_client import failed",
            "attachment_path": rel,
        }
    result = await get_whisper_client().atranscribe(
        data, filename=rel, language=language,
    )
    payload: Dict[str, Any] = {
        "text": result.text,
        "language": result.language,
        "duration_seconds": result.duration_seconds,
        "source": result.source,
        "attachment_path": rel,
    }
    if result.error:
        payload["error"] = result.error
    return payload


class WhiteboardTranscribeTool(BaseTool):
    """Re-transcribe a captured audio attachment via Whisper STT."""

    name = "whiteboard_transcribe"
    description = (
        "Transcribe a previously captured audio attachment to text "
        "using Whisper STT. Pass either capture_id (preferred) or "
        "attachment_path. The PostCaptureHook already auto-transcribes "
        "fresh audio captures into the inbox draft body — only call "
        "this tool when (a) the auto-transcript is missing/empty, "
        "(b) the user asks to re-transcribe, or (c) you're inspecting "
        "an older audio note. Pass language='ko' / 'en' to force a "
        "specific language; omit to let Whisper auto-detect (default)."
    )
    CAPABILITIES = ToolCapabilities(concurrency_safe=True)

    def run(
        self,
        session_id: str,
        capture_id: str = "",
        attachment_path: str = "",
        language: str = "",
    ) -> str:
        username = _resolve_username(session_id) or "anonymous"
        result = _run_async_in_sync_call(
            transcribe_attachment_async(
                username,
                capture_id=capture_id or None,
                attachment_path=attachment_path or None,
                language=language or None,
            )
        )
        return _ok(result)

    async def arun(
        self,
        session_id: str,
        capture_id: str = "",
        attachment_path: str = "",
        language: str = "",
    ) -> str:
        username = _resolve_username(session_id) or "anonymous"
        result = await transcribe_attachment_async(
            username,
            capture_id=capture_id or None,
            attachment_path=attachment_path or None,
            language=language or None,
        )
        return _ok(result)
