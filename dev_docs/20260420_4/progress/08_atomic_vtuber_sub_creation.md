# Progress/08 — Atomic VTuber + Sub-Worker creation

**PR.** `bind/atomic-vtuber-sub` (Phase 3 · PR #8 of 9)
**Plan.** `plan/03_binding_hardening.md` §PR #8
**Date.** 2026-04-20

---

## What changed

`backend/service/langgraph/agent_session_manager.py` — the
auto-pair block inside `create_agent_session` (the `if
role==VTUBER and session_type!="sub"…` branch). The previous
`except Exception: logger.error(...)` silently kept a partially
created VTuber in the store when Sub-Worker creation failed,
which is the bug the plan calls out. The rollback now:

1. Initializes `worker_session_id: Optional[str] = None` just
   inside the auto-pair branch.
2. Assigns it only after `self.create_agent_session(worker_request)`
   returns, so the rollback path can distinguish "worker was
   partially created" from "worker never got off the ground".
3. In the except block:
   - Log at ERROR with `exc_info=True` (as before) but with a
     message that makes the rollback intent explicit.
   - If `worker_session_id is not None`, call
     `self.delete_session(worker_session_id)` inside its own
     try/except. A secondary failure is logged but does not
     swallow the primary exception.
   - Always call `self.delete_session(session_id)` for the
     VTuber, also guarded.
   - Re-raise the original exception so the caller learns the
     VTuber could not be created.

`delete_session` is the standard soft-delete path — it calls
`agent.cleanup()`, removes from `_local_agents`, removes the
session logger, and sets `is_deleted=True` on the store record.
That satisfies the plan's "minimum" requirement (remove from
memory, remove from store, close pipeline). A hard purge isn't
available today and isn't needed — the UI filters
`is_deleted=True` records out, so the failed pair is invisible
and the client is free to retry.

## Why

Previously, a Sub-Worker creation failure would leave the VTuber
in the store with `linked_session_id=null` and no injected
"Sub-Worker Agent" prompt block. Subsequent delegation attempts
via `geny_send_direct_message` failed silently at the tool layer
and the user never saw the actual failure. Rolling back both
sides of the pair on any failure means the API call either
succeeds fully or fails loudly — no silent half-states.

## Verification

1. `python3 -m py_compile` on the touched file → OK.
2. Walked the rollback path by inspection:
   - `create_agent_session` raising *before* worker assignment:
     `worker_session_id is None` → skips worker rollback, deletes
     VTuber, re-raises. ✓
   - `create_agent_session` succeeds but a later step inside
     the try (`_store.update`, prompt injection) raises:
     `worker_session_id` is set → worker rollback fires first,
     then VTuber rollback, then re-raise. ✓
   - Both `delete_session` calls raise: logged at ERROR via
     `logger.exception`; original exception still propagates
     because the cleanup try/excepts don't wrap the `raise`. ✓
3. No new imports needed — `Optional` is already in the
   `from typing import …` line.

## Out of scope

- Automatic Sub-Worker retry. Client-driven retry is enough.
- Exposing a dedicated "retry Sub-Worker" REST endpoint — the
  existing session creation endpoint already handles it.
- Hard-purge of the store record (no existing hard-delete path;
  soft-delete is sufficient because the UI filters it out).
- Cross-session locking to prevent two clients racing to create
  the same VTuber. That is a separate problem and not part of
  the observed defect.

## Rollback

Revert the single file. Silent-catch behaviour returns; partial
VTubers reappear but no other subsystem breaks.
