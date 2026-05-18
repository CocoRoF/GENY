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

from logging import getLogger
from typing import Any, List

logger = getLogger(__name__)


_PATCH_APPLIED_FLAG = "_geny_verbose_patch_applied"


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

    Safe to call multiple times. Logs once at INFO on the first
    install, DEBUG on subsequent calls.
    """
    try:
        from geny_executor.llm_client.translators import _cli as cli_translator
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
    if getattr(original, _PATCH_APPLIED_FLAG, False):
        logger.debug("Claude Code CLI --verbose patch already installed")
        return

    def _wrapped(*args: Any, **kwargs: Any) -> List[str]:
        argv = original(*args, **kwargs)
        return _patched_argv(argv)

    setattr(_wrapped, _PATCH_APPLIED_FLAG, True)
    # Expose the underlying function so tests / future patches can
    # re-stack on top of the original.
    setattr(_wrapped, "_original", original)
    cli_translator.claude_code_argv = _wrapped
    logger.info(
        "[llm_patches] installed Claude Code CLI --verbose patch "
        "(workaround for geny-executor 2.0.1 + new claude CLI)",
    )
