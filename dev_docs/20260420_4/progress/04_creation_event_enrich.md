# Progress/04 — Creation event enrichment

**PR.** `obs/creation-event-enrich` (Phase 2 · PR #4 of 9)
**Plan.** `plan/02_observability.md` §PR #4
**Date.** 2026-04-20

---

## What changed

`backend/service/langgraph/agent_session_manager.py` — the
`"created"` session-log event now carries four additional
fields:

```python
session_logger.log_session_event("created", {
    "model": request.model,
    "working_dir": request.working_dir,
    "max_turns": request.max_turns,
    "type": "agent_session",
    "env_id": env_id,
    "role": request.role.value if request.role else "worker",
    "session_type": request.session_type,
    "linked_session_id": request.linked_session_id,
})
```

`env_id` was already resolved earlier in the function (via
`resolve_env_id`). `role`, `session_type`, and
`linked_session_id` come straight from the validated request.

## Why

The session's `.log` file is the durable answer to "what
environment did this session run on, and what was it talking to?"
Before this PR, that information lived only in the in-memory
`SessionInfo` / `sessions.json` and was lost if a log was
shared or examined offline. For VTuber ↔ Sub-Worker debugging —
where pairing is the key relationship — having both
`session_type` and `linked_session_id` in the first log entry
lets an operator reconstruct the pairing without cross-
referencing the store.

## Verification

1. `python3 -m py_compile backend/service/langgraph/agent_session_manager.py` → OK.
2. Manual: on next boot, creating any session produces a
   `.log` file whose first line carries the four new keys. Old
   logs are unchanged (the event log is append-only).

No tests added — session log event contents are verified by
Phase 2 LogsTab header integration (PR #6) and by PR #5's
per-turn metadata round-trip tests.

## Out of scope

- Retrospectively backfilling old logs.
- Logging deletion / restore events.

## Rollback

Revert the event dict. Existing logs keep their richer entries
(append-only); new sessions lose the four fields.
