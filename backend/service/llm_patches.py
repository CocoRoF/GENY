"""
Runtime patches for ``geny-executor``'s LLM client integrations.

Why this exists
---------------
``geny-executor`` 2.0.1 (current pinned version) builds the Claude
Code CLI argv via
``geny_executor.llm_client.translators._cli.claude_code_argv``. For
streaming requests it emits:

    --print --input-format stream-json --output-format stream-json
    --include-partial-messages …

The Claude Code CLI's release pipeline tightened the validation
sometime after ``geny-executor`` 2.0.1 was published: passing
``--print`` together with ``--output-format=stream-json`` now also
requires ``--verbose``, otherwise the CLI exits 1 with::

    Error: When using --print, --output-format=stream-json requires --verbose

Symptom on the user side: every Developer-role session with the
Claude Code backend selected (`Environment 6단계 → API → Claude Code`)
fails at the first command with the CLI message bubbled up
verbatim.

The fix
-------
Monkey-patch ``claude_code_argv`` to insert ``--verbose`` right
after ``--print`` whenever the produced argv contains
``--output-format stream-json``. The patch is **idempotent** —
re-running ``install_llm_patches()`` is a no-op once the wrapper is
already in place. We also conditionally skip patching if a future
``geny-executor`` ships the fix upstream (detected by checking
whether the original argv already contains ``--verbose``).

Tested against the upstream behaviour: the non-streaming branch
(`--output-format json`) does NOT need ``--verbose`` and we leave
it alone.
"""

from __future__ import annotations

import json
from logging import getLogger
from typing import Any, AsyncIterator, Dict, List, Optional

logger = getLogger(__name__)


_PATCH_APPLIED_FLAG = "_geny_verbose_patch_applied"
_ASSEMBLER_PATCH_APPLIED_FLAG = "_geny_assembler_error_patch_applied"

# Cached wrapper. Set on the first ``install_llm_patches()`` call so
# subsequent installs re-use the same instance — matters because the
# wrapper has to be present (with identical identity) on three
# separate module attributes. A fresh wrapper per install would leave
# stale references on whichever module didn't get re-patched.
_cached_wrapper: Any = None
_cached_assembler_wrapper: Any = None


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


def _patched_argv(original_argv: List[str]) -> List[str]:
    """Return a new argv with ``--verbose`` inserted after ``--print``
    whenever the upstream argv asks for stream-json output but didn't
    include ``--verbose`` itself.

    Pure function — handy for tests.
    """
    if "--verbose" in original_argv:
        # Upstream already passes it (or some other caller did). Leave
        # the argv untouched.
        return original_argv
    # Look for ``--output-format`` ``stream-json`` as a *pair* — bare
    # presence of the string elsewhere shouldn't trigger the patch.
    try:
        of_idx = original_argv.index("--output-format")
    except ValueError:
        return original_argv
    if of_idx + 1 >= len(original_argv):
        return original_argv
    if original_argv[of_idx + 1] != "stream-json":
        return original_argv

    new_argv = list(original_argv)
    # Insert ``--verbose`` right after ``--print`` so the flag order
    # reads naturally in logs. If ``--print`` somehow isn't there
    # (defensive — geny-executor always adds it), append to the end.
    try:
        insert_at = new_argv.index("--print") + 1
    except ValueError:
        insert_at = len(new_argv)
    new_argv.insert(insert_at, "--verbose")
    return new_argv


