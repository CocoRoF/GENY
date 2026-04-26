# Cycle 20260426_1 — Integration audit remediation

**Date:** 2026-04-26
**Author:** Claude Opus 4.7
**Scope:** Bridge UI controls to actual executor enforcement; surface "next-session" semantics; close verification leaks.
**Out of scope:** Frontend test infra (carved out per 20260425_3); deep cost/budget tuning.

## Phase B — Critical session-param enforcement gap

**Why first:** UI deceives the user. `max_turns / timeout / max_iterations` controls have no effect on the executor. Highest impact, smallest blast radius (single function path).

### Sprint B.1 — Wire `max_iterations` + `timeout` into Pipeline run

**Files:**
- `backend/service/executor/agent_session.py` — `_invoke_pipeline` and `_astream_pipeline`.
- `backend/tests/service/executor/test_session_param_enforcement.py` (new).

**Changes:**
1. Helper `_apply_session_limits_to_pipeline(self)` mutates `self._pipeline._config.max_iterations` and `.context_window_budget` and (if present) `.cost_budget_usd` to the `AgentSession` values, exactly once per invocation. Restore not needed — same pipeline is bound to one session.
2. Wrap the `pipeline.run_stream` consumption in `asyncio.wait_for(..., timeout=self._timeout)` when `self._timeout > 0`. On `TimeoutError`, mark session ERROR with `error_message='timeout exceeded ({}s)'` and emit a `pipeline.error` event for the UI.
3. `max_turns` — verify already enforced at chat command path (CommandTab → `/api/agents/{sid}/execute`). If not, add cap there. (Likely already there; will confirm during sprint.)

**Tests (3 cases, fastapi-skipping where needed):**
- `test_max_iterations_overrides_pipeline_default` — fakes a Pipeline with config.max_iterations=50, AgentSession with max_iterations=3, asserts mutation happens.
- `test_timeout_aborts_long_run` — fake stream that yields slowly; assert `asyncio.wait_for` raises and session enters ERROR.
- `test_session_info_round_trip_preserves_limits` — create → fetch → assert.

**PR:** `feat(session): enforce UI session limits in executor pipeline (B.1)`.

## Phase C — Visibility (3 PR)

### Sprint C.1 — "Next session" banner

**Files:** `frontend/src/components/tabs/EnvironmentTab.tsx`, `SessionEnvironmentRootTab.tsx`, plus a tiny shared `<NextSessionBanner />` in `frontend/src/components/layout/`.
**Behavior:** Persistent info banner at the top of Library / Session-Env tabs explaining "Changes apply to the next session you create. Active sessions keep their startup snapshot."
**i18n:** Both en/ko strings.
**PR:** `feat(ui): banner clarifying next-session apply semantics (C.1)`.

### Sprint C.2 — Admin Integration Health card

**Files:**
- `backend/controller/admin_controller.py` — new `GET /api/admin/integration-health` aggregator.
- `frontend/src/components/admin/IntegrationHealthCard.tsx` (new).
- Mounted in `AdminPanel.tsx`.

**Surface (single response):**
```json
{
  "settings_path": "/home/u/.geny/settings.json",
  "settings_exists": true,
  "hooks_yaml_legacy_present": false,
  "hooks_env_gate": false,                 // GENY_ALLOW_HOOKS=1?
  "task_runner_running": true,
  "tool_event_ring": {"capacity": 200, "filled": 47},
  "permission_ring": {"capacity": 50, "filled": 12},
  "cron_history": {"capacity": 100, "filled": 0}
}
```
**UI:** Grid of pill-shaped status badges (green/amber/red) with brief why-text on hover. Reuses `StatusBadge` from layout/.
**PR:** `feat(admin): integration health card surfacing executor wiring state (C.2)`.

### Sprint C.3 — ToolSets context help

**Files:**
- `frontend/src/components/tabs/ToolSetsTab.tsx`
- `CreateSessionModal.tsx` — tooltip on the preset selector.
- i18n strings.

