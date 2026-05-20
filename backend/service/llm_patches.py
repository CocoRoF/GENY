"""
Runtime patches for ``geny-executor``'s LLM client integrations.

Why this exists (cycle 20260520, post-2.0.6)
--------------------------------------------
``geny-executor`` 2.0.6 absorbed every generic Claude-Code CLI compat
patch this module used to carry — ``--verbose`` auto-injection for
stream-json output, ``--bare`` strip on the OAuth path, drop of the
auto-``--tools ""`` emit (CLI built-ins now stay available alongside
MCP-wrapped host tools), and the ``StreamJsonAccumulator.finalize``
``tool_use`` strip that keeps Stage 10 from ghost-erroring against the
CLI's internal dispatches. None of those need monkey-patching anymore;
the executor's argv builder + accumulator behave correctly out of the
box for hosts pinned to ``>=2.0.6``.

Two Geny-specific hooks remain here:

1. **Friendly Korean error message for auth-expired envelopes.** The
   executor surfaces a generic ``RuntimeError``; we sugar the wire-shape
   ``{"is_error": true, "api_error_status": 401,
   "error": "authentication_failed"}`` into a Korean human-readable
   prompt that points the user at the LLM Backends Settings card. Same
   patch turns other ``is_error`` result envelopes into a structured
   message instead of the runtime's empty-stderr fallback.

2. **CLI-handled tool call observability into Geny's SessionLogger.**
   The executor (correctly, per the Phase-I design contract) drops
   ``tool_use`` blocks from its assembled ``APIResponse`` so host
   pipelines don't try to re-dispatch them. That also means Geny's
   Stage 10 never fires the ``tool.call_start`` / ``tool.call_complete``
   events the session_logger taps into for *CLI built-in* (Bash, Read,
   Write, Edit, Glob, Grep, WebFetch, WebSearch, …) tool use — those
   tools never round-trip through Geny's MCP bridge either, so without
   an explicit tap they would disappear from the session log entirely.
   We monkey-patch ``StreamJsonAccumulator.feed`` to peek at every
   stream-json line, emit ``session_logger.log_tool_use`` /
   ``log_tool_result`` for non-``mcp__*`` tool blocks (MCP tools are
   already logged from ``mcp_bridge_controller``; duplicating would
   render them twice in the UI), and route the logger through a
   ``ContextVar`` set by ``AgentSession.invoke()`` / ``astream()``
   for the duration of a turn.

Both patches will fold upstream eventually — error envelope friendly
messages once the executor gains a proper i18n hook, and the
observability tap once the executor emits first-class CLI-tool
events through the pipeline event bus. Until then they live here.
"""

from __future__ import annotations

import json
import time
from contextvars import ContextVar
from logging import getLogger
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

logger = getLogger(__name__)


_ASSEMBLER_PATCH_APPLIED_FLAG = "_geny_assembler_error_patch_applied"
_OBSERVABILITY_PATCH_APPLIED_FLAG = "_geny_accumulator_observability_patch_applied"


# Context variable carrying the active Geny ``SessionLogger`` so the
# stream-observability monkey-patch on ``StreamJsonAccumulator`` can
# emit ``log_tool_use`` / ``log_tool_result`` entries for *CLI-handled*
# tools (Bash / Read / Write / Edit / …) without having to thread a
# logger through the executor's LLM-client layer.
#
# ``agent_session.astream()`` / ``invoke()`` set this for the duration
# of a turn; the accumulator's ``feed()`` (which the executor calls
# concurrently inside the streaming code path) reads it. Default
# ``None`` makes the patch a no-op when no Geny session context is
# active — e.g. unit tests that drive the accumulator directly.
cli_stream_logger_ctx: ContextVar[Optional[Any]] = ContextVar(
    "geny_cli_stream_logger_ctx", default=None,
)

# Cached wrappers, re-used across repeated ``install_llm_patches()``
# calls so the wrapper identity stays consistent on every patched
# module attribute. The Geny app boot can call ``install_llm_patches()``
# multiple times during config reloads; without cached wrappers we'd
# either double-stack or leave stale references on whichever module
# didn't get re-patched.
_cached_assembler_wrapper: Any = None
_cached_accumulator_init: Any = None
_cached_accumulator_feed: Any = None


# Human-readable message shown to the end user when the Claude CLI
# reports an authentication failure. Surfaces the actionable next
# step ("re-login in the settings card") instead of the un-helpful
# ``CLI '/usr/bin/claude' exited with code 1:`` empty-stderr trace
# the runtime would otherwise raise.
_AUTH_EXPIRED_MESSAGE = (
    "Claude Code 인증이 만료됐어요. "
    "설정 → LLM 백엔드 → Claude Code 카드의 "
    "‘다시 로그인 / Sign in’ 을 눌러 인증을 갱신해주세요."
)


