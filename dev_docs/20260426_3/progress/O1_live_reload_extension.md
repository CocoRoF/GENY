# O.1 — Live reload extension to memory_tuning + affect

**PR:** TBD
**Status:** Merged TBD
**Files changed:**
- `backend/service/executor/agent_session.py` — `_RUNTIME_REFRESH_SCOPES` widened (`memory_tuning`, `affect`); two new helpers `_reload_memory_tuning` / `_reload_affect_emitter`; drained from `_apply_pending_runtime_refresh` alongside the existing branches.
- `backend/controller/admin_controller.py` — `_RELOAD_SCOPES` matched.
- `backend/tests/service/executor/test_runtime_refresh_queue.py` — 6 new cases (queue accept, retriever / strategy / emitter mutation, missing-emitter no-op, all-scope fan-out).
- `frontend/src/lib/api.ts` — `reloadRuntime` accepts the two new scope strings.
- `frontend/src/components/admin/ReloadRuntimeButton.tsx` — dropdown gains "Memory tuning only" + "Affect emitter only" options.

## What it changes

Cycle 20260426_1's E.1 only covered permissions + hooks. Cycle 20260426_2 shipped a pile of editable settings sections (memory, affect, notifications, channels, …) — all of which required a session restart to take effect on running sessions. O.1 closes the gap for the two sections with clean live-mutation paths:

- **memory_tuning**: re-reads `load_memory_tuning(is_vtuber=…)` and mutates the live `GenyMemoryRetriever._max_inject` / `_recent_turns` / `_enable_vector` (Stage 2 context.retriever) plus `GenyMemoryStrategy._enable_reflection` (Stage 18 memory.strategy).
- **affect**: re-reads `_resolve_max_tags` and mutates the live `AffectTagEmitter._max_tags_per_turn` on Stage 17's emit chain.

Both mutations target instance attrs the executor already owns, with `getattr` guards so a future executor rename degrades silently rather than crashing the cycle. Failures are logged + swallowed (telemetry over crash).

## Why

Without O.1, every G.x change from cycle 20260426_2 needed a restart to take effect on active sessions — which is incongruous with the live-reload affordance shipped in E.1.

## Out of scope (this sprint)

- **memory provider** swap (provider/dsn/dialect/scope/timezone). Re-attaching the retriever / strategy / persistence triple is more invasive — it requires rebuilding the `MemoryProvider` and re-wiring `attach_runtime`. Keep restart-required.
- **skills** registry refresh. Affects the skill-as-tool provider chain; would need to rebuild `SkillToolProvider` and re-register on the live registry. Defer.
- **notifications endpoints / channels** swap. Needs `app.state.notification_endpoints` mutation, not pipeline-level — separate path.
- **Per-section reload signal** (vs current fan-out) — current fan-out is fine; we don't need finer routing yet.

## Tests

6 new cases (10 total in the file):
- queue accepts `memory_tuning` + `affect`
- memory_tuning mutates retriever attrs
- memory_tuning mutates strategy attr
- affect mutates emitter `_max_tags_per_turn`
- affect with no emitter on chain → no-op (manifest dropped emit stage)
- all-scope fan-out exercises memory + affect alongside permissions + hooks

Local: skipped (pydantic). CI runs them.
