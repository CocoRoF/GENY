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
