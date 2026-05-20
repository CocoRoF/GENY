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


def _patched_argv(
    original_argv: List[str],
    *,
    has_api_key: Optional[bool] = None,
) -> List[str]:
    """Return a transformed argv applying three independent fixes:

      A. ``--verbose`` injection — required after ``--print
         --output-format stream-json`` for CLI ≥ 2.1.x. See the
         module docstring for the history.

      B. ``--bare`` stripping on the OAuth path — the CLI's
         ``--bare`` flag explicitly disables OAuth ("Anthropic auth
         is strictly ANTHROPIC_API_KEY or apiKeyHelper via
         --settings (OAuth and keychain are never read)") but
         ``geny-executor`` 2.0.1 builds the
         ``ClaudeCodeCLIClient`` with ``bare_mode=True`` as the
         default. The combination crashes every subscription /
         OAuth user with ``"Not logged in · Please run /login"`` or
         an empty-stderr ``exited with code 1:``.

         When *has_api_key* is False (no ``ANTHROPIC_API_KEY`` in
         env), remove ``--bare`` from the argv so the CLI is allowed
         to read the OAuth credentials. When *has_api_key* is True,
         keep ``--bare`` — that's the auth path it was designed for.
         When *has_api_key* is None (caller didn't tell us), we
         detect via ``os.environ`` as a fall-back.

      C. ``--tools ""`` stripping (Phase-I follow-up) — executor 2.0.5
         auto-emits ``--tools ""`` whenever ``--mcp-config`` is set
         and no ``allow_tools`` was supplied, which disables the CLI's
         entire built-in palette (Bash / Read / Write / Edit / Glob /
         Grep / TodoWrite / WebFetch / WebSearch / etc.). For Geny we
         want the *opposite*: CLI built-ins available alongside our
         MCP-wrapped Geny tools, so the Sub-Worker can actually edit
         files / run shell / browse the web. The CLI's permission
         system gates each call, and Geny pre-allows the safe set via
         the synthesised ``settings.json`` (see
         ``credentials.py:_build_claude_code``). Stripping the
         ``["--tools", ""]`` pair restores CLI defaults; the
         ``--strict-mcp-config`` flag remains in argv so the *MCP*
         surface stays scoped to our session bridge.

    Pure function — handy for tests.
    """
    new_argv = list(original_argv)

    # ── Fix B: drop --bare on OAuth path ─────────────────────────────
    if has_api_key is None:
        import os
        has_api_key = bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())
    if not has_api_key:
        new_argv = [arg for arg in new_argv if arg != "--bare"]

    # ── Fix C: drop ``--tools ""`` pair so CLI built-ins remain on ──
    cleaned: List[str] = []
    skip_next = False
    for i, arg in enumerate(new_argv):
        if skip_next:
            skip_next = False
            continue
        if arg == "--tools" and (i + 1) < len(new_argv) and new_argv[i + 1] == "":
            skip_next = True
            continue
        cleaned.append(arg)
    new_argv = cleaned

    # ── Fix A: inject --verbose for stream-json output ──────────────
    if "--verbose" in new_argv:
        return new_argv
    try:
        of_idx = new_argv.index("--output-format")
    except ValueError:
        return new_argv
    if of_idx + 1 >= len(new_argv):
        return new_argv
    if new_argv[of_idx + 1] != "stream-json":
        return new_argv
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
            patched = _patched_argv(argv)
            # Phase-I diagnostic: log the final argv every CLI invocation
            # so we can verify ``--tools ""`` / ``--strict-mcp-config`` /
            # ``--mcp-config`` are actually reaching the spawned ``claude``
            # process. Sensitive payloads — ``--mcp-config <json>`` carries
            # the per-session bearer token and ``--system-prompt`` carries
            # the assembled persona — are redacted to their lengths so the
            # log stays grep-friendly without leaking the actual content.
            try:
                redacted: List[str] = []
                skip_next = False
                for i, arg in enumerate(patched):
                    if skip_next:
                        # Redact the value following a sensitive flag.
                        redacted.append(f"<redacted len={len(arg)}>")
                        skip_next = False
                        continue
                    redacted.append(arg)
                    if arg in {"--mcp-config", "--system-prompt", "--append-system-prompt"}:
                        skip_next = True
                logger.info("[llm_patches] claude argv (%d args): %s", len(patched), redacted)
            except Exception:  # noqa: BLE001
                pass
            return patched

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

    # Phase-I ghost-error fix — strip tool_use blocks from the
    # ``StreamJsonAccumulator`` final response. See
    # ``_install_stream_accumulator_patch`` for the rationale.
    _install_stream_accumulator_patch()


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
            """Spy on the stream-json output. Two fixes:

            A. Error envelope detection — if the CLI emitted an
               ``is_error`` result envelope, raise a Korean human-readable
               error instead of letting the runtime's empty-stderr
               fallback kick in.

            B. Strip in-CLI ``tool_use`` blocks from the assembled
               response. The Claude Code CLI runs the full agentic
               loop internally (LLM → MCP tool → LLM → ...). Every
               intermediate assistant turn shows up in the stream-json
               output as a separate ``assistant`` envelope, and the
               upstream :class:`StreamJsonAccumulator` *concatenates*
               their content — so the final ``APIResponse`` returned
               to Stage 6 contains all the ``tool_use`` blocks the CLI
               *already dispatched* via MCP. Geny's Stage 10 (the
               canonical Anthropic-API tool-dispatch stage) then sees
               those ``tool_use`` blocks, looks up the
               ``mcp__geny__<name>`` ids in Geny's own ToolLoader
               (which only knows the bare names — the MCP prefix is
               applied by the CLI, not Geny), finds nothing, and
               surfaces "Tool X: ERROR (0ms) — No output" for every
               call the user can plainly see succeeded (the worker
               actually received the message, the worker actually
               replied, the bridge log records ``tools/call`` traffic).

               Per the Phase-I design doc — "Stage 10 receives that
               assistant message, sees no ``tool_use`` blocks (they
               were executed inside the CLI), and naturally no-ops"
               — the canonical fix is to strip ``tool_use`` blocks
               from the response before they reach Stage 10. Geny's
               permission/audit telemetry for those calls flows via
               the MCP bridge endpoint (cycle 20260519/Phase-2),
               not through Stage 10, so this strip is lossless.
            """
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

            # Note: the equivalent tool_use strip lives in
            # ``_install_stream_accumulator_patch`` because the actual
            # streaming code path (``ClaudeCodeCLIClient._stream``)
            # bypasses this assembler entirely and calls
            # ``StreamJsonAccumulator.finalize`` directly.

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


