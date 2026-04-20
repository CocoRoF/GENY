# 2026-04-20 Cycle Report

Closes the three post-rollout issues raised against the v0.20.0
integration plus the working-doc reorganization.

## PRs merged

| # | Repo | Title | Plan ref |
|---|------|-------|----------|
| [121](https://github.com/CocoRoF/Geny/pull/121) | Geny | docs: reorganize markdown layout under `dev_docs/` | §4 + setup |
| [122](https://github.com/CocoRoF/Geny/pull/122) | Geny | feat(frontend): merge Builder tab into Environments | §1 |
| [123](https://github.com/CocoRoF/Geny/pull/123) | Geny | feat(frontend): show linked environment in session Graph | §2 |
| [20](https://github.com/CocoRoF/geny-executor/pull/20) | geny-executor | fix(pipeline): emit untruncated result in pipeline.complete | §3 Fix A |
| [124](https://github.com/CocoRoF/Geny/pull/124) | Geny | fix(backend): trust streamed accumulation over pipeline.complete preview | §3 Fix B |

## What changed (high-level)

**Folder layout.** Per-cycle docs now live under `dev_docs/YYYYMMDD/`.
The v0.20.0 cycle's `analysis/`, `plan/`, `progress/` are under
`dev_docs/20260419/`; this cycle is `dev_docs/20260420/`. Stale top-level
`*_REPORT.md` / `MIGRATION_*.md` notes moved into `docs/`, and the older
TTS/STT planning notes under `dev_docs/20260401/`. Future cycles drop
in next to these as siblings.

**Tab UX.** The standalone "Builder" tab is gone. Environments is the
sole entry — its body switches to the stage editor when an env is
selected via the drawer's "Open in Builder" action. List state (filters,
bulk selection, drawer) is preserved across the mode switch. Stale
`activeTab === 'builder'` values are auto-routed to EnvironmentsTab so
nothing breaks.

**Session Graph linkage.** GraphTab now shows which Environment a
session is bound to — a clickable indigo badge that deep-links into the
Environments drawer (via a new `pendingDrawerEnvId` queue on
`useEnvironmentStore`). Sessions on the legacy preset path get a grey
`Preset: <name>` badge instead. Soft-deleted env_ids surface as a red
"Environment unavailable" pill.

**VTuber Chat truncation.** Two-sided fix:
- Upstream (`geny-executor 0.20.1`): `pipeline.complete.result` no
  longer carries the `EVENT_DATA_TRUNCATE = 500` preview cap. The
  field is the canonical final text and round-trips in full.
  Regression-tested in
  `tests/unit/test_phase1_pipeline.py::test_streaming_pipeline_complete_carries_full_result`.
- Downstream (Geny): `agent_session.py` keeps its `text.delta`
  accumulation as the source of truth and only adopts
  `pipeline.complete.result` when it is at least as long. Defensive
  against any environment still pinned to the legacy executor build.
- `geny-executor>=0.20.1` pin in `backend/pyproject.toml` and
  `backend/requirements.txt`.

## Stretch / deferred

- **Manifest-driven dynamic stage rendering** in GraphTab (replacing
  the static 16-stage layout with the env's actual stage order). Plan
  §2 stretch goal — left for a separate cycle.

## Operator follow-ups

- Reinstall backend dependencies in any pinned-environment deployment
  to pick up `geny-executor 0.20.1`. Without the upstream fix the
  defensive change in `agent_session.py` keeps things working but the
  truncated `result` field is wasted bandwidth.
- Verify on prod with a long-output VTuber prompt: streamed text and
  final persisted message should match.
