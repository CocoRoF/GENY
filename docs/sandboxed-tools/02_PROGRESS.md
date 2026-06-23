# Sandbox Tool Packs — Progress

Tracks [01_PLAN.md](01_PLAN.md). One row per phase.

| Phase | Scope | Status |
|---|---|---|
| **P0** | executor `SandboxExecTool` + public container-exec API + spec ser/de + tests | ✅ **DONE** — geny-executor **2.30.0** (commit b02b594), full suite 4394 passed |
| **P1** | GAPT snapshot subsystem: `snapshots` table + Alembic migration + `domains/snapshots/` service (capture/restore/list/diff/activity/delete) + `routers/snapshots.py`; artifacts force-included | ✅ **DONE** — gapt main `bdd93e2` (PR #8). Activation = 2223 redeploy (entrypoint runs `alembic upgrade head`). |
| **P2** | Geny `sandbox_tool_packs` store + pack-loader + adapter (build `SandboxExecTool` w/ `PackSandboxHandle`); a hand-written pack runs e2e | ✅ **DONE** — Geny main `8f62a6f0` (PR #1053); 5 tests |
| **P3** | Save/test/manage API + `tool_save` snapshot — `POST /api/sandbox-tool-packs` | ✅ **DONE** — Geny main `a29f4f1c` (PR #1054); builder + controller + 8 tests |
| **P4** | Authoring loop: `env(action="forge_tool")` + bundled `tool-builder` skill | ⬜ |
| **P5** | Reuse across sessions: env opt-in + cold restore-from-snapshot; tool authored in A callable in B; skills surface | ⬜ |
| **P6** | Migrate `python_inline` → sandbox (retire host `exec()`); (P7 optional) GAPT frontend snapshot button + snapshot-graph/pack-manager UI | ⬜ |

## ✅ LIVE-VERIFIED on prod (P0–P3) — 2026-06-23
Deployed + e2e-verified on the real shared host (Geny 2222 + GAPT 2223, one docker daemon):
- **GAPT 2223** (gapt main `4f0fff6`): migration applied (`snapshots` table+enum);
  capture→mutate→**restore byte-identical** (file reverted to V1), row persists,
  activity/diff endpoints work. Found+fixed 3 bugs via live e2e: (1) auto `git init`
  for non-git workspaces, (2) `db.commit()` on create/delete (get_db_session
  doesn't auto-commit), (3) unborn-HEAD parent (`git rev-parse HEAD` prints literal
  "HEAD" → `--verify`). gapt PRs #9/#10/#11.
- **Geny 2222** (main `faece1fe`): executor **2.30.0**, `sandbox_tool_packs` table
  auto-created, store/controller/loader wired, GAPT reachable, backend can
  `docker exec` gapt-ws.
- **FULL PACK E2E**: in-memory pack → `load_pack` → tool's code ran INSIDE a live
  GAPT workspace via SandboxExecTool→sandbox_exec→docker exec →
  `{"echo": {"msg": "hello-sandbox-tool"}, "ok": true}`; skills loaded too.

The foundation (capability + snapshots + persistence + load+run) is proven on real
infra. P4/P5 build on this verified base.

## P0 notes (done)
- `tools/built_in/sandbox_exec_tool.py` — `SandboxExecTool` (stdin JSON → stdout
  JSON; no host fallback; `to_dict`/`from_dict`). NOT in `BUILT_IN_TOOL_CLASSES`.
- Container-exec primitives now public on `geny_executor.tools`: `sandbox_exec`,
  `sb_run`, `sb_read_bytes`, `sb_write_bytes`, `container_path`, `SandboxExecError`.
- Tests: `tests/unit/test_sandbox_exec_tool.py` (10).

## P1 DONE (GAPT snapshots) — summary

Merged to gapt main `bdd93e2` (geny-adapted-project-toolkit PR #8). Files:
`db/enums.py` (SnapshotKind), `db/models.py` (Snapshot), migration
`e1f2a3b4c5d6` (off head `c1d2e3f4a5b6`), `domains/snapshots/{__init__,service}.py`,
`routers/snapshots.py`, `app.py` wiring, `tests/db/test_migration.py` (expected
sets), `tests/domains/snapshots/test_snapshot_mechanics.py`.

- **Capture**: throwaway `GIT_INDEX_FILE` + `git add -A [-f]` + `commit-tree` →
  `refs/snapshots/<id>` (working tree / branch / real index untouched).
  `tool_save` force-includes build artifacts. Activity = `build_transcript` over
  the `session_events` seq range → compact JSON in the row. Stats via numstat.
- **Restore**: `git reset --hard <sha>` + `git clean -fd` (artifacts tracked in
  the snapshot commit → restored; post-snapshot junk removed).
- **Endpoints**: POST/GET `workspaces/{id}/snapshots`, GET `snapshots/{id}`
  (+`/diff`,`/activity`), POST `/restore`, DELETE; audited.
- **Validated locally** (no Docker/PG): capture→mutate→restore byte-identical
  incl artifacts; ignored excluded w/o `-f`; empty-repo root snapshot; numstat
  parse. Alembic single head; 863 tests collect clean. DB round-trip + service
  tests run on Postgres (CI / 2223).
- **Activation**: redeploy GAPT on 2223 (docker-entrypoint runs `alembic upgrade
  head` → creates the table). Do this alongside the end-to-end wiring (P2–P5).

## P2 DONE (Geny pack store + loader) — summary
Geny main `8f62a6f0` (PR #1053). gapt submodule bumped to snapshot-capable `bdd93e2`.
- `service/sandbox_tool_packs/`: `models.py` (SandboxToolPackDefinition /
  SandboxToolSpec = exact executor SandboxExecTool spec / PackSkill), `store.py`
  (DB CRUD, UNIQUE pack_id+name, enabled default OFF), `loader.py`
  (`PackSandboxHandle` cold-restore-from-snapshot · `load_pack` → SandboxExecTool[]
  + Skill[] · `SandboxToolPackProvider` aggregates enabled packs).
- `service/database/models/sandbox_tool_pack.py` (SandboxToolPackModel) registered
  in APPLICATION_MODELS (auto table creation).
- `service/gapt/client.py`: 7 snapshot methods (create/list/get/diff/activity/
  restore/delete) calling GAPT P1.
- Tests (5): load builds tools+skills (shared handle); warm boot idempotent; cold
  re-provision+restore-from-snapshot; tool executes in pack workspace (JSON in/out);
  provider aggregation. Store CRUD itself runs on Postgres (CI).

## P3 DONE (save/test/manage API) — summary
Geny main `a29f4f1c` (PR #1054).
- `service/sandbox_tool_packs/builder.py`: `save_pack` (GAPT `create_snapshot`
  kind=tool_save, include_ignored → persist, enabled=False), `test_tool` (build
  SandboxExecTool + execute a spec with sample input), `resave_pack`.
- `controller/sandbox_tool_packs_controller.py`: GET list/{id}, POST /test, POST
  (save), POST /{id}/resave, PATCH /{id}/enabled, DELETE (+ snapshot cleanup).
- `main.py`: router mounted + store `set_database` at boot.
- 8 pack tests pass. (Note: P3 saves the *authoring* workspace as the pack
  workspace; the snapshot is the durable truth — reuse restores it. Dedicated
  per-pack project provisioning is a refinement deferred to P5 wiring.)

## Next: P4 (authoring loop — agent creates a pack unattended)
- executor: `env(action="forge_tool")` on the controller — register a
  `SandboxExecTool` live this turn (mirrors `create_skill`), so a freshly-saved
  tool is callable immediately.
- executor: bundled `tool-builder` skill (progressive) teaching the loop: write
  `main.<ext>` (stdin→stdout JSON) + skill docs via sandbox-routed Write/Bash →
  test → save (POST /api/sandbox-tool-packs) → verify next turn.
Then P5: env opt-in (global registry → env tool selection / SandboxToolPackProvider
into the session) + cross-session reuse + cold restore live verification; P6:
python_inline→sandbox migration + UI; deploy (GAPT 2223 + Geny).

## (archived) P1 resume notes

Repo: `/home/geny-workspace/Geny/gapt/server/`. HEAD migration = `c1d2e3f4a5b6`.
`docker-entrypoint.sh` runs `alembic upgrade head` on boot (auto-applies).

**Done:**
- `db/enums.py` — `SnapshotKind` (manual|tool_save|auto) ✅
- `db/models.py` — added `SnapshotKind` to the enums import ✅ (model class NOT yet added)

**TODO (in order):**
1. `db/models.py` — add `Snapshot(Base)` after `SessionEvent` (~line 547). Fields:
   `id`=_pk(); `workspace_id` FK workspaces CASCADE notnull; `session_id` FK
   agent_sessions SET NULL nullable; `parent_id` FK snapshots SET NULL nullable;
   `kind` `_pg_enum(SnapshotKind,"snapshot_kind_enum")` default manual; `label`
   String(255) default ""; `git_ref` String(255); `git_sha` String(64);
   `event_start_seq`/`event_end_seq` Integer nullable; `stats` JSONB default {};
   `activity` JSONB default {}; `created_at`=_created_at(); `created_by`
   String(80) nullable. Indexes: (workspace_id, created_at), session_id, parent_id.
2. `migrations/versions/20260623_e1f2a3b4c5d6_snapshots.py` — revision
   `e1f2a3b4c5d6`, down_revision `c1d2e3f4a5b6`. CREATE TYPE snapshot_kind_enum +
   create_table snapshots + indexes. (Pattern: see any versions/*.py; enum via
   `sa.Enum(..., name="snapshot_kind_enum")` or `postgresql.ENUM`.)
3. `domains/snapshots/__init__.py` + `service.py` — capture / list / get /
   restore / delete / get_diff / get_activity.
4. `routers/snapshots.py` — endpoints (see §4.3 of 01_PLAN.md).
5. `app.py` — `app.include_router(snapshots.router)` (after git.router ~line 454)
   + import.
6. Tests under `tests/`.

**Key code patterns (verified):**
- Get sandbox: `sb = container.workspace_sandbox.get(wid, ws.worktree_path); await sb.ensure()`.
- Exec: `rc, out_b, err_b = await sb.exec(argv, env={...}, cwd="/workspace", timeout_s=...)` — **no stdin**.
- DI (routers): `db=Depends(get_db_session)`, `user=Depends(get_current_user)`,
  `container=Depends(get_container)` (all from `gapt_server.container` /
  `routers.auth`). Reuse `_resolve_workspace` shape from `routers/git.py` (ws
  must be RUNNING).
- Router prefix `/_gapt/api/...`; audit via `domains/audit`.
- Git author env: set `GIT_AUTHOR_NAME/EMAIL` + `GIT_COMMITTER_*` (= "GAPT"/
  "gapt@hrletsgo.me") on commit-tree exec (see `routers/git.py:_git_exec`).

**Capture mechanics (decided):** one `sb.exec(["sh","-lc", script], env=...)`:
`cd /workspace; TMPIDX=$(mktemp); export GIT_INDEX_FILE=$TMPIDX;
git add <-A | -f -A>; TREE=$(git write-tree);
COMMIT=$(git commit-tree $TREE [-p $PARENT] -m "$MSG");
git update-ref refs/snapshots/$SID $COMMIT; rm -f $TMPIDX; echo $COMMIT`.
`include_ignored` (tool_save=True) → `git add -f -A` to capture build artifacts
(decision B-3). Working tree / branch / real index untouched. Parent = prior
snapshot git_sha (else HEAD). `stats` via `git diff --numstat <parent> <commit>`.
`activity` via `build_transcript(session_id=, events=[{kind,data,ts,seq} from
session_events WHERE session_id AND seq in (start,end]])` → compact JSON
(truncate big tool outputs). `event_end_seq` = max(seq) at capture; start = prior
snapshot's end+1 or 0.
**Restore:** `git reset --hard <sha> && git clean -fd` (artifacts are tracked in
the snapshot commit → restored; post-snapshot junk cleaned). Target ws default =
snapshot's workspace; cross-workspace works within same project (shared bare).
**Diff endpoint:** `git diff <parent_sha> <git_sha>` on demand (git is the record).
**Reuse helpers:** `agent/transcript.py:build_transcript`, `domains/workspaces/
diff.py` patterns, `routers/git.py` helpers.

## Next after P1

Design in [01_PLAN.md](01_PLAN.md) §4. Build in the GAPT repo
(`/home/geny-workspace/Geny/gapt/server/`): table + migration + `domains/
snapshots/` service + `routers/snapshots.py`. Verify: snapshot → mutate →
restore = byte-identical (incl. artifacts); activity replay shows chat+tool
trail; parent graph + delete.
