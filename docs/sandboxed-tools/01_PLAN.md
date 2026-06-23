# Sandbox Tool Packs + GAPT Native Snapshots — Plan & Report

> A Geny agent writes code in an isolated GAPT sandbox to create its OWN tools,
> tests them, and saves a self-contained **Sandbox Tool Pack** =
> **[independent environment] + [tool code] + [skills (how to use them)]** —
> persisted via a git-grade GAPT snapshot and reusable forever, perfectly inside
> geny-executor (the Agent-Engineering engine).
>
> Status: **PLAN v3 — all decisions LOCKED. Proceeding to P0.** 2026-06-23.

---

## 1. The unit: a "Sandbox Tool Pack"

Not a single tool — a **capability pack** an agent builds, saves, loads,
inspects, and reuses:

```
            ╔════════════════ SANDBOX TOOL PACK ════════════════╗
            ║                                                    ║
            ║  ① INDEPENDENT ENVIRONMENT                         ║
            ║     dedicated GAPT project (project separation)    ║
            ║     + workspace, restorable from a SNAPSHOT        ║
            ║     (files + build artifacts + agent activity)     ║
            ║                                                    ║
            ║  ② TOOL CODE  (1..N tools)                         ║
            ║     each = a SandboxExecTool (stdin/stdout JSON,    ║
            ║     runs inside the pack's sandbox)                ║
            ║                                                    ║
            ║  ③ SKILLS  (0..M)                                  ║
            ║     usage instructions for the tools, surfaced via ║
            ║     the existing progressive-disclosure skills     ║
            ╚════════════════════════════════════════════════════╝
```

A pack composes the three pillars we already have or are adding: the
self-modifying **env**, the **sandbox** (GAPT), and **skills** — into one
installable, reproducible capability. This is the headline deliverable.

---

## 2. Goal (verbatim) + decisions (ALL LOCKED 2026-06-23)

> "env 편집 + sandbox + 코딩으로 도구 생성 + 도구 테스트 + [sandbox + 새 툴]로 저장해
> 지속 사용. 다중 도구면 skills까지 포함하는 하나의 강력한 '샌드박스 도구'. geny +
> geny-executor에 완벽 구현."

| # | Decision | Choice |
|---|---|---|
| A | Execution model | **`sandbox_exec` script**: input=stdin JSON, output=stdout JSON, run via `docker exec` in the pack's GAPT workspace. |
| B | Persistence | **New native GAPT snapshot subsystem** (git-grade, AI-first): captures file state + **build artifacts** + **agent activity** (chat dialog + diffs + file/tool logs) as a restorable graph. |
| B-1 | Snapshot retention | **Keep all, git-style** (nothing auto-deleted) **+ explicit user delete** option. |
| B-2 | Snapshot trigger | On **`tool_save`** (when GAPT is used as a tool) **+ manual save in the GAPT frontend**. Auto-per-turn deferred (code never disappears anyway). |
| B-3 | Artifacts | **Include build artifacts (venv/compiled/deps) in the snapshot** → cold restore reproduces a working environment exactly. |
| C | Scope | **Global registry + per-env opt-in.** |
| D | Authoring | `env` forge action + a bundled **`tool-builder`** skill (progressive). |
| E | Storage | **New `sandbox_tool_packs` table** (a pack row; provenance: project_ref, workspace_ref, snapshot_ref; embeds tools[] + skills[]). |
| F | Code execution policy | **All newly-authored code runs in a sandbox.** Migrate the existing in-process `python_inline` onto the sandbox path (host `exec()` retired). |
| G | Project separation | **One GAPT project per pack** — isolated git repo + workspaces, leveraging GAPT's existing project model. |

---

## 3. Architecture

```
   ┌───────────────── Sandbox Tool Pack (persistent) ──────────────────┐
   │  Geny `sandbox_tool_packs` row (DB + JSON mirror)                  │
   │    id, name, description, scope=global, enabled, owner             │
   │    gapt_project_ref, workspace_ref, snapshot_ref                   │
   │    tools:  [ SandboxExecTool spec, ... ]   (N)                     │
   │    skills: [ {id, description, body}, ... ] (M)                    │
   └───────────────────────────────────────────────────────────────────┘
        │ load (new session / env opt-in)
        ▼
   Geny pack-loader:
     • GAPT: ensure project/workspace; if cold → restore from snapshot_ref
     • register each tool  → SandboxExecTool(GaptSandboxHandle(workspace_ref))
                             via ToolLoader → GenyToolProvider → ToolRegistry
     • register each skill → SkillTool (existing skills system, progressive)
        │
        ▼
   LLM has the pack's tools (callable) + skills (usage guidance on demand).
   Tool call → SandboxExecTool.execute() → sandbox_exec([runtime, entrypoint],
                stdin=JSON(input)) inside the pack workspace → JSON → ToolResult.
```

