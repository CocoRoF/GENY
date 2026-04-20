# Progress/05 — Per-turn logs env_id/role

**PR.** `obs/per-turn-env-role` (Phase 2 · PR #5 of 9)
**Plan.** `plan/02_observability.md` §PR #5
**Date.** 2026-04-20

---

## What changed

Backend signature extension:

- `backend/service/logging/session_logger.py` — `log_command`
  and `log_response` both accept two new optional kwargs:
  `env_id` and `role`. When non-None, they are written into the
  entry's metadata dict alongside the existing keys. None values
  are filtered out by the existing "remove None" pass, so
  callers that omit them continue to produce identical entries.

- `backend/service/execution/agent_executor.py` — the
  `_execute_core` path resolves `env_id` / `role` once from the
  `agent` handle (`AgentSession.env_id` property +
  `agent.role.value`), then threads them through all four log
  sites (one `log_command`, three `log_response` branches:
  success, timeout, error).

- `backend/service/langgraph/agent_session.py` — added an
  `env_id` property as a public accessor for `self._env_id`;
  the executor uses it via `getattr(agent, "env_id", None)` so
  pre-property installs still work.

Frontend type surface:

- `frontend/src/types/index.ts` — added documented `env_id` and
  `role` fields to `LogEntryMetadata`. The interface's
  catch-all already tolerated unknown keys, but the explicit
  declarations make downstream consumers (PR #6 LogsTab header,
  future detail panels) discoverable.

## Why

The "created" event (PR #4) carries env + role in one place,
but per-turn `.log` entries don't — so an operator reading a
long session log loses track of which environment produced a
particular turn after the first line. Threading env_id / role
through `log_command` and `log_response` closes that gap with
one line of extra JSON per turn, which is cheap and the
LogsTab already surfaces unknown metadata keys.

## Verification

1. `python3 -m py_compile` on all touched backend files → OK.
2. TypeScript surface: the new fields are optional and the
   existing catch-all absorbed unknown keys already, so no
   runtime / type-check regression risk.
3. Behaviour: next session created after boot emits per-turn
   entries that carry `"env_id": "template-..."` and
   `"role": "worker"|"vtuber"|"sub"|…` in metadata. Old
   entries remain unchanged (append-only log).

## Out of scope

- Per-tool-call logs (Stage 10 emits `tool.execute_start` etc.
  events separately; threading env/role into those is PR #7's
  territory when it adds structured delegation events).
- Backfilling historic log files.
- LogsTab UI surfacing (PR #6).

## Rollback

Revert the three backend files. Log entries lose the new keys;
no existing consumer breaks because every new field is
optional.