def _friendly_error_message_for_result_envelope(envelope: Dict[str, Any]) -> str:
    """Turn a stream-json ``result`` envelope (with ``is_error: true``)
    into a single human-friendly line.

    Recognises the auth-failed shape Claude Code emits when the
    OAuth ``accessToken`` expired and refresh fails::

        {"type": "result", "is_error": true, "api_error_status": 401,
         "error": "authentication_failed",
         "result": "Failed to authenticate. API Error: 401 …"}

    Other API errors get a generic but still useful summary instead
    of the empty-stderr fallback the runtime would otherwise raise.
    """
    api_status = envelope.get("api_error_status")
    error_str = str(envelope.get("error") or "").strip()
    result_msg = str(envelope.get("result") or "").strip()
    if api_status == 401 or error_str == "authentication_failed":
        suffix = f" (원본: {result_msg})" if result_msg else ""
        return _AUTH_EXPIRED_MESSAGE + suffix
    if api_status:
        return f"Claude Code API 에러 ({api_status}): {result_msg or error_str or 'unknown'}"
    return (
        f"Claude Code CLI 에러: {result_msg or error_str or 'unknown'}"
    )


def _maybe_extract_error_envelope(raw: Any) -> Optional[Dict[str, Any]]:
    """Parse one stream-json line and return it iff it represents an
    ``is_error`` result envelope. ``None`` for everything else.

    Handles both ``bytes`` and ``str`` inputs because the runner
    yields ``bytes`` but tests may use ``str`` fixtures.
    """
    try:
        if isinstance(raw, (bytes, bytearray)):
            text = bytes(raw).decode("utf-8", errors="replace")
        else:
            text = str(raw)
        text = text.strip()
        if not text:
            return None
        line = json.loads(text)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(line, dict):
        return None
    if line.get("type") != "result":
        return None
    if not line.get("is_error"):
        return None
    return line


def install_llm_patches() -> None:
    """Idempotently install Geny's two remaining ``geny-executor``
    monkey-patches: friendly Korean error envelopes + CLI-tool
    observability into Geny's SessionLogger.

    Safe to call multiple times. Both installers are themselves
    idempotent (assembler uses a cached wrapper and ``_original``
    unwrap; accumulator uses a class-level applied flag).
    """
    _install_assembler_error_patch()
    _install_stream_observability_patch()


# ── Stream-json error envelope detection ─────────────────────────────


def _install_assembler_error_patch() -> None:
    """Wrap ``assemble_response_from_stream_json`` so that an
    ``is_error: true`` result envelope on the wire turns into a
    *friendly* RuntimeError instead of the runtime's empty-stderr
    ``CLI '/usr/bin/claude' exited with code 1:`` fallback.

    Three-module pattern: the caller in
    ``geny_executor.llm_client.claude_code.py`` does
    ``from … import assemble_response_from_stream_json`` and captures
    a local binding at module load. We re-bind the attribute in all
    three modules to the same wrapper instance.
    """
    import importlib

    candidate_modules = [
        "geny_executor.llm_client.translators._cli",
        "geny_executor.llm_client.translators",
        "geny_executor.llm_client.claude_code",
    ]

    try:
        cli_translator = importlib.import_module(candidate_modules[0])
    except Exception:  # noqa: BLE001
        return

    original = getattr(cli_translator, "assemble_response_from_stream_json", None)
    if original is None:
        return
    # Unwrap stale wrappers from previous installs so the underlying
    # call always lands on the pristine function.
    while getattr(original, _ASSEMBLER_PATCH_APPLIED_FLAG, False):
        inner = getattr(original, "_original", None)
        if inner is None:
            break
        original = inner

    global _cached_assembler_wrapper
    if _cached_assembler_wrapper is None:
        async def _wrapped(
            stream: AsyncIterator[Any], *, model: str,
        ) -> Any:
            """Spy on the stream-json output. If the CLI emitted an
            ``is_error`` result envelope, raise a Korean human-readable
            error instead of letting the runtime's empty-stderr
            fallback kick in."""
            err_holder: List[Dict[str, Any]] = []

            async def _spy() -> AsyncIterator[Any]:
                async for raw in stream:
                    envelope = _maybe_extract_error_envelope(raw)
                    if envelope is not None:
                        err_holder.append(envelope)
                    yield raw

            try:
                response = await original(_spy(), model=model)
            except Exception as exc:
                if err_holder:
                    msg = _friendly_error_message_for_result_envelope(
                        err_holder[-1]
                    )
                    raise RuntimeError(msg) from exc
                raise

            if err_holder:
                # Stream completed cleanly but the CLI flagged an
                # error in the final envelope. Raise so the upstream
                # path treats it as a real failure (the assembler's
                # default behaviour is to swallow ``is_error`` and
                # return a near-empty response, which then floats up
                # to the user as ``CLI exited with code 1:``).
                raise RuntimeError(
                    _friendly_error_message_for_result_envelope(err_holder[-1])
                )

            return response

        setattr(_wrapped, _ASSEMBLER_PATCH_APPLIED_FLAG, True)
        setattr(_wrapped, "_original", original)
        _cached_assembler_wrapper = _wrapped

    patched: List[str] = []
    for mod_name in candidate_modules:
        try:
            mod = importlib.import_module(mod_name)
        except Exception:  # noqa: BLE001
            continue
        if getattr(mod, "assemble_response_from_stream_json", None) is None:
            continue
        setattr(mod, "assemble_response_from_stream_json", _cached_assembler_wrapper)
        patched.append(mod_name)

    if patched:
        logger.info(
            "[llm_patches] installed Claude Code stream-json error patch "
            "across %d modules: %s",
            len(patched), ", ".join(patched),
        )