The **snapshot is the durable truth** for the independent environment. Tools and
skills are embedded in the pack row (and their source lives in the snapshot too),
so a pack is fully reproducible from `[snapshot_ref + row]`.

---

## 4. GAPT Native Snapshot Subsystem (core new capability)

Git-grade, graph-structured checkpoints capturing **workspace state + build
artifacts + AI agent activity**.

### 4.1 Captures
1. **File state + artifacts** — `git add -A` (force-include normally-ignored
   build artifacts/venv for tool packs) + commit to `refs/snapshots/<id>`;
   commit SHA anchors it. Captures tracked+untracked+uncommitted+artifacts so a
   restore yields a *working* environment (decision B-3).
2. **Agent activity** — a `session_events` seq range `{start,end}`. GAPT already
   persists chat (`USER_MESSAGE`/`TEXT`), tool calls (`TOOL_CALL`), tool results
   (`TOOL_RESULT`), cost, trace per session — the snapshot pins the exact range.
3. **Diff blob** — `working_tree_diff()` (patch + per-file stats) → object store.
4. **Graph** — `parent_id` → a DAG of checkpoints (git-like history, first-class).

### 4.2 Data model (GAPT Postgres + Alembic)
```
snapshots
  id ULID PK · workspace_id FK · session_id FK(nullable) · parent_id FK(nullable)
  kind enum(manual|tool_save|auto) · label · git_ref · git_sha
  event_start_seq · event_end_seq · diff_blob_path
  stats jsonb(files,additions,deletions,tool_calls,turns) · created_at · created_by
```
Retention: rows + refs kept indefinitely (B-1); `DELETE` endpoint removes a
snapshot (ref + row + blob) on explicit user action.

### 4.3 API (`/_gapt/api/…`)
```
POST   /sessions/{sid}/snapshots            capture (kind=tool_save|manual)
POST   /workspaces/{wid}/snapshots          manual capture (frontend button)
GET    /workspaces/{wid}/snapshots          list (graph order)
GET    /snapshots/{id}                       fetch
GET    /snapshots/{id}/diff                  captured diff
GET    /snapshots/{id}/activity             chat+tool transcript (event range)
POST   /snapshots/{id}/restore              git reset --hard <sha> into a workspace
POST   /snapshots/{id}/fork                 new workspace seeded from snapshot
DELETE /snapshots/{id}                       remove (explicit)
```
All mutations audited. Capture/restore run git in-sandbox via `_run_git`/`exec_in`.

### 4.4 Mechanics
- **Capture**: `git add -A` (+ `-f` artifact paths) → commit → `update-ref
  refs/snapshots/<id>` → store diff blob → record max `session_events.seq` → row.
- **Restore**: ensure workspace → `git fetch <bare> refs/snapshots/<id>` →
  `git reset --hard <sha>` (+clean to tracked artifacts) → byte-identical env.
- **Fork**: `git worktree add` at `<sha>` → independent project/workspace line.

---

## 5. Sandbox Tool Pack — lifecycle on snapshots + projects

- **Create**: Geny provisions a dedicated GAPT **project** + workspace for the
  pack (project separation, decision G). Agent writes tool code
  (`/workspace/tools/<name>/main.<ext>`, stdin→stdout JSON) + skill docs
  (`/workspace/.gapt/skills/<id>/SKILL.md`) + builds deps using existing
  sandbox-routed Write/Bash.
- **Test**: run each tool in the sandbox (`echo '<json>' | runtime main.<ext>`).
- **Save** (`tool_save` / frontend manual): GAPT takes a `kind=tool_save`
  snapshot (files + artifacts + authoring activity). Geny writes the
  `sandbox_tool_packs` row: project_ref, workspace_ref, snapshot_ref, the N tool
  specs, the M skills (read from `/workspace/.gapt/skills/`).
- **Reuse**: env opts in → pack-loader ensures the project/workspace, restoring
  from `snapshot_ref` if cold (exact env incl. artifacts), registers N tools + M
  skills. Tools dispatch into the restored sandbox.
