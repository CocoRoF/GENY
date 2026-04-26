# 02 — Post-D4 integration audit findings

**Date:** 2026-04-26
**Method:** 3 parallel Explore agents (executor surface / Geny backend / Geny frontend) + manual verification of every claim before recording it.
**Scope:** UI surfaces shipped through cycles E/F/G + D1-D4 layout/design uplift, against current geny-executor 1.3.0 integration.

## Tier A — Verified working (UI → executor flows correctly)

| Surface | Path | Citation |
|---|---|---|
| Session create | env_id → `EnvironmentService.instantiate_pipeline` → `AgentSession` receives prebuilt `Pipeline` | `agent_session_manager.py:644` |
| Runtime injection | `attach_runtime` swaps in hook_runner / permission_rules / memory / system_builder | `agent_session.py:1227` |
| Settings cascade | user / project / local cascade deep-merged by `SettingsLoader` | `geny_executor/settings/loader.py:27` |
| Atomic settings.json writes | tempfile + os.replace pattern | hook/permission/framework controllers consistent |
| Telemetry — tool events | `record_event` called from tool.call_start / tool.call_end | `agent_session.py:1671`, `:1700` |
| Telemetry — permission decisions | `record_decision` called from permission matrix path | `agent_session.py:1817`, `:2223` |
| Hooks loader | settings.json:hooks section is the modern path; hooks.yaml is legacy fallback | `service/hooks/install.py:36-119` |
| Skills opt-in | `settings.json:skills.user_skills_enabled` read | `service/skills/install.py:46` |
| Tasks / Cron runner | delegated to `app.state.task_runner`; admin health endpoint exposes status | `agent_tasks_controller.py:77`, `admin_controller.py:445` |
| MCP servers | `build_session_mcp_config` → `MCPManager` → tool auto-registration | `agent_session_manager.py:562` |

**Earlier audit was wrong about**: telemetry rings being uncalled. They are called at the spots above. Earlier sub-agent reports likely missed these because the imports are lazy (inside the function body, not at module top).

## Tier B — Works but invisible to the user (UX gap, not a code gap)

### B.1 — Settings changes apply only to the next session, not active ones

Permissions / Hooks / Skills / MCP / framework settings all written to `~/.geny/settings.json` are read at **session creation time**. Active sessions hold a frozen snapshot via `attach_runtime`. Mutating the file mid-flight has no effect on running sessions.

UI gives no signal of this. User mutates → expects change → confused when active session ignores it.

**Action:** Persistent banner on Library / Session-Env tabs.

### B.2 — `GENY_ALLOW_HOOKS=1` env gate is invisible

`service/hooks/install.py:104` short-circuits when env not set. UI can register any hooks but they don't fire. No surface tells the operator the gate is closed.

**Action:** Surface the env state in admin Integration Health card + Hooks tab status pill.

### B.3 — Tool preset semantics are stale post-env refactor

UI promotes `tool_preset_id` as a 1st-class session field. After the env-driven refactor (`agent_session_manager.py:601` comment), the preset's tool list is **owned by the manifest**; the preset object is consulted only for `mcp_servers` filtering (`agent_session_manager.py:539-542`).

UI doesn't tell the user this. Selecting a preset feels meaningful but mostly affects MCP filtering.

**Action:** Context help in ToolSets tab + tooltip on the preset selector.

### B.4 — `hooks.yaml` legacy file silent demotion

If both `settings.json:hooks` and `~/.geny/hooks.yaml` exist, JSON wins; YAML is logged with a warning but UI never surfaces this. Operators can edit YAML expecting it to take effect.

**Action:** Integration Health card flags presence of legacy file with "delete after migration" hint.

### B.5 — Manifest edit doesn't reflect into active sessions

Editing an environment via PUT `/api/environments/{id}` updates the file on disk but active sessions bound to that env_id keep their pre-built Pipeline. UI gives no cue.

**Action:** Environment editor lists active sessions bound to the env_id with "restart needed" CTA.

## Tier C — Potential leaks (need code-level verification before classifying)

### C.1 — Cron history `record_fire` call site
`record_fire` is defined on `cron_history` ring. Direct grep across `backend/service/cron/` finds **no** call site → ring stays empty → admin's recent-cron list always blank.

**Action:** Trace cron job execution boundary, add `record_fire(...)` call.

### C.2 — Framework settings section readers
PUT `/api/framework-settings/{name}` accepts arbitrary section names. Some sections have known readers (e.g. `skills.user_skills_enabled` at `service/skills/install.py:56`) but no central map. Operator can write a section that no code reads — silent no-op.

**Action:** Constant-defined map `{section_name → reader_module}` surfaced via admin endpoint + UI showing "section read by N modules" beside each row.

### C.3 — Sub-Worker session respects same cascade?
VTuber auto-spawns sub-worker (`agent_session_manager.py:869-992`). Sub-worker is a separate `AgentSession.create()` call — does it pick up the same `~/.geny/settings.json` cascade? Almost certainly yes (same process, same SettingsLoader singleton), but no integration test asserts it.

**Action:** Add integration test in cycle if time permits; not a blocker.

## Tier D — Critical bug (separately documented)

See `01_session_param_gap.md` — UI's `max_turns / timeout / max_iterations` controls are **not enforced**. Pipeline runs to manifest defaults regardless.

## Prioritized backlog

| Phase | Sprint | Tier | Description |
|---|---|---|---|
| **B** (critical) | B.1 | D | Wire session params (max_iterations, timeout) into Pipeline run |
| **C** (visibility) | C.1 | B.1 | "Next session" banner on Library / Session-Env tabs |
| **C** | C.2 | B.2/B.4/C.2 | Admin Integration Health card |
| **C** | C.3 | B.3 | ToolSets context help (env-driven note) |
| **D** (verification) | D.1 | C.1 | Cron `record_fire` wired |
| **D** | D.2 | C.2 | Framework settings reader map |
| **D** | D.3 | B.5 | Manifest edit affected-sessions display |
| **E** (live reload P2) | E.1 | B.1 (deeper) | Hot-swap permission_rules / hook_runner via admin reload signal |

Out of scope (C.3) — requires test infra cycle.
