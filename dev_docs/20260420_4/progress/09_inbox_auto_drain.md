# Progress/09 — Inbox auto-drain: consumed-on-pull + serial

**PR.** `fix/inbox-auto-drain` (Phase 3 · PR #9 of 9)
**Plan.** `plan/03_binding_hardening.md` §PR #9
**Date.** 2026-04-20

---

## What changed

The plan described the drain path as absent. Since the plan was
written, a bundled drain was added at
`agent_executor._drain_inbox`, wired into `execute_command`'s
finally block — so the "inbox orphan" symptom is already gone.
What remained was the behavioural gap the plan calls out:

- `inbox.read(session_id, unread_only=True)` + delayed
  `mark_read` means a deterministic failure in the drained
  `execute_command` leaves messages unread → next drain re-pulls
  the same bundle → retry loop.
- Bundled processing means one bad message kills the whole
  batch; good messages in the same bundle are never surfaced.

This PR replaces that with the plan's consumed-on-pull + serial
model:

- `backend/service/chat/inbox.py` — new `pull_unread(session_id,
  limit=None)` on `InboxManager`. Holds the inbox lock across
  load → mark-read → save, so the same message cannot be pulled
  twice by concurrent callers. Callers take ownership — if they
  fail to process, the message is lost, and the drain never
  loops on a deterministic failure.

- `backend/service/execution/agent_executor.py::_drain_inbox` —
  rewritten:
  - Enter the `_draining_sessions` guard once, hold it across
    the whole drain loop.
  - In a loop, `pull_unread(…, limit=1)` one message at a time.
    Exit when the pull returns empty.
  - Synthesize a per-message prompt (`[INBOX from
    <sender>]\n<content>`) and feed it through
    `execute_command`. Each call's finally block chains back
    into drain — but the `_draining_sessions` gate keeps the
    chain serial.
  - On `AlreadyExecutingError`: bail. A concurrent execution is
    now running, its own finally block will re-trigger drain
    once the slot is free.
  - On any other exception from `execute_command`: log and
    continue to the next message. The failing message is
    already consumed; subsequent messages still get their shot.
  - On success: feed the result to `_save_drain_to_chat_room`
    (pre-existing helper).

## Why

The inbox is the only fallback path for `[SUB_WORKER_RESULT]`
when the VTuber is busy (`_notify_linked_vtuber` → deliver on
AlreadyExecutingError). The drain semantics directly decide
whether the user ever sees the Sub-Worker's answer:

- Consumed-on-pull eliminates the one real loop risk (re-
  consumption). The plan deliberately scopes out hop counters,
  source-tag filters, and recursion guards because the VTuber ↔
  Sub-Worker topology has no self-injection path — the only
  cycle is "drain keeps re-pulling the same message," and that
  is exactly what pull_unread prevents.
- One-at-a-time processing means a single malformed message
  (e.g., something that makes the agent choke) no longer blocks
  the others behind it.

## Verification

1. `python3 -m py_compile` on both files → OK.
2. Walked every branch of the new `_drain_inbox`:
   - Empty inbox → first pull returns `[]` → early return. ✓
   - Single unread → pull pops it, execute_command runs,
     result saved to chat room, loop pulls again, finds empty,
     returns. ✓
   - Two unread → processed one at a time. The first
     execute_command's finally fires a drain, which sees the
     session already in `_draining_sessions` and no-ops, so the
     outer drain's loop handles message #2. ✓
   - Concurrent user command racing with drain → execute_command
     inside drain raises AlreadyExecutingError → drain returns,
     leaving the gate clear. The racing user command's finally
     re-invokes drain after it finishes. ✓
   - execute_command raises a real exception (timeout, agent
     dead, etc.) → logged; loop continues to next message. The
     failed message is already marked read and will not be
     retried. ✓
3. `_draining_sessions.discard(session_id)` runs in `finally`,
   so any path out of the loop clears the gate.
4. `pull_unread` holds `self._lock` across the load→mark→save
   cycle. Two concurrent drains therefore cannot pull the same
   message.

## Out of scope

- Trigger-abort mechanism during drained execution (drain
  executions are intentionally not tagged `is_trigger`).
- Retention / archival of "consumed but failed" messages. The
  plan accepts loss on deterministic failure as the correct
  trade-off vs. a retry loop.
- Hop counters, per-message source tags, or recursion guards.
  Deliberately omitted — see plan §PR #9 rationale.

## Rollback

Revert the two files. The bundled / mark-read-on-success
behaviour returns. The orphan-on-busy symptom does not return
(the outer drain wiring in `execute_command`'s finally was not
touched by this PR).
