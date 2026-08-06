"""Drain-after-trigger guarantee for ``execute_command`` (Plan / Phase06).

Background
----------

``execute_command``'s post-execution ``finally`` block previously only
scheduled ``_drain_inbox`` when ``is_trigger`` was False. That gap meant
a Sub-Worker result queued into the inbox while the VTuber was running a
``[THINKING_TRIGGER:*]`` cycle would sit unread until the next genuine
user message — leaving the VTuber narrating "still waiting" while the
result was already in the queue.

The fix is intentionally tiny: the condition was relaxed to depend only
on the existing ``_draining_sessions`` re-entry guard. These tests pin
the new contract by inspecting the source so a future refactor cannot
silently re-introduce the regression.

The scheduling call itself is matched loosely on purpose. It has already
changed once — from a bare ``asyncio.create_task`` to ``spawn_background``,
which additionally keeps a strong reference and logs failures — and the
contract under test is *when* the drain is scheduled, not *how*. Pinning the
mechanism would make this test fail on improvements to it, which is exactly
what happened.

We deliberately do *not* spin up a full ``execute_command`` here — that
would require mocking the entire agent / session / logger surface.
Instead the tests are structural and document *why* the line looks the
way it does so the next reader doesn't tighten the gate again.
"""

from __future__ import annotations

import inspect
import re

from service.execution import agent_executor


def test_post_execution_drain_runs_for_triggers_too() -> None:
    """The post-execution drain branch in ``execute_command`` must
    schedule ``_drain_inbox`` regardless of ``is_trigger``.

    We grep the source of ``execute_command`` for the drain branch and
    assert it does NOT condition on ``not is_trigger``. The
    ``_draining_sessions`` guard alone is enough to prevent recursion
    because ``_drain_inbox`` re-enters ``execute_command`` *without*
    ``is_trigger=True``.
    """
    source = inspect.getsource(agent_executor.execute_command)

    # Find the line that schedules the drain (any scheduling mechanism).
    drain_lines = [
        line for line in source.splitlines()
        if "_drain_inbox(" in line
    ]
    assert drain_lines, (
        "expected execute_command to schedule _drain_inbox in its "
        "post-execution finally block"
    )

    # Locate the surrounding `if` for that scheduling.
    drain_idx = source.index("_drain_inbox(")
    preceding = source[:drain_idx].splitlines()[-4:]
    guard = " ".join(line.strip() for line in preceding)

    assert "_draining_sessions" in guard, (
        "drain scheduling must still be guarded by _draining_sessions "
        f"to prevent recursion; got: {guard!r}"
    )
    assert not re.search(r"not\s+is_trigger", guard), (
        "drain scheduling must NOT condition on `not is_trigger` — "
        "thinking-trigger executions must also drain queued inbox "
        "messages so [SUB_WORKER_RESULT] doesn't sit unread; "
        f"got: {guard!r}"
    )


def test_async_path_also_drains_unconditionally() -> None:
    """The async-execution path in ``execute_command_async`` already
    drained unconditionally; verify the contract is still in place so
    both entry points behave the same.
    """
    source = inspect.getsource(agent_executor)

    # Two scheduling sites are expected (sync + async). Both must be
    # guarded only by ``_draining_sessions``, never by ``is_trigger``.
    sites = [
        m.start() for m in re.finditer(r"_drain_inbox\(session_id\)", source)
    ]
    assert len(sites) >= 2, (
        "expected at least two _drain_inbox scheduling sites "
        f"(sync + async); found {len(sites)}"
    )

    for site in sites:
        # Look at a small window before the scheduling line for the
        # surrounding `if` clause. The window spans a few lines because the
        # call is now multi-line (name= and key= arguments).
        window = source[max(0, site - 300):site]
        guard = " ".join(line.strip() for line in window.splitlines()[-5:])
        assert "_draining_sessions" in guard, (
            f"drain site at offset {site} missing _draining_sessions guard; "
            f"saw: {guard!r}"
        )
        assert "is_trigger" not in guard, (
            f"drain site at offset {site} re-introduced is_trigger gating; "
            f"saw: {guard!r}"
        )
