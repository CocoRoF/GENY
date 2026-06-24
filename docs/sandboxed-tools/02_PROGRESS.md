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

## ✅ Orphan misdetection FIXED + create/reuse LIVE-VERIFIED — 2026-06-24

**Bug:** GAPT's `_is_orphan` flagged a LIVE workspace as orphan when its *project*
was archived. Geny reuses one project ("geny") for session + pack workspaces, and
GAPT auto-archives a momentarily-empty project → "clean all" killed live workspaces.

**Fix (gapt main `ef993ea`, PR #12):**
- `_is_orphan`: a live (non-ARCHIVED) workspace row is never an orphan regardless of
  project archive (only row-missing/row-ARCHIVED/exited-agent-sandbox qualify).
- `WorkspaceService.create`: un-archives the project on workspace create (root-cause).
- 6 unit tests.

**Deployed both GAPT instances** (Geny submodule bumped → `81e60d41`):
- 2223 (public): clean compose rebuild + recreate from ef993ea.
- 2222 (Geny's GAPT): full rebuild via the correct `--env-file deploy/gapt/.env`
  (the overlaid compose needs it; earlier silent failures were a missing
  `GAPT_POSTGRES_PASSWORD`). Migration ran → `snapshots` table created; orphan fix
  live; `geny` project un-archived.

**Live create+save+reuse PASS on 2222:** author tool in a workspace → `save_pack`
(tool_save snapshot + persist) → reload pack → run tool in its workspace →
`{"sum":10}`. The orphan fix means pack workspaces are no longer killed, so they
persist for reuse.

**Known gap (enhancement):** cross-workspace cold-restore (restore a snapshot into a
*fresh/different* workspace — disaster-recovery + fork) fails ("not a git repository")
because the snapshot commit lives in the source workspace's local `.git`. Needs
*portable snapshots* (git bundle in the object store). The common reuse path (pack's
dedicated workspace persists, protected by the orphan fix) does not need it.

## ✅ Portable snapshots — robust cross-workspace reuse LIVE-VERIFIED — 2026-06-24

**Gap closed:** snapshots were only restorable into the workspace they were
captured in. Now each capture also writes a self-contained git **bundle** of the
snapshot ref (host-side, to `<bare_root>/.snapshots/<id>.bundle`, recorded in
`stats.bundle_path`); **restore is host-side + portable** — it inits the target
repo if needed, fetches the commit from the bundle when absent, then `reset
--hard`. (gapt main `74a955c`, PR #13; `_hg` wraps host git with
`safe.directory=*`; +portable-bundle test; 12 snapshot/orphan tests pass.)

**Deployed both instances** (Geny submodule → `e852a82f`): 2222 (full rebuild,
`--env-file deploy/gapt/.env`) + 2223 (compose rebuild). Both healthy.

**Live-verified on 2222 — true cross-workspace reuse:** create tool in workspace
A → snapshot (bundle) → restore into a FRESH workspace B (no shared git) → run →
`{"greeting":"hi Portable","from":"cold-restored-snapshot"}`. PASS. The Geny
`PackSandboxHandle` cold-restore path now functions (disaster-recovery / host
migration / fork). Also archived leftover test workspaces.

**Net:** sandbox tool **creation + reuse** works end-to-end + robustly — packs
aren't false-killed (orphan fix), persist for normal reuse, and survive
workspace loss via portable snapshots.

## ✅ P4 — Authoring loop (forge_tool + tool-builder skill) LIVE-VERIFIED — 2026-06-24

**executor 2.31.0** (PyPI; Geny pinned `>=2.31.0`):
- **`env(action="forge_tool")`** — `PipelineEnvironment.forge_tool(name, entrypoint,
  …)` builds a `SandboxExecTool` bound to the session's sandbox and registers it
  in the live registry → a tool the agent just wrote + tested in its workspace is
  callable next turn. Guards: needs a sandbox, no name clobber, name+entrypoint
  required. +6 unit tests.
- **Bundled `tool-builder` skill** (L1 SKILL.md + L2 REFERENCE.md) — teaches the
  loop: write stdin/stdout-JSON script → test → forge → persist as a pack.
- Drive-by: fixed a CI-flaky `_drain_stdin` (swallow benign ConnectionResetError/
  BrokenPipeError on normal child exit) that was blocking the release.

**Wiring (already present):** `AgentSession._build_pipeline` calls
`attach_runtime(sandbox=gapt_sandbox)` for every GAPT-bound session, so
`ctx.sandbox` = the session's GAPT workspace → `forge_tool` works in any live
chat with no extra plumbing.

**Live-verified on 2222** (backend rebuilt no-cache → executor 2.31.0, `forge_tool`
action + `tool-builder` skill present, healthy): provision a session workspace →
write `tools/rev/main.py` via the docker-exec path → `forge_tool('rev')` → call
`rev({"s":"hello"})` → `{"rev":"olleh","forged":true}`. PASS.

**Status:** the user's core ask is complete + live — author a tool in a sandbox
(forge_tool), save it + its sandbox as a persistent pack (snapshot + portable
bundle), reuse it (load + cross-workspace cold-restore); a pack bundles N tools +
M skills. Remaining (polish): **P5** pack opt-in per env + agent-triggered save
from chat; **P6** python_inline→sandbox migration + pack-manager/snapshot-graph UI.

## ✅ P5 + P6 — full authoring/reuse loop + UI LIVE-VERIFIED — 2026-06-24

**P5a — agent-triggered save (executor 2.32.0):** `env(action="save_pack")` →
`PipelineEnvironment.save_pack` gathers forged tools + authored skills + the live
sandbox, delegates to a host `pack_persistence` callback wired in
`AgentSession._make_pack_persistence` (snapshots the session workspace via
builder.save_pack, persists the pack disabled). LIVE on 2222: forge tool + author
skill → save_pack → `{1 tool + 1 skill + snapshot}` persisted → reload + run
`{"shout":"HI","packed":true}`. PASS.

**P5b — per-env opt-in:** `host_selections.extras.sandbox_tool_packs` selects
packs; `SandboxToolPackProvider(pack_ids=…)` loads only selected+enabled packs;
session build registers their skills + unions their tool names into
`manifest.tools.external` (new `instantiate_pipeline(extra_external_tools=…)`).
LIVE: filter loads A+C, excludes B; no-filter loads all. PASS.

**P6a — python_inline → sandbox (opt-in):** `PythonInlineConfig.run_in_sandbox`.
When set, the source is NEVER exec()'d on the host (not even at load) — it runs
isolated in the session sandbox via a stdin/stdout harness (no host access).
LIVE: `underlying is None` (no host exec), sandbox run `{'doubled':42}`, no-sandbox
refused. PASS. Default off preserves the legacy single-admin host path.

**P6b — UI:** `/sandbox-tool-packs` manager (list / enable-disable / delete +
tool·skill·snapshot detail), Header nav entry, and a "Tool Packs" panel in the
env editor Global Settings writing `extras.sandbox_tool_packs`. Frontend
typechecks clean.

**Deployed 2222:** backend rebuilt (executor 2.32.0) + frontend rebuilt; nginx
reloaded. The entire vision is now live: build a tool in a sandbox → save it +
its environment as a portable pack → reuse it (per-env, cross-workspace), with
isolation for inline code and a UI to manage it. Ready for real-usage verification.
