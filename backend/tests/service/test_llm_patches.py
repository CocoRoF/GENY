"""Tests for the Claude Code CLI argv runtime patch.

Validates the pure ``_patched_argv`` predicate function plus the
idempotent monkey-patch installer.
"""

from __future__ import annotations

import pytest


# ── Pure transformation ──────────────────────────────────────────────


def test_streaming_argv_gets_verbose_inserted() -> None:
    from service.llm_patches import _patched_argv

    original = [
        "--print",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--model", "claude-opus-4-7",
    ]
    patched = _patched_argv(original)

    assert patched != original, "argv should be modified"
    assert "--verbose" in patched
    # Order matters for readable logs: ``--verbose`` immediately after
    # ``--print``.
    print_idx = patched.index("--print")
    assert patched[print_idx + 1] == "--verbose"


def test_non_streaming_argv_is_untouched() -> None:
    """``--output-format json`` (non-streaming) doesn't need
    ``--verbose`` — the CLI accepts it as-is. Patch must NOT add
    ``--verbose`` in that case to avoid changing semantics."""
    from service.llm_patches import _patched_argv

    original = [
        "--print",
        "--output-format", "json",
        "--model", "claude-opus-4-7",
    ]
    patched = _patched_argv(original)
    assert "--verbose" not in patched
    assert patched == original


def test_argv_with_existing_verbose_is_untouched() -> None:
    """Defensive: if a future ``geny-executor`` ships the fix
    upstream, our patch must become a no-op so we don't double-add."""
    from service.llm_patches import _patched_argv

    original = [
        "--print",
        "--verbose",
        "--output-format", "stream-json",
    ]
    patched = _patched_argv(original)
    assert patched == original
    assert patched.count("--verbose") == 1


def test_argv_without_output_format_is_untouched() -> None:
    from service.llm_patches import _patched_argv

    original = ["--print", "--model", "x"]
    assert _patched_argv(original) == original


def test_argv_with_stream_json_input_only_is_untouched() -> None:
    """``--input-format stream-json`` doesn't trigger the
    ``--print --output-format`` requirement; only the *output* format
    does. Patch must only react to the output-format pair."""
    from service.llm_patches import _patched_argv

    original = [
        "--print",
        "--input-format", "stream-json",
        "--output-format", "json",
    ]
    patched = _patched_argv(original)
    assert "--verbose" not in patched
    assert patched == original


def test_argv_with_dangling_output_format_at_end() -> None:
    """Defensive: ``--output-format`` is the last token with no value.
    Don't crash — just leave it alone."""
    from service.llm_patches import _patched_argv

    original = ["--print", "--output-format"]
    patched = _patched_argv(original)
    assert patched == original  # No crash, no insertion.


# ── Installer ────────────────────────────────────────────────────────


def test_install_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Repeated installs must not double-wrap the function. The
    wrapper is flagged with ``_geny_verbose_patch_applied`` so the
    second call sees the flag and returns early."""
    pytest.importorskip("geny_executor.llm_client.translators._cli")
    from service.llm_patches import install_llm_patches
    from geny_executor.llm_client.translators import _cli

    pristine = _cli.claude_code_argv
    try:
        install_llm_patches()
        once = _cli.claude_code_argv
        install_llm_patches()
        twice = _cli.claude_code_argv
        assert once is twice, "second install must be a no-op"
        # Confirm the wrapper exposes the original so future re-stacks
        # can chain off it.
        assert hasattr(once, "_original")
    finally:
        _cli.claude_code_argv = pristine


def test_install_patches_every_re_export_namespace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The function is re-exported across THREE modules; patching
    only the source isn't enough because the caller did
    ``from … import claude_code_argv`` and captured a local binding.

    Without patching all three, the live CLI invocation in
    ``claude_code.py`` (line 178) still calls the pristine function
    and the user sees ``--verbose`` error in prod. This test pins
    the bug we hit on 2026-05-18.
    """
    pytest.importorskip("geny_executor.llm_client.translators._cli")
    import importlib

    from service.llm_patches import install_llm_patches

    modules = [
        importlib.import_module("geny_executor.llm_client.translators._cli"),
        importlib.import_module("geny_executor.llm_client.translators"),
        importlib.import_module("geny_executor.llm_client.claude_code"),
    ]
    pristines = [getattr(m, "claude_code_argv") for m in modules]

    try:
        install_llm_patches()
        wrapped = [getattr(m, "claude_code_argv") for m in modules]
        # Every module must point at a wrapper, AND they must all be
        # the same wrapper instance so a stale reference can't slip
        # through.
        for fn in wrapped:
            assert hasattr(fn, "_geny_verbose_patch_applied")
        assert wrapped[0] is wrapped[1] is wrapped[2], (
            "all three modules must share the same wrapper — otherwise "
            "claude_code.py keeps calling the pristine function"
        )
    finally:
        for m, original in zip(modules, pristines):
            setattr(m, "claude_code_argv", original)


