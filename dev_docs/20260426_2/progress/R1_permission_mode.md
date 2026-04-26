# R.1 — Permission mode picker

**PR:** TBD
**Status:** Merged TBD
**Files changed:**
- `backend/service/permission/install.py` — `_resolve_mode` and `_resolve_executor_mode` now read from `settings.json:permissions.{mode,executor_mode}` first, falling back to env vars (`GENY_PERMISSION_MODE`, `GENY_PERMISSION_EXEC_MODE`).
- `backend/controller/permission_controller.py` — new `PATCH /api/permissions/mode` endpoint; `RulesResponse` carries the persisted modes.
- `frontend/src/lib/api.ts` — `PermissionRulesResponse` extended with `mode` / `executor_mode`; `permissionApi.patchMode`; `PERMISSION_MODES` + `EXECUTOR_PERMISSION_MODES` constants.
- `frontend/src/components/tabs/PermissionsTab.tsx` — two `Select` dropdowns in the action bar (Mode + Exec); calls `patchMode` on change.

## What it changes

The PermissionsTab gains two header dropdowns:

- **Mode** — `advisory | enforce` (Geny-side gate; advisory = log only, enforce = actually block).
- **Exec** — `default | plan | auto | bypass | acceptEdits | dontAsk` (executor's `PermissionMode` enum).

Picking a value PATCHes `settings.json:permissions.{mode,executor_mode}` and reloads the cascade. The install layer (`install_permission_rules`) reads these on next session creation; combined with E.1 from cycle 20260426_1 (live reload), operators can also push the change to active sessions immediately.

## Why

Audit (cycle 20260426_2, analysis/02 Tier 3) — both modes were env-only, hidden from any UI. Operators changing security posture had to edit env vars and restart.

## Cleared semantics

Sending an empty string in the PATCH removes the field from settings.json so the install layer falls back to env / default. The UI doesn't expose this today (the dropdowns force one of the enum values), but it's available via direct API call for reset workflows.

## Tests

The install layer is covered by reading helpers — no new dedicated test in this sprint. The endpoint follows the established pattern (validate → atomic write → reload → return). Visual testing on Library → Permissions tab.

## Out of scope

- Per-session mode override (would need a separate session-scoped surface; the live reload from E.1 already covers per-process).
- Migration from env vars to settings.json (env vars still work; this is additive).