# ── StreamJsonAccumulator finalize: strip CLI-handled tool_use ──────


_ACCUMULATOR_PATCH_APPLIED_FLAG = "_geny_accumulator_strip_patch_applied"
_cached_accumulator_finalize: Any = None


def _install_stream_accumulator_patch() -> None:
    """Monkey-patch ``StreamJsonAccumulator.finalize`` so the final
    :class:`APIResponse` returned to Stage 6 carries **no**
    ``tool_use`` blocks for the Claude Code CLI streaming path.

    Why this lives in Geny rather than the executor
    -----------------------------------------------
    Claude Code CLI 2.1.x runs the whole agentic loop *internally*
    (LLM → tool → LLM → tool → …). Every intermediate assistant turn
    arrives as its own ``{"type":"assistant","message":{...}}``
    envelope in stream-json, and ``StreamJsonAccumulator._feed_message``
    appends every block from every envelope into a shared buffer with
    no per-turn reset. ``finalize()`` therefore returns an
    ``APIResponse`` whose ``content`` carries every ``tool_use`` block
    the CLI *already dispatched* via MCP or its own built-ins.

    Geny's downstream pipeline (Stage 9 parse → Stage 10 dispatch)
    treats those ``tool_use`` blocks as *pending* and tries to
    redispatch them against Geny's own tool registry — but the CLI
    advertises MCP tools with the ``mcp__geny__<name>`` prefix that
    Geny's registry doesn't know, so every call instantly fails with
    ``ERROR (0ms) — No output``. Meanwhile the actual tool work
    already succeeded via the MCP bridge: every Sub-Worker message
    was delivered, every memory_write persisted, every browser_*
    call dispatched. The user sees both a successful final reply
    *and* a session log full of bogus failures — confusing,
    operationally noisy, and capable of nudging the LLM itself into
    apologising mid-conversation ("messaging tool not connected").

    Per the Phase-I design doc:

        Stage 10 receives that assistant message, sees no ``tool_use``
        blocks (they were executed inside the CLI), and naturally
        no-ops.

    The accumulator's append-everything behaviour violates that
    contract. Stripping ``tool_use`` from ``finalize()`` restores it.
    Phase-2 audit/telemetry for those calls flows through the MCP
    bridge endpoint, so the strip is lossless — Geny's
    ``mcp_bridge_controller`` is already where ``tools/call`` events
    are recorded.

    A future executor 2.0.6 should encode this directly (per-turn
    buffer reset, or skip ``tool_use`` on the claude_code_cli path);
    when that lands we drop this patch.
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

    original = getattr(accum_cls, "finalize", None)
    if original is None:
        return

    # Unwrap stale wrappers so we don't double-stack across reloads.
    while getattr(original, _ACCUMULATOR_PATCH_APPLIED_FLAG, False):
        inner = getattr(original, "_original", None)
        if inner is None:
            break
        original = inner

    global _cached_accumulator_finalize
    if _cached_accumulator_finalize is None:
        def _wrapped(self: Any) -> Any:
            response = original(self)
            try:
                content = getattr(response, "content", None)
                if isinstance(content, list):
                    filtered = [
                        b for b in content
                        if getattr(b, "type", None) != "tool_use"
                    ]
                    stripped = len(content) - len(filtered)
                    if stripped:
                        response.content = filtered
                        logger.info(
                            "[llm_patches] stripped %d CLI-handled "
                            "tool_use block(s) from claude_code stream "
                            "response (Stage 10 no-ops)",
                            stripped,
                        )
            except Exception:  # noqa: BLE001
                logger.debug(
                    "[llm_patches] accumulator finalize strip skipped",
                    exc_info=True,
                )
            return response

        setattr(_wrapped, _ACCUMULATOR_PATCH_APPLIED_FLAG, True)
        setattr(_wrapped, "_original", original)
        _cached_accumulator_finalize = _wrapped

    setattr(accum_cls, "finalize", _cached_accumulator_finalize)
    logger.info(
        "[llm_patches] installed StreamJsonAccumulator.finalize "
        "tool_use strip patch (claude_code_cli ghost-error fix)"
    )