# ── StreamJsonAccumulator observability: surface CLI built-ins ──────


def _install_stream_observability_patch() -> None:
    """Monkey-patch ``StreamJsonAccumulator.feed`` so every CLI-handled
    ``tool_use`` / ``tool_result`` block observed in the stream gets
    surfaced to Geny's :class:`SessionLogger` via
    :data:`cli_stream_logger_ctx`.

    Why
    ---
    With executor 2.0.6's terminal-response strip of ``tool_use``
    blocks, Geny's Stage 10 naturally no-ops for ``claude_code_cli``
    sessions — which means the in-pipeline ``tool.call_start`` /
    ``tool.call_complete`` events never fire and CLI-handled tools
    (``Bash`` / ``Read`` / ``Write`` / ``Edit`` / ``WebFetch`` / …)
    disappear from the session log. ``mcp_bridge_controller`` already
    emits log entries for MCP ``tools/call`` traffic (the bridge sees
    those directly), so that surface is covered.

    The remaining gap is the *CLI built-in* layer: tools the CLI
    dispatches **internally** without going through our bridge. They
    only show up in the stream-json output that the executor parses
    via ``StreamJsonAccumulator`` — which is what this patch taps.

    Mechanics
    ---------
    - On each ``feed(line)`` call, peek at the line *after* delegating
      to the original feed.
    - ``"assistant"`` envelopes carry ``tool_use`` blocks → emit
      ``session_logger.log_tool_use`` for each, and stash
      ``(name, monotonic_start)`` per ``tool_use_id`` so the matching
      ``tool_result`` later can be timed.
    - ``"user"`` envelopes carry ``tool_result`` blocks → look up the
      stashed start time, compute ``duration_ms``, extract content
      (CLI emits both string and ``content_block_text`` shapes here),
      and emit ``log_tool_result``.
    - Skip names starting with ``mcp__`` — those are MCP tools and
      ``mcp_bridge_controller`` already logs them with more accurate
      timing + actual dispatch outcome. Logging them again here would
      double-render in the UI.
    - All logger calls are try/except'd; observability must never
      break the underlying tool dispatch.
    """
    import importlib

    try:
        cli_translator = importlib.import_module(
            "geny_executor.llm_client.translators._cli"
        )
    except Exception:  # noqa: BLE001
        return
    accum_cls = getattr(cli_translator, "StreamJsonAccumulator", None)
    if accum_cls is None:
        return

    if getattr(accum_cls, _OBSERVABILITY_PATCH_APPLIED_FLAG, False):
        # Already patched in a prior install. Re-applying would
        # double-stack the wrappers; bail.
        return

    original_init = accum_cls.__init__
    original_feed = accum_cls.feed

    def _patched_init(self: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        # Per-instance side table: tool_use_id → (tool_name, monotonic_start).
        # The accumulator is single-use (one per CLI invocation) so the
        # table never spans turns; growth is bounded by the CLI's
        # internal-loop turn count.
        self._geny_obs_pending: Dict[str, Tuple[str, float]] = {}

    def _patched_feed(self: Any, line: Any) -> Any:
        events = original_feed(self, line)
        # Best-effort observability — emit *after* the original feed
        # so a parse error in the original surfaces unchanged.
        try:
            if isinstance(line, dict):
                _maybe_emit_cli_tool_events(self, line)
        except Exception:  # noqa: BLE001
            logger.debug(
                "[llm_patches] CLI observability emit failed (continuing)",
                exc_info=True,
            )
        return events

    accum_cls.__init__ = _patched_init
    accum_cls.feed = _patched_feed
    setattr(accum_cls, _OBSERVABILITY_PATCH_APPLIED_FLAG, True)

    global _cached_accumulator_init, _cached_accumulator_feed
    _cached_accumulator_init = _patched_init
    _cached_accumulator_feed = _patched_feed

    logger.info(
        "[llm_patches] installed StreamJsonAccumulator observability "
        "patch (CLI built-in tool calls now surface to session log)"
    )


def _maybe_emit_cli_tool_events(accum: Any, line: Dict[str, Any]) -> None:
    """Inspect one stream-json line and emit ``log_tool_use`` /
    ``log_tool_result`` on the active session logger as appropriate.

    Pure observability — never mutates the accumulator's parsing state.
    """
    sl = cli_stream_logger_ctx.get()
    if sl is None:
        return  # No Geny session context — patch is inert.

    ltype = str(line.get("type", ""))
    if ltype not in ("assistant", "user"):
        return

    message = line.get("message")
    if not isinstance(message, dict):
        return
    content = message.get("content")
    if not isinstance(content, list):
        return

    pending: Dict[str, Tuple[str, float]] = getattr(
        accum, "_geny_obs_pending", None,
    ) or {}

    for block in content:
        if not isinstance(block, dict):
            continue
        btype = str(block.get("type", ""))

        # Assistant turn → record + log tool_use
        if ltype == "assistant" and btype == "tool_use":
            tu_id = str(block.get("id") or "")
            tu_name = str(block.get("name") or "")
            tu_input = block.get("input") or {}
            if not tu_id or not tu_name:
                continue
            if tu_name.startswith("mcp__"):
                # MCP tools are logged from the bridge controller —
                # avoid double-render in the UI.
                continue
            if tu_id in pending:
                # Already saw this tool_use — duplicate envelope, skip.
                continue
            pending[tu_id] = (tu_name, time.monotonic())
            try:
                sl.log_tool_use(
                    tool_name=tu_name,
                    tool_input=tu_input if isinstance(tu_input, dict) else {},
                    tool_id=tu_id,
                )
            except Exception:  # noqa: BLE001
                logger.debug(
                    "[llm_patches] log_tool_use failed for %s", tu_name,
                    exc_info=True,
                )

        # User turn (tool_result) → look up pending, emit result
        elif ltype == "user" and btype == "tool_result":
            tu_id = str(block.get("tool_use_id") or "")
            if not tu_id:
                continue
            entry = pending.pop(tu_id, None)
            if entry is None:
                # Saw a result without a matching prior tool_use.
                # Either we skipped the tool_use (e.g. mcp__ prefix)
                # or the CLI emitted out of order; either way silently
                # ignore — the matching log_tool_use already happened
                # in the bridge for the MCP case.
                continue
            tu_name, start_time = entry
            # Result content can be a plain string OR a list of
            # ``{"type":"text"|"image"|…, "text": ...}`` blocks.
            raw_result = block.get("content")
            if isinstance(raw_result, list):
                parts: List[str] = []
                for c in raw_result:
                    if isinstance(c, dict) and c.get("type") == "text":
                        parts.append(str(c.get("text", "")))
                    elif isinstance(c, dict):
                        parts.append(json.dumps(c, ensure_ascii=False))
                    else:
                        parts.append(str(c))
                result_text: Optional[str] = "\n".join(parts) if parts else None
            elif isinstance(raw_result, str):
                result_text = raw_result
            elif raw_result is None:
                result_text = None
            else:
                try:
                    result_text = json.dumps(raw_result, ensure_ascii=False)
                except (TypeError, ValueError):
                    result_text = str(raw_result)
            is_error = bool(block.get("is_error", False))
            duration_ms = int((time.monotonic() - start_time) * 1000)
            try:
                sl.log_tool_result(
                    tool_name=tu_name,
                    tool_id=tu_id,
                    result=result_text,
                    is_error=is_error,
                    duration_ms=duration_ms,
                )
            except Exception:  # noqa: BLE001
                logger.debug(
                    "[llm_patches] log_tool_result failed for %s", tu_name,
                    exc_info=True,
                )
