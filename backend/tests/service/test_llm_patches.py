"""Tests for ``service/llm_patches.py``.

Post-cycle-20260520 surface is much smaller — the four generic
Claude-Code CLI argv fixes that previously lived here folded into
``geny-executor`` 2.0.6 (``--verbose`` injection, ``--bare`` strip on
OAuth, drop of auto-``--tools ""``, ``StreamJsonAccumulator.finalize``
tool_use strip). What's left is Geny-specific and covered here:

  1. Korean friendly-error messages for stream-json ``is_error``
     result envelopes (auth-expired hint + generic API-error
     fallback).
  2. CLI-tool observability into Geny's :class:`SessionLogger`
     (``log_tool_use`` + ``log_tool_result`` for non-``mcp__*``
     blocks observed in the stream, routed through the
     :data:`cli_stream_logger_ctx` ContextVar).
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict, List

import pytest


# ── _friendly_error_message_for_result_envelope ─────────────────


def test_friendly_error_message_recognises_auth_failure() -> None:
    from service.llm_patches import _friendly_error_message_for_result_envelope

    msg = _friendly_error_message_for_result_envelope({
        "type": "result",
        "is_error": True,
        "api_error_status": 401,
        "error": "authentication_failed",
        "result": "Failed to authenticate. API Error: 401",
    })
    # Korean prompt that points the user at the LLM Backends Settings card.
    assert "Claude Code 인증이 만료" in msg
    assert "LLM 백엔드" in msg
    # The raw CLI message is appended as ``(원본: ...)`` for forensics.
    assert "Failed to authenticate" in msg


def test_friendly_error_message_generic_api_error() -> None:
    from service.llm_patches import _friendly_error_message_for_result_envelope

    msg = _friendly_error_message_for_result_envelope({
        "type": "result",
        "is_error": True,
        "api_error_status": 500,
        "error": "internal_server_error",
        "result": "Upstream provider returned 500",
    })
    assert "Claude Code API 에러" in msg
    assert "500" in msg
    assert "Upstream provider returned 500" in msg


def test_friendly_error_message_no_api_status_falls_back_to_cli_error() -> None:
    from service.llm_patches import _friendly_error_message_for_result_envelope

    msg = _friendly_error_message_for_result_envelope({
        "type": "result",
        "is_error": True,
        "result": "claude binary segfaulted",
    })
    assert "Claude Code CLI 에러" in msg
    assert "claude binary segfaulted" in msg


# ── _maybe_extract_error_envelope ───────────────────────────────


def test_maybe_extract_error_envelope_accepts_bytes_and_str() -> None:
    from service.llm_patches import _maybe_extract_error_envelope

    payload = json.dumps({
        "type": "result", "is_error": True, "api_error_status": 401,
    })
    assert _maybe_extract_error_envelope(payload.encode("utf-8"))
    assert _maybe_extract_error_envelope(payload)
    assert _maybe_extract_error_envelope(bytearray(payload, "utf-8"))


@pytest.mark.parametrize("payload", [
    b"",
    b"  ",
    b"not json",
    json.dumps({"type": "assistant"}).encode("utf-8"),
    json.dumps({"type": "result"}).encode("utf-8"),  # no is_error
    json.dumps({"type": "result", "is_error": False}).encode("utf-8"),
    json.dumps([1, 2, 3]).encode("utf-8"),  # not a dict
])
def test_maybe_extract_error_envelope_returns_none_for_non_error_lines(
    payload: bytes,
) -> None:
    from service.llm_patches import _maybe_extract_error_envelope

    assert _maybe_extract_error_envelope(payload) is None


# ── install_llm_patches: idempotency + re-export coverage ──


def test_install_is_idempotent() -> None:
    """Calling ``install_llm_patches()`` multiple times must be a
    no-op after the first install — the assembler wrapper and the
    accumulator observability patch both use cached state, so a
    second call leaves the patched attributes pointing at the
    *same* wrapper object."""
    from service.llm_patches import install_llm_patches

    # First install (might happen at app boot before this test).
    install_llm_patches()

    import importlib

    cli_translator = importlib.import_module(
        "geny_executor.llm_client.translators._cli"
    )
    first_assembler = cli_translator.assemble_response_from_stream_json
    first_accum_feed = cli_translator.StreamJsonAccumulator.feed

    # Second install — should hit the cached-wrapper path.
    install_llm_patches()

    second_assembler = cli_translator.assemble_response_from_stream_json
    second_accum_feed = cli_translator.StreamJsonAccumulator.feed

    # Same instance, no double-stacking.
    assert first_assembler is second_assembler
    assert first_accum_feed is second_accum_feed


def test_install_patches_assembler_across_re_exports() -> None:
    """The assembler is re-exported from three modules; all the
    attributes must point at the wrapper after install so any caller
    that captured a local binding hits it."""
    from service.llm_patches import install_llm_patches

    install_llm_patches()

    import importlib
    modules = [
        "geny_executor.llm_client.translators._cli",
        "geny_executor.llm_client.translators",
        "geny_executor.llm_client.claude_code",
    ]
    fns = []
    for name in modules:
        mod = importlib.import_module(name)
        fn = getattr(mod, "assemble_response_from_stream_json", None)
        if fn is not None:
            fns.append(fn)
    assert len(fns) >= 2  # at least source + one re-export
    assert all(fn is fns[0] for fn in fns)


# ── assembler-side: stream-json error envelope → friendly raise ──


@pytest.mark.asyncio
async def test_assembler_patch_raises_friendly_error_on_auth_failure() -> None:
    """When the stream ends with an ``is_error: true`` result
    envelope, the patched assembler must raise a Korean human-readable
    error instead of silently returning an empty response."""
    from service.llm_patches import install_llm_patches

    install_llm_patches()

    import importlib
    cli_translator = importlib.import_module(
        "geny_executor.llm_client.translators._cli"
    )
    assemble = cli_translator.assemble_response_from_stream_json

    async def _gen() -> AsyncIterator[bytes]:
        yield b'{"type": "system", "session_id": "s1"}\n'
        yield (
            b'{"type": "result", "is_error": true, "api_error_status": 401, '
            b'"error": "authentication_failed", '
            b'"result": "Failed to authenticate. API Error: 401"}\n'
        )

    with pytest.raises(RuntimeError, match="Claude Code 인증이 만료"):
        await assemble(_gen(), model="m")


@pytest.mark.asyncio
async def test_assembler_patch_passes_through_clean_stream() -> None:
    """Clean streams (no ``is_error`` envelope) must produce a valid
    APIResponse with the text content intact."""
    from service.llm_patches import install_llm_patches

    install_llm_patches()

    import importlib
    cli_translator = importlib.import_module(
        "geny_executor.llm_client.translators._cli"
    )
    assemble = cli_translator.assemble_response_from_stream_json

    async def _gen() -> AsyncIterator[bytes]:
        yield b'{"type": "system", "session_id": "s1", "model": "sonnet"}\n'
        yield b'{"type": "assistant", "delta": {"type": "text_delta", "text": "ok"}}\n'
        yield b'{"type": "message_stop"}\n'
        yield (
            b'{"type": "result", "stop_reason": "end_turn", '
            b'"usage": {"input_tokens": 1, "output_tokens": 1}}\n'
        )

    resp = await assemble(_gen(), model="default")
    assert resp.text == "ok"
    assert resp.stop_reason == "end_turn"


# ── Stream observability: CLI built-in tool calls → SessionLogger ──


class _FakeLogger:
    """Minimal stand-in for Geny's ``SessionLogger``. Records every
    ``log_tool_use`` / ``log_tool_result`` call so tests can assert on
    the observability patch's behavior without booting the real
    logger + DB."""

    def __init__(self) -> None:
        self.tool_uses: List[Dict[str, Any]] = []
        self.tool_results: List[Dict[str, Any]] = []

    def log_tool_use(self, **kwargs: Any) -> None:
        self.tool_uses.append(kwargs)

    def log_tool_result(self, **kwargs: Any) -> None:
        self.tool_results.append(kwargs)


def test_observability_emits_tool_use_for_assistant_envelope() -> None:
    """``"assistant"`` envelopes carrying a non-``mcp__*`` ``tool_use``
    block trigger a ``log_tool_use`` call on the active session logger."""
    from service.llm_patches import (
        cli_stream_logger_ctx,
        install_llm_patches,
    )
    install_llm_patches()

    import importlib
    cli_translator = importlib.import_module(
        "geny_executor.llm_client.translators._cli"
    )
    accum = cli_translator.StreamJsonAccumulator(model="m")
    fake = _FakeLogger()
    token = cli_stream_logger_ctx.set(fake)
    try:
        accum.feed({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "id": "tu_1", "name": "Bash",
                     "input": {"command": "ls"}},
                ],
            },
        })
    finally:
        cli_stream_logger_ctx.reset(token)

    assert len(fake.tool_uses) == 1
    call = fake.tool_uses[0]
    assert call["tool_name"] == "Bash"
    assert call["tool_id"] == "tu_1"
    assert call["tool_input"] == {"command": "ls"}


def test_observability_skips_mcp_prefixed_tools() -> None:
    """MCP tools are already logged from ``mcp_bridge_controller`` —
    the observability patch must NOT double-render them."""
    from service.llm_patches import (
        cli_stream_logger_ctx,
        install_llm_patches,
    )
    install_llm_patches()

    import importlib
    cli_translator = importlib.import_module(
        "geny_executor.llm_client.translators._cli"
    )
    accum = cli_translator.StreamJsonAccumulator(model="m")
    fake = _FakeLogger()
    token = cli_stream_logger_ctx.set(fake)
    try:
        accum.feed({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "id": "mc_1",
                     "name": "mcp__geny__send_direct_message_internal",
                     "input": {"content": "hi"}},
                ],
            },
        })
    finally:
        cli_stream_logger_ctx.reset(token)

    assert fake.tool_uses == []


def test_observability_emits_tool_result_with_duration() -> None:
    """A matching ``"user"`` ``tool_result`` envelope triggers a
    ``log_tool_result`` call with measured ``duration_ms`` and the
    extracted result text."""
    from service.llm_patches import (
        cli_stream_logger_ctx,
        install_llm_patches,
    )
    install_llm_patches()

    import importlib
    cli_translator = importlib.import_module(
        "geny_executor.llm_client.translators._cli"
    )
    accum = cli_translator.StreamJsonAccumulator(model="m")
    fake = _FakeLogger()
    token = cli_stream_logger_ctx.set(fake)
    try:
        accum.feed({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "id": "tu_1", "name": "Read",
                     "input": {"path": "/etc/hostname"}},
                ],
            },
        })
        accum.feed({
            "type": "user",
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "tu_1",
                     "content": "myhost\n"},
                ],
            },
        })
    finally:
        cli_stream_logger_ctx.reset(token)

    assert len(fake.tool_results) == 1
    res = fake.tool_results[0]
    assert res["tool_name"] == "Read"
    assert res["tool_id"] == "tu_1"
    assert res["result"] == "myhost\n"
    assert res["is_error"] is False
    assert isinstance(res["duration_ms"], int) and res["duration_ms"] >= 0


def test_observability_handles_content_block_list_result_shape() -> None:
    """Tool results can arrive as either a plain string OR a list of
    ``{"type":"text","text":...}`` content blocks. The patch
    flattens the list shape into a newline-joined string."""
    from service.llm_patches import (
        cli_stream_logger_ctx,
        install_llm_patches,
    )
    install_llm_patches()

    import importlib
    cli_translator = importlib.import_module(
        "geny_executor.llm_client.translators._cli"
    )
    accum = cli_translator.StreamJsonAccumulator(model="m")
    fake = _FakeLogger()
    token = cli_stream_logger_ctx.set(fake)
    try:
        accum.feed({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "id": "tu_1", "name": "Bash",
                     "input": {"command": "echo hi"}},
                ],
            },
        })
        accum.feed({
            "type": "user",
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "tu_1",
                     "content": [
                         {"type": "text", "text": "hi"},
                         {"type": "text", "text": "(exit 0)"},
                     ]},
                ],
            },
        })
    finally:
        cli_stream_logger_ctx.reset(token)

    assert fake.tool_results[0]["result"] == "hi\n(exit 0)"


def test_observability_inert_without_active_context() -> None:
    """If no ``cli_stream_logger_ctx`` is set (e.g. the accumulator is
    driven outside a session-bound code path), the patch must
    silently no-op rather than crash."""
    from service.llm_patches import install_llm_patches
    install_llm_patches()

    import importlib
    cli_translator = importlib.import_module(
        "geny_executor.llm_client.translators._cli"
    )
    accum = cli_translator.StreamJsonAccumulator(model="m")
    # No context set → ContextVar is the default ``None``.
    accum.feed({
        "type": "assistant",
        "message": {
            "content": [
                {"type": "tool_use", "id": "tu_1", "name": "Bash",
                 "input": {"command": "ls"}},
            ],
        },
    })
    # No exception is the assertion; the patch is a no-op when the
    # ContextVar isn't set, so there's nothing observable to compare.