def test_install_patches_claude_code_caller_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end pin for the user's reported regression: invoke the
    argv builder through the same import path ``claude_code.py``
    uses (``claude_code.claude_code_argv``) and verify ``--verbose``
    lands in the result. This is what the live CLI invocation does
    at runtime."""
    pytest.importorskip("geny_executor.llm_client.claude_code")
    import importlib

    from service.llm_patches import install_llm_patches

    cc_module = importlib.import_module(
        "geny_executor.llm_client.claude_code"
    )
    cli_module = importlib.import_module(
        "geny_executor.llm_client.translators._cli"
    )
    translators_pkg = importlib.import_module(
        "geny_executor.llm_client.translators"
    )

    pristine_cc = cc_module.claude_code_argv
    pristine_cli = cli_module.claude_code_argv
    pristine_pkg = translators_pkg.claude_code_argv

    try:
        install_llm_patches()

        class _Req:
            stream = True
            model = "claude-opus-4-7"
            system = ""
            thinking = None
            response_format = None
            session_hint = None

        # The crucial assertion: the function call path
        # ``claude_code.claude_code_argv(...)`` must return an argv
        # that contains ``--verbose``. Before the deep-patch fix this
        # returned the pristine result and the prod session crashed.
        argv = cc_module.claude_code_argv(_Req())
        assert "--verbose" in argv, (
            "claude_code.py's local binding must point at the patched "
            "wrapper, otherwise the live CLI invocation crashes with "
            "'When using --print, --output-format=stream-json requires "
            "--verbose'"
        )
    finally:
        cc_module.claude_code_argv = pristine_cc
        cli_module.claude_code_argv = pristine_cli
        translators_pkg.claude_code_argv = pristine_pkg


def test_install_actually_patches_streaming_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: install the patch, then invoke ``claude_code_argv``
    the way geny-executor's caller does and assert ``--verbose``
    lands in the argv."""
    pytest.importorskip("geny_executor.llm_client.translators._cli")
    from service.llm_patches import install_llm_patches
    from geny_executor.llm_client.translators import _cli

    pristine = _cli.claude_code_argv
    try:
        install_llm_patches()

        # Build a minimal ``ChatCompletionRequest``-shaped object the
        # function expects. We use a duck-typed stub to avoid pulling
        # the full geny_executor request model.
        class _Req:
            stream = True
            model = "claude-opus-4-7"
            system = ""
            thinking = None
            response_format = None
            session_hint = None

        argv = _cli.claude_code_argv(_Req())
        assert "--print" in argv
        assert "--output-format" in argv
        of_idx = argv.index("--output-format")
        assert argv[of_idx + 1] == "stream-json"
        assert "--verbose" in argv, (
            "patch must inject --verbose for stream-json output"
        )
        print_idx = argv.index("--print")
        assert argv[print_idx + 1] == "--verbose", (
            "--verbose must sit right after --print for readable logs"
        )
    finally:
        _cli.claude_code_argv = pristine


# ── Assembler patch: stream-json error → friendly message ────────────


