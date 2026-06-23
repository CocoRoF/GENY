# Sandbox Tool Packs — Progress

Tracks [01_PLAN.md](01_PLAN.md). One row per phase.

| Phase | Scope | Status |
|---|---|---|
| **P0** | executor `SandboxExecTool` + public container-exec API + spec ser/de + tests | ✅ **DONE** — geny-executor **2.30.0** (commit b02b594), full suite 4394 passed |
| **P1** | GAPT snapshot subsystem: `snapshots` table + Alembic migration + `domains/snapshots/` service (capture/restore/fork/list/diff/activity) + `routers/snapshots.py`; artifacts force-included | ⬜ next |
| **P2** | Geny `sandbox_tool_packs` store + pack-loader + adapter (build `SandboxExecTool` w/ `GaptSandboxHandle`); a hand-written pack runs e2e | ⬜ |
| **P3** | Save/test API + project-per-pack provisioning + `tool_save` snapshot — `POST /api/sandbox-tool-packs` | ⬜ |
| **P4** | Authoring loop: `env(action="forge_tool")` + bundled `tool-builder` skill | ⬜ |
| **P5** | Reuse across sessions: env opt-in + cold restore-from-snapshot; tool authored in A callable in B; skills surface | ⬜ |
| **P6** | Migrate `python_inline` → sandbox (retire host `exec()`); (P7 optional) GAPT frontend snapshot button + snapshot-graph/pack-manager UI | ⬜ |

## P0 notes (done)
- `tools/built_in/sandbox_exec_tool.py` — `SandboxExecTool` (stdin JSON → stdout
  JSON; no host fallback; `to_dict`/`from_dict`). NOT in `BUILT_IN_TOOL_CLASSES`.
- Container-exec primitives now public on `geny_executor.tools`: `sandbox_exec`,
  `sb_run`, `sb_read_bytes`, `sb_write_bytes`, `container_path`, `SandboxExecError`.
- Tests: `tests/unit/test_sandbox_exec_tool.py` (10).

## Next: P1 (GAPT snapshots)
Design in [01_PLAN.md](01_PLAN.md) §4. Build in the GAPT repo
(`/home/geny-workspace/Geny/gapt/server/`): table + migration + `domains/
snapshots/` service + `routers/snapshots.py`. Verify: snapshot → mutate →
restore = byte-identical (incl. artifacts); activity replay shows chat+tool
trail; parent graph + delete.
