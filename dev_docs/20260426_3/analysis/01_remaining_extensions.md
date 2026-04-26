# 01 — Remaining Geny extension surface (post-cycle 20260426_2)

**Date:** 2026-04-26
**Method:** Re-derived from cycle 20260426_2 `analysis/02_library_coverage_gap.md` Tier 6, intersected with what the previous cycle actually shipped.

## What's left after 20260426_2

Cycle 20260426_2 closed Tier 0–5 + the registered settings sections. Tier 6 (Geny extensions code-only) is partly closed. Remaining items (verified by direct code inspection):

| Tier 6 item | Where it lives | Status |
|---|---|---|
| Memory provider config | `service/memory_provider/config.py` | ✅ DONE in G.1 |
| Memory retriever knobs | `agent_session._build_pipeline` | ✅ DONE in G.2 |
| Memory strategy knobs | `agent_session._build_pipeline` | ✅ DONE in G.2 |
| AffectTagEmitter knob | `service/emit/chain_install.py` | ✅ DONE in G.3 |
| Notification endpoints | `service/notifications/install.py` | ✅ DONE in G.4 |
| **Send-message channels** | `service/notifications/install.py:install_send_message_channels` | ❌ Code-registered only |
| **Persona block ordering** | `service/persona/blocks.py` + `agent_session._build_pipeline` | ❌ Hardcoded chain |
| **VTuber sub-worker auto-spawn** | `agent_session_manager._VTUBER_SUB_WORKER_NOTICE` + linked_session paths | ❌ No config — env_id resolution implicit |
| **Subagent type registry** | `service/subagent_types/` (registry of role→config descriptors) | ⚠ Read-only admin viewer exists; no UI to add custom types |
| **Curated knowledge manager** | `service/memory/curated_knowledge.py` | ❌ Per-user dirs implicit; no root override / refresh interval surface |
| **Bundled-skill version + extras display** | `service/skills/bundled/` | ⏸ Read-only display deferred to UX cycle |

## Cross-cutting issue: settings.json edits require restart

Cycle 20260426_1 (E.1) shipped between-turn live reload for **permissions + hooks** only. After cycle 20260426_2 the editable surface ballooned (memory / affect / notifications / channels / persona / sub-worker / curated). All require restart to take effect on running sessions, which conflicts with the user's "변경이 즉시 적용되어야" expectation.

E.1's queue/drain pattern can absorb the new scopes — the executor's stage-slot setters are stable for the relevant fields. Extending the `_RUNTIME_REFRESH_SCOPES` tuple + `_apply_pending_runtime_refresh` body is the lowest-risk path.

## Per-session overrides

`CreateSessionModal.memory_config` already exposes per-session `provider/root/dsn/dialect/scope/timezone`. Memory tuning knobs (`max_inject_chars`, `recent_turns`, `enable_vector_search`, `enable_reflection`) are global only after G.2. Operators running A/B tests want per-session overrides for those too.

## Sprint backlog (priority order)

| Phase | Sprint | Description | Size |
|---|---|---|---|
| **L** | L.1 | `send_message_channels` reads settings.json:channels.send_message (mirror of G.4) | ~80 LOC + 1 test |
| **O** | O.1 | Live reload extended to memory / affect / skills / notifications | ~120 LOC + 4 tests |
| **M** | M.1 | VTuber sub-worker auto-spawn config (env_id mapping in settings.json:vtuber.sub_worker) | ~100 LOC |
| **J** | J.1 | Persona blocks per-role config (which blocks active for vtuber vs worker) | ~150 LOC + 2 tests |
| **N** | N.1 | Curated knowledge manager root + refresh interval editable | ~80 LOC |
| **Q** | Q.1 | Per-session memory tuning override (CreateSessionModal + agent_session merge logic) | ~120 LOC FE+BE |

Total: ~6 PRs.

Out of scope this cycle:
- Subagent type registry editable subset (low demand; existing read-only viewer adequate).
- Bundled-skill version display (UX cycle).
- Per-section reload signal vs fan-out (current fan-out is fine — operators don't need finer granularity yet).