**Copy (en):** "In env-driven sessions, the tool list is owned by the bound environment manifest. Presets influence MCP server filtering only."
**PR:** `feat(ui): clarify tool preset semantics in env-driven sessions (C.3)`.

## Phase D — Verification leaks (3 PR)

### Sprint D.1 — Cron record_fire wired

**Investigation first** (10 min):
- `grep -rn record_fire backend/service/cron/`
- Trace cron job execution path; identify boundary (job start, success, fail).

**Implementation:**
- Add `record_fire(name, status, started_at, finished_at, error)` calls at success + failure boundaries.
- 1 test that runs a fake job through the runner and asserts ring is non-empty.
**PR:** `fix(cron): populate cron_history ring on job execution (D.1)`.

### Sprint D.2 — Framework settings reader map

**Files:**
- `backend/service/settings/known_sections.py` (new) — constant `KNOWN_SECTIONS = {"skills": ["service.skills.install"], "hooks": ["service.hooks.install"], ...}`.
- `backend/controller/admin_controller.py` — `GET /api/admin/framework-sections` returning the map.
- `frontend/src/components/settings/FrameworkSettingsPanel.tsx` — show "read by: …" beside each section row.
**PR:** `feat(settings): publish framework section reader map (D.2)`.

### Sprint D.3 — Manifest edit affected-sessions display

**Files:**
- `backend/controller/environment_controller.py` — extend PUT `/api/environments/{id}` response with `affected_sessions: SessionInfo[]`.
- `frontend/src/components/environment/EnvironmentEditor.tsx` (or equivalent) — modal listing affected active sessions with per-session "restart" CTA.
**PR:** `feat(env): warn when manifest edit has bound active sessions (D.3)`.

## Phase E — Live reload (P2)

### Sprint E.1 — Hot-swap permission_rules / hook_runner

**Bigger PR.** Approach:
- New `AgentSession.refresh_runtime()` method that re-runs `attach_runtime` with newly-loaded permission_rules / hook_runner only (other slots unchanged).
- New admin POST `/api/admin/reload-runtime/{scope}` where scope in `{permissions, hooks, all}`.
- UI: button on Library tab "Reload to active sessions" with confirmation modal.

**Risk:** mid-turn reload race. Mitigation: skip sessions where `_is_executing` is true and surface skipped count in response.

**Tests:** integration test that mutates permissions, calls reload, verifies new rule blocks a tool that was previously allowed in the same session.

**PR:** `feat(admin): live reload of permissions/hooks into active sessions (E.1)`.

## PR sequence (commit cadence)

| # | Sprint | Title | Size |
|---|---|---|---|
| 1 | (this) | docs(plan): cycle 20260426_1 — integration audit remediation | docs only |
| 2 | B.1 | feat(session): enforce UI session limits in executor pipeline | ~80 LOC + 3 tests |
| 3 | C.1 | feat(ui): banner clarifying next-session apply semantics | ~60 LOC FE |
| 4 | C.2 | feat(admin): integration health card | ~140 LOC (BE+FE) |
| 5 | C.3 | feat(ui): clarify tool preset semantics | ~30 LOC + i18n |
| 6 | D.1 | fix(cron): populate cron_history ring | ~30 LOC + 1 test |
| 7 | D.2 | feat(settings): publish framework section reader map | ~80 LOC |
| 8 | D.3 | feat(env): warn when manifest edit has bound active sessions | ~120 LOC |
| 9 | E.1 | feat(admin): live reload of permissions/hooks | ~250 LOC + tests |

Each PR appends one progress file under `progress/` and ticks `progress/README.md`.

## Done criteria

- All 9 PRs merged to main.
- `progress/README.md` table fully ticked.
- No new NEEDS_VERIFY items left dangling (any discovered mid-cycle either fixed or documented as carve-out).