def test_friendly_error_message_recognises_auth_failure() -> None:
    from service.llm_patches import _friendly_error_message_for_result_envelope

    envelope = {
        "type": "result",
        "is_error": True,
        "api_error_status": 401,
        "error": "authentication_failed",
        "result": "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    }
    msg = _friendly_error_message_for_result_envelope(envelope)
    assert "Claude Code 인증이 만료" in msg
    assert "다시 로그인" in msg or "Sign in" in msg
    # And the original error is preserved so an operator inspecting
    # logs can see the underlying API message.
    assert "401" in msg


def test_friendly_error_message_for_generic_api_error() -> None:
    from service.llm_patches import _friendly_error_message_for_result_envelope

    envelope = {
        "type": "result",
        "is_error": True,
        "api_error_status": 503,
        "error": "overloaded",
        "result": "Service unavailable, please retry",
    }
    msg = _friendly_error_message_for_result_envelope(envelope)
    assert "Claude Code API 에러" in msg
    assert "503" in msg
    # Non-401 must NOT use the auth-expired message.
    assert "인증이 만료" not in msg


def test_maybe_extract_error_envelope_accepts_bytes_and_str() -> None:
    from service.llm_patches import _maybe_extract_error_envelope

    line_bytes = b'{"type":"result","is_error":true,"api_error_status":401}'
    line_str = '{"type":"result","is_error":true,"api_error_status":401}'
    assert _maybe_extract_error_envelope(line_bytes) is not None
    assert _maybe_extract_error_envelope(line_str) is not None


@pytest.mark.parametrize("payload", [
    b'',
    b'\n',
    b'not json',
    b'{"type":"system"}',
    b'{"type":"result","is_error":false}',
    b'{"type":"result"}',
    b'[]',
])
def test_maybe_extract_error_envelope_returns_none_for_non_error_lines(
    payload: bytes,
) -> None:
    from service.llm_patches import _maybe_extract_error_envelope
    assert _maybe_extract_error_envelope(payload) is None


def test_assembler_patch_raises_friendly_error_on_auth_failure() -> None:
    """End-to-end through ``assemble_response_from_stream_json``:
    install the patch, feed a synthetic stream that ends with the
    auth-failed envelope, and assert the wrapped function raises
    with the Korean re-login message instead of returning silently."""
    pytest.importorskip("geny_executor.llm_client.translators._cli")
    import asyncio
    import importlib

    from service.llm_patches import install_llm_patches

    cli_module = importlib.import_module(
        "geny_executor.llm_client.translators._cli"
    )
    pristine = cli_module.assemble_response_from_stream_json
    try:
        install_llm_patches()
        wrapped = cli_module.assemble_response_from_stream_json

        async def _fake_stream():
            yield (
                b'{"type":"system","subtype":"init","model":"claude-opus-4-7"}'
            )
            yield (
                b'{"type":"result","is_error":true,"api_error_status":401,'
                b'"error":"authentication_failed",'
                b'"result":"Failed to authenticate. API Error: 401 ..."}'
            )

        async def _runner():
            return await wrapped(_fake_stream(), model="claude-opus-4-7")

        with pytest.raises(RuntimeError, match="인증이 만료"):
            asyncio.new_event_loop().run_until_complete(_runner())
    finally:
        cli_module.assemble_response_from_stream_json = pristine


def test_assembler_patch_pass_through_on_clean_stream() -> None:
    """A successful stream (no ``is_error`` envelope) must return
    the original APIResponse unchanged — the patch is non-intrusive
    on the happy path."""
    pytest.importorskip("geny_executor.llm_client.translators._cli")
    import asyncio
    import importlib

    from service.llm_patches import install_llm_patches

    cli_module = importlib.import_module(
        "geny_executor.llm_client.translators._cli"
    )
    pristine = cli_module.assemble_response_from_stream_json
    try:
        install_llm_patches()
        wrapped = cli_module.assemble_response_from_stream_json

        async def _fake_stream():
            yield (
                b'{"type":"system","subtype":"init","model":"claude-opus-4-7"}'
            )
            yield (
                b'{"type":"assistant","delta":{"type":"text_delta",'
                b'"text":"hello"}}'
            )
            yield (
                b'{"type":"result","stop_reason":"end_turn",'
                b'"usage":{"input_tokens":1,"output_tokens":1}}'
            )

        async def _runner():
            return await wrapped(_fake_stream(), model="claude-opus-4-7")

        resp = asyncio.new_event_loop().run_until_complete(_runner())
        # Don't pin the full APIResponse shape — just confirm it
        # didn't raise and we got *something* back.
        assert resp is not None
    finally:
        cli_module.assemble_response_from_stream_json = pristine


def test_assembler_patch_installs_across_all_three_namespaces() -> None:
    """Like the argv patch, the assembler function is re-exported in
    three places. Patching only the source leaves
    ``claude_code.assemble_response_from_stream_json`` (the actual
    call site at line 203) pointed at the pristine function."""
    pytest.importorskip("geny_executor.llm_client.claude_code")
    import importlib

    from service.llm_patches import install_llm_patches

    modules = [
        importlib.import_module("geny_executor.llm_client.translators._cli"),
        importlib.import_module("geny_executor.llm_client.translators"),
        importlib.import_module("geny_executor.llm_client.claude_code"),
    ]
    pristines = [getattr(m, "assemble_response_from_stream_json") for m in modules]
    try:
        install_llm_patches()
        wrapped = [getattr(m, "assemble_response_from_stream_json") for m in modules]
        for fn in wrapped:
            assert hasattr(fn, "_geny_assembler_error_patch_applied")
        assert wrapped[0] is wrapped[1] is wrapped[2]
    finally:
        for m, original in zip(modules, pristines):
            setattr(m, "assemble_response_from_stream_json", original)


# ── Original argv patch tests ─────────────────────────────────────────


def test_install_does_not_modify_non_streaming(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("geny_executor.llm_client.translators._cli")
    from service.llm_patches import install_llm_patches
    from geny_executor.llm_client.translators import _cli

    pristine = _cli.claude_code_argv
    try:
        install_llm_patches()

        class _Req:
            stream = False  # non-streaming
            model = "claude-opus-4-7"
            system = ""
            thinking = None
            response_format = None
            session_hint = None

        argv = _cli.claude_code_argv(_Req())
        # Non-streaming uses ``--output-format json`` — no verbose
        # injection.
        assert "--verbose" not in argv
        of_idx = argv.index("--output-format")
        assert argv[of_idx + 1] == "json"
    finally:
        _cli.claude_code_argv = pristine
