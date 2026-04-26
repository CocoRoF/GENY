# Cycle 20260426_3 — Tier 6 closure + live reload extension

**Date:** 2026-04-26
**Goal:** Close the remaining Geny extension code-only surface from cycle 20260426_2's Tier 6, and extend cycle 20260426_1's E.1 live reload to cover the new sections so the new settings actually apply without a restart.

## Phase L — Send-message channels (1 PR)

### L.1 — `install_send_message_channels` reads settings.json
**Files:**
- `backend/service/notifications/install.py` — mirror of G.4 for the channels registry.
- 1 unit test exercising the dual-source merge (settings + code defaults).

## Phase O — Live reload extension (1 PR)

### O.1 — Extend `_RUNTIME_REFRESH_SCOPES` to memory / affect / skills / notifications
**Files:**
- `backend/service/executor/agent_session.py` — `_apply_pending_runtime_refresh` gains branches for the four new scopes, calling the relevant install layers + executor stage-slot setters where applicable.
- `backend/controller/admin_controller.py` — `_RELOAD_SCOPES` widened.
- `backend/tests/service/executor/test_runtime_refresh_queue.py` — 4 new cases.

## Phase M — Sub-Worker auto-spawn config (1 PR)

### M.1 — `vtuber.sub_worker` settings sub-block
**Files:**
- `backend/service/settings/sections.py` — extend `VTuberSection` with `sub_worker: VTuberSubWorkerSection` (env_id pattern, default role, prompt notice template).
- `backend/service/executor/agent_session_manager.py` — read sub-worker config when spawning a paired session instead of hardcoding `_VTUBER_SUB_WORKER_NOTICE`.
- 2 unit tests for the resolver.

## Phase J — Persona blocks per-role (1 PR)

### J.1 — `persona` settings section + per-role block list
**Files:**
- `backend/service/settings/sections.py` — new `PersonaConfigSection` with `blocks_by_role: Dict[str, List[str]]` (block-name → active-flag).
- `backend/service/persona/dynamic_builder.py` — `_select_blocks(role, available)` reads settings; default = current hardcoded chain.
- `backend/service/executor/agent_session.py:_build_pipeline` — pass role hint into the builder.
- 2 unit tests covering default + override.

## Phase N — Curated knowledge (1 PR)

### N.1 — `curated_knowledge` settings section
**Files:**
- `backend/service/settings/sections.py` — `CuratedKnowledgeSection` with `root` + `refresh_interval_seconds`.
- `backend/service/memory/curated_knowledge.py` — `get_curated_knowledge_manager` reads root from settings before falling back to the per-user default path.
- D.2 reader map + parametrized test entry.

## Phase Q — Per-session memory tuning (1 PR)

### Q.1 — `CreateSessionModal.memory_config.tuning` + persistence
**Files:**
- `backend/controller/agent_controller.py` — extend `CreateSessionRequest.memory_config` schema with optional `tuning` block.
- `backend/service/executor/agent_session.py:_build_pipeline` — merge per-session tuning over global tuning before constructing memory adapters.
- `frontend/src/components/modals/CreateSessionModal.tsx` — collapsible "Memory tuning (advanced)" section with the four knobs.
- i18n in en/ko.

## Sequencing

Front-to-back per the user's directive (continued from 20260426_2). Each PR opens, merges, then the next branches off main. ~6 PRs + the docs scaffolding PR.

## Done criteria

- All 6 sprints merged.
- `progress/README.md` table fully ticked.
- E.1 live reload from cycle 20260426_1 now covers every settings section the cycle 20260426_2 + 20260426_3 surfaces shipped.
- Tier 6 backlog from cycle 20260426_2 reduced to "deferred to UX cycle" items (subagent registry CRUD, bundled-skill display).