- **Inspect**: list packs; view tools/skills; view the snapshot's diff + activity
  (the chat/diff/tool trail that built it).
- **Delete**: remove a pack (and optionally its snapshots — B-1).

---

## 6. Component plan

### 6.1 geny-executor (own the capability — "extend executor, not adapter")
- `SandboxExecTool(Tool)` (`tools/built_in/sandbox_exec_tool.py`): name/desc/
  input_schema/runtime/entrypoint/argv/timeout + a `SandboxHandle`; `execute()`
  → `sandbox_exec`, stdin JSON → stdout JSON → `ToolResult`; **no host fallback**;
  `to_dict()/from_dict()` spec ser/de.
- Promote `sandbox_exec` to public `tools/sandbox.py`.
- `env(action="forge_tool")` (+ optional `forge_skill` already = `create_skill`):
  register a `SandboxExecTool` live this turn, logged/bounded like `create_skill`.
- Skills (multi-tool packs include them) ride the existing SkillRegistry/SkillTool.
- Tests: fake `SandboxHandle`.

### 6.2 GAPT (own the sandbox + snapshots + projects)
- `snapshots` table + Alembic migration + `domains/snapshots/` service
  (capture/restore/fork/list/diff/activity) + `routers/snapshots.py`.
- Force-include artifact paths in tool_save snapshots.
- Project-per-pack provisioning helpers (reuse the project model).

### 6.3 Geny (own persistence + wiring + dev flow)
- `sandbox_tool_packs` table (DB model + JSON mirror) + `service/sandbox_tool_packs/`
  (store, `SandboxToolPackDefinition` embedding tools[]+skills[]).
- **Pack-loader**: restore workspace from snapshot → build `SandboxExecTool`s
  (GaptSandboxHandle) + register skills → merged into `ToolLoader` /
  `GenyToolProvider` + the session's SkillRegistry.
- Save/test API: `POST /api/sandbox-tool-packs` (+ `/{id}/test`, list/get/delete).
- Env opt-in (global registry → env tool selection); `env` enables for a session.
- **Migrate `python_inline` → sandbox** (decision F): route it through a sandbox
  workspace (retire host `exec()`), or fold it into the pack model.

### 6.4 Authoring UX
- Bundled `tool-builder` skill (executor, progressive): provision pack project →
  write tool code + skill docs → test → save → verify next turn.

---

## 7. Security
- The **sandbox is the boundary** (runc/sysbox, GAPT mount whitelist, cgroup caps).
  `SandboxExecTool` has **no host fallback**. Retiring in-process `python_inline`
  removes the last host-`exec()` path → all authored code is isolated (decision F).
- Saved packs default `enabled=false` until owner confirms; per-call `timeout_s`,
  output truncation. Snapshots content-addressed + audited; restore explicit.

---

## 8. Phased rollout (each independently shippable + verified)
- **P0 — executor `SandboxExecTool`** + public `sandbox_exec` + spec ser/de + tests. (executor minor bump)
- **P1 — GAPT snapshot subsystem** (table+migration+service+routers; artifacts force-included). Verify: snapshot → mutate → restore = byte-identical incl. artifacts; activity replay shows chat+tool trail; graph (parent) + delete.
- **P2 — Geny pack store + pack-loader + adapter**: a hand-written pack (project/workspace/snapshot + 1 tool + 1 skill) loads, restores cold, runs e2e on prod.
- **P3 — Save/test API + project-per-pack + tool_save snapshot**: `POST /api/sandbox-tool-packs` builds the full bundle.
- **P4 — Authoring loop**: `env(action="forge_tool")` + `tool-builder` skill → agent creates→tests→saves a pack (multi-tool + skills) unattended.
- **P5 — Reuse across sessions**: env opt-in, cold restore-from-snapshot; tool authored in session A callable in B; skills surface.
- **P6 — `python_inline` migration to sandbox** (decision F) + **P7 (optional)** GAPT frontend snapshot button + snapshot-graph/pack-manager UI.

---

## 9. Resolved review items
1. Retention: keep all (git-style) + explicit delete. ✅ (B-1)
2. Trigger: tool_save + frontend manual; auto deferred. ✅ (B-2)
3. Cold restore: artifacts included in snapshot → exact working env. ✅ (B-3)
4. `python_inline`: migrate to sandbox; all new code runs sandboxed. ✅ (F)