def install_llm_patches() -> None:
    """Idempotently install the Claude Code argv ``--verbose`` patch.

    The function is re-exported across three modules in
    ``geny_executor``:

      1. ``geny_executor.llm_client.translators._cli`` (source).
      2. ``geny_executor.llm_client.translators`` (re-export in the
         package ``__init__``).
      3. ``geny_executor.llm_client.claude_code`` (caller did
         ``from … import claude_code_argv`` — captured a *local
         binding* to the source function).

    Patching only #1 is insufficient because #3 already holds a
    direct reference. We have to overwrite the attribute in **every**
    namespace that re-exports the function so any future
    ``module.claude_code_argv(...)`` lookup hits the wrapper.

    Safe to call multiple times. Logs once at INFO on the first
    install, DEBUG on subsequent calls.
    """
    import importlib

    candidate_modules = [
        "geny_executor.llm_client.translators._cli",
        "geny_executor.llm_client.translators",
        "geny_executor.llm_client.claude_code",
    ]

    # Step 1 — find the original implementation. It lives in
    # translators._cli; every other module just re-binds it.
    try:
        cli_translator = importlib.import_module(candidate_modules[0])
    except Exception:  # noqa: BLE001
        logger.debug(
            "geny_executor.llm_client.translators._cli unavailable — "
            "Claude Code CLI patch skipped (this is fine when the "
            "Claude Code backend isn't in use)",
            exc_info=True,
        )
        return

    original = getattr(cli_translator, "claude_code_argv", None)
    if original is None:
        logger.debug(
            "claude_code_argv missing from geny_executor — patch skipped"
        )
        return
    # Unwrap any already-installed wrapper so we don't double-stack.
    while getattr(original, _PATCH_APPLIED_FLAG, False):
        inner = getattr(original, "_original", None)
        if inner is None:
            break
        original = inner

    global _cached_wrapper
    if _cached_wrapper is None:
        def _wrapped(*args: Any, **kwargs: Any) -> List[str]:
            argv = original(*args, **kwargs)
            return _patched_argv(argv)

        setattr(_wrapped, _PATCH_APPLIED_FLAG, True)
        setattr(_wrapped, "_original", original)
        _cached_wrapper = _wrapped
    # else: re-use the cached wrapper. Its closure captures the
    # *original* function, so even if a stale wrapper was left on
    # one of the modules between installs, re-binding to the cached
    # instance restores the canonical chain.

    # Overwrite every known re-export with the SAME wrapper instance
    # so any caller — including ``claude_code.py`` which captured a
    # local binding at module load time — hits the wrapper. Doing
    # this unconditionally (vs per-module idempotency-skip) keeps
    # the three module attributes in lock-step across repeated
    # installs; the unwrap-while-loop above strips stale wrappers
    # off ``original`` so we don't double-stack.
    patched_modules: List[str] = []
    for mod_name in candidate_modules:
        try:
            mod = importlib.import_module(mod_name)
        except Exception:  # noqa: BLE001
            continue
        if getattr(mod, "claude_code_argv", None) is None:
            continue
        setattr(mod, "claude_code_argv", _cached_wrapper)
        patched_modules.append(mod_name)

    if patched_modules:
        logger.info(
            "[llm_patches] installed Claude Code CLI --verbose patch "
            "across %d modules: %s "
            "(workaround for geny-executor 2.0.1 + new claude CLI)",
            len(patched_modules),
            ", ".join(patched_modules),
        )
    else:
        logger.debug(
            "[llm_patches] no claude_code_argv attribute found on any "
            "known module — nothing to patch"
        )

    # Always (re-)install the assembler-side patch alongside the argv
    # patch. They're independent fixes but always travel together:
    # without the assembler patch the user sees a misleading "CLI
    # exited with code 1:" message instead of an actionable auth-
    # expired hint.
    _install_assembler_error_patch()


# ── Stream-json error envelope detection ─────────────────────────────


def _install_assembler_error_patch() -> None:
    """Wrap ``assemble_response_from_stream_json`` so that an
    ``is_error: true`` result envelope on the wire turns into a
    *friendly* RuntimeError instead of the runtime's empty-stderr
    ``CLI '/usr/bin/claude' exited with code 1:`` fallback.

    Same three-module pattern as ``claude_code_argv``: the caller
    in ``geny_executor.llm_client.claude_code.py`` does
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
            ``is_error`` result envelope, raise a Korean
            human-readable error instead of letting the runtime's
            empty-stderr fallback kick in."""
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
