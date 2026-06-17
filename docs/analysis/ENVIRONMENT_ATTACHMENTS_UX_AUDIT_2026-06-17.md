# Environment & Attachments — Deep UX/Architecture Audit (2026-06-17)

**Scope:** How Geny's "환경(Environment)" works as the base space, and how the six
attachable subsystems — **MCP servers, Skills, Custom Tools, Hooks, Permissions,
Triggers** — are *created*, *stored*, *connected to an environment*, and *actually
used by a session*. Grounded in code (backend + frontend), not docs.

---

## 0. Executive summary

The **philosophy holds in code**: an environment IS the geny-executor space — a
persisted `EnvironmentManifest` (v3.0, 21 stages) that a session resolves via
`env_id → manifest → Pipeline`. Model, pipeline, stages, memory, provider, MCP, and
tools all flow from it. That core is sound.

The **problem the user senses is real and specific**: the six attachable things bind
to an environment through **three different scopes and four different mechanisms**,
and **three of the six bindings are partially or fully non-functional** despite having
working UIs. A user who "registers an MCP / skill / tool / hook / permission / trigger"
has no single, coherent way to know whether — and how — it reaches a session.

### The binding matrix (the heart of this report)

| Attachable | Global registry page works? | Per-ENV binding | Binding **actually enforced**? | Per-SESSION |
|---|---|---|---|---|
| **Permissions** | ✅ (권한) | Stage 0 → `host_selections.permissions` | ✅ **YES** | — |
| **MCP servers** | ✅ (MCP) | Stage 10 → `tools.mcp_servers` (snapshot) | ✅ YES (SDK path) | — |
| **Custom tools** | ✅ (커스텀 도구) | Stage 10 → `tools.external` (by name) | ✅ YES *(but manual only — no default/★)* | — |
| **Hooks** | ✅ (HOOK) | Stage 0 → `host_selections.hooks` | ❌ **DEAD — never read; hooks are host-global** | — |
| **Skills** | ✅ (SKILLS) | Stage 0 → `host_selections.skills` | ❌ **DEAD — never read; skills are per-ROLE** | — |
| **Triggers** | ✅ (트리거 관리) | ❌ **none — no manifest field at all** | n/a | ✅ CreateSessionModal + live attach |

**Three scopes, no labels:** the 7 sibling tabs *look* uniform (all card-list CRUD)
but live at three scopes — host-global registry (all 6 tabs), per-env selection
(Stage 0 vs Stage 10 — two different places), and per-session (triggers only). Nothing
in the IA tells the user which is which.

---

## 1. Environment core — how the space is built (this part works)

- **Manifest** = library `geny_executor/core/environment.py` `EnvironmentManifest`
  (9 sections: `version, metadata, model, pipeline, stages[21], tools, host_selections,
  subagents, memory`). Re-exported by `service/environment/service.py`.
- **Storage:** DB-primary (`environments` table, JSONB `data`) + always-mirrored JSON
  files (`/data/environments/{env_id}.json`). `_reconcile` at boot (DB wins on conflict).
  *(Note: this is one of the reconcile services affected by the historical
  `execute_insert` non-commit bug — fixed in PR #937; verify DB rows persist.)*
- **Create / clone / edit:** `controller/environment_controller.py` →
  `service/environment/service.py` (`create_blank` / `create_from_preset` / `duplicate`
  / granular stage/model/pipeline patches). Write-time validation only
  (`_validate_for_write` → library `validate_manifest`).
- **Use:** `agent_session_manager.create_agent_session` →
  `resolve_env_id(role, env_id)` → `instantiate_pipeline` → `Pipeline.from_manifest_async`.
  The session **freezes** that pipeline; live edits propagate via
  `propagate_env_update` (`_needs_manifest_reload` flag → rebuild on next idle access).
- **Seed presets (UI cards):** `service/environment/templates.py`, rewritten **every boot**
  from library factories: Worker / VTuber (active-provider) + Claude-Code · Worker / VTuber
  (provider hard-locked to `claude_code_cli`). Only Stage-6 provider differs between a
  seed and its Claude-Code twin.

### Env-core caveats
- **`subagents[]` manifest section is IGNORED** — Geny builds its subagent registry
  host-side (`SubagentRegistryBuilder`) and never reads `manifest.subagents`. Editing
  that section has no effect (silent divergence risk).
- **Boot reseed overwrites Stage-6 provider** on `template-worker-env` / `template-vtuber-env`
  every restart — hand-edits to the provider on those two ids don't survive.
- **`_extract_primary_provider` only matches `order==6 and name=="api"`** — a renamed/
  reordered Stage 6 returns `None`, skipping the credential pre-check (failure surfaces
  at first LLM call instead of at session create).

---

## 2. Per-subsystem findings (storage · page · binding · gaps)

### 2.1 Permissions — ✅ the reference implementation (per-env, real)
- **Store:** user-scope `settings.json:permissions` (+ project/local cascade). Rule id
  `"<tool>::<pattern>::<behavior>"`.
- **Page (권한):** full CRUD on user rows; cascade rows read-only; mode toggle.
- **Binding (REAL):** `agent_session.py:_load_permission_host_selection` reads
  `manifest.host_selections.permissions` → `permission/install.py:_apply_host_selection`
  intersects rules → `attach_runtime(permission_rules=…)`. Re-applied on between-turn
  refresh. **This is the only attachable whose per-env picker + ★ truly bind.** Use it as
  the template for the others.

### 2.2 MCP servers — ✅ works, but two parallel paths (one dead) + snapshot drift
- **Store:** JSON files `mcp/custom/*.json` (`MCP_CUSTOM_STORAGE_PATH` → `/data/mcp/custom`
  in prod, on the `geny-mcp-credentials-prod` volume). Built-ins in `mcp/built_in/*.json`.
  Loader: `service/mcp_loader.py` (`load_all` + `set_global_mcp_config`). `${VAR:-default}`
  expansion; unresolved-`${VAR}` servers skipped.
- **Page (MCP):** full CRUD + test-connection (`McpServersTab.tsx`). ★ env-default toggle.
- **Binding (REAL via manifest):** the only live path for SDK-provider sessions is
  `manifest.tools.mcp_servers` (full server bodies), connected by
  `Pipeline.from_manifest_async`. Seeded into **new drafts** from ★ `env_defaults` by the
  **FE seeder** (`useEnvironmentDraftStore.seedDefaultToolLists`).
- **DEAD path:** `build_session_mcp_config` + tool-preset `allowed_mcp_servers` →
  `AgentSession._mcp_config` is **assigned but never read** for manifest sessions. It only
  matters for `claude_code_cli` (via the credentials bridge). Editing a tool-preset's
  `mcp_servers` has no visible effect.
- **Gaps:** (a) snapshot drift — a rotated token requires editing every env that copied the
  server; (b) ★ seeds only *new* drafts, never existing envs, and **server-side env-create
  never reads env_defaults** (any API/preset/clone-created env gets zero MCP).

### 2.3 Custom tools — ✅ works, but asymmetric vs MCP + one broken kind + no sandbox
- **Store:** Postgres `custom_tools` table (DB-only, no file fallback). Kinds:
  `http`, `mcp_proxy`, `builtin_alias`, **`python_inline`**.
- **Page (커스텀 도구):** full CRUD + dry-run/real test + hot-reload.
- **Binding (REAL via manifest):** a tool reaches a session **only if its `name` is in
  `manifest.tools.external`**, resolved against the host `GenyToolProvider`. The tab banner
  ("ToolLoader 가 모든 세션에 자동 노출") is **misleading** — tools are *loaded/advertised*
  globally but only *registered* in a session whose manifest names them. A fresh env with an
  untouched `tools.external` includes **no** custom tool.
- **Gaps / bugs:**
  - **`mcp_proxy` is RUNTIME-BROKEN** — `McpProxyAdapter.arun` imports
    `get_session_mcp_call_dispatcher` from `service.mcp_loader`, **which does not exist**.
    Any call raises `ToolError`. The test only checks adapter *type*, so CI stays green.
  - **`python_inline` runs `exec()` server-side with NO sandbox** — a web-authored Python
    tool executes in-process. Security/abuse concern for a single-admin box, but worth noting.
  - **No ★ env-default + no env_defaults category** for custom tools (unlike MCP), so
    "make this tool a default for new envs" is impossible — only manual per-env Stage-10 add.

### 2.4 Hooks — ❌ per-env UI is DEAD (host-global reality)
- **Store:** `settings.json:hooks` / legacy `~/.geny/hooks.yaml`. Loaded by
  `service/hooks/install.py:install_hook_runner`, gated by `GENY_ALLOW_HOOKS=1` **and**
  `enabled: true`.
- **Page (HOOK):** full CRUD + audit log + enabled toggle + ★ + per-env `HookEnvPicker`
  (writes `draft.host_selections.hooks`).
- **Binding (DEAD):** `agent_session.py:2395-2397` calls `hooks.attach_kwargs()` — which
  **takes no `host_selection` argument** and reads only host-global config. So
  `manifest.host_selections.hooks` is written by the picker, persisted, and **never read.**
  Every env with hooks enabled fires the **same full hook set.** Per-env narrowing is a
  silent no-op.

### 2.5 Skills — ❌ per-env UI is DEAD; bound by ROLE instead
- **Store:** executor-bundled + `backend/skills/bundled/` + samples + user `~/.geny/skills/`
  (opt-in). Role gating via `_SKILL_ROLE_RESTRICTIONS` (e.g. `whiteboard-*`, `blog-write`
  are vtuber-only).
- **Page (SKILLS):** CRUD on user skills; built-ins view+copy; ★ + per-env `SkillEnvPicker`
  (writes `draft.host_selections.skills`).
- **Binding (DEAD per-env; REAL per-role):** `agent_session_manager.py:771-789` calls
  `install_skill_registry(role=…)` — **no `env_id`, no `host_selections.skills`.** The
  manifest field is never consumed. The env picker even lists the *full untrimmed* catalog
  (the list endpoint passes no role), so the selection is doubly misleading.
- **Role-vs-env tension:** skills are a *role* axis (vtuber/worker); the UI offers a *per-env*
  selector. The two axes never meet — env selection does nothing, and a role restriction
  can't be relaxed per-env.

### 2.6 Triggers — ❌ no env binding at all (per-session only)
- **Store:** `trigger_presets` table + `/data/trigger_presets/*.json`. Seeded `default`
  preset; unattached sessions resolve to it.
- **Page (트리거 관리):** full CRUD; the tab banner correctly states "호스트 공용 … VTuber
  세션을 만들 때 선택해 부착."
- **Binding:** strictly **per-session** — `CreateSessionModal` picks `trigger_preset_id`
  (a separate field next to `env_id`, with no link between them) → `attach_preset(session_id,…)`.
  Live swap via `PUT /api/agents/{id}/trigger-preset`. **The env manifest has no trigger
  field** (`grep trigger service/environment/` is empty). This is the single sharpest
  "expected-but-absent" connection: a trigger preset is a sibling tab of MCP/Skills in
  환경관리, but unlike them it cannot be attached to an environment.

### 2.7 `env_defaults` (★ "새 env 기본 포함") — FE-seed-only, half-covered
- **Store:** `persistent_configs` under `config_name="env_defaults"`, 4 categories
  (`hooks/skills/permissions/mcp_servers`). No id validation against host registries.
- **Consumed ONLY by the FE draft seeder** for **new** drafts; **no server-side
  env-create path reads it**, clone doesn't seed, existing envs/sessions never re-seed.
  **Custom tools and Triggers have no ★ at all** → the "default for new envs" idea covers
  4 of 6 attachables and even those only on the FE happy path.

---

## 3. The core architectural inconsistency

```
                         REGISTRY (global)      PER-ENV BINDING            ENFORCED?
  Permissions   권한      settings.json   ──►   Stage 0 host_selections   ✅ yes
  Hooks         HOOK      settings.json   ──►   Stage 0 host_selections   ❌ DEAD (host-global)
  Skills        SKILLS    files           ──►   Stage 0 host_selections   ❌ DEAD (per-role)
  MCP           MCP       json files      ──►   Stage 10 tools.mcp_servers ✅ yes (snapshot)
  Custom tools  커스텀     custom_tools DB ──►   Stage 10 tools.external    ✅ yes (manual only)
  Triggers      트리거     trigger DB      ──►   (no manifest field)        — per-session only
                                          ★ env_defaults seeds 4/6, FE-only, new-drafts-only
```

Four mechanisms (`host_selections` subset · `tools.*` snapshot/by-name · per-session attach ·
★ FE seeder), split across **two different editor locations** (Stage 0 vs Stage 10), with
**inconsistent ★ coverage**, and **three of six bindings non-functional** — yet all surfaced
as **identical-looking sibling tabs**. That is exactly why "creating, using, and connecting
these settings" feels unreliable: sometimes it works, sometimes the UI lets you do something
that silently does nothing.

---

## 4. Critical issues, ranked

| # | Severity | Issue | Where |
|---|---|---|---|
| C1 | **High** | Hook per-env picker (`host_selections.hooks`) **never enforced** — silent no-op | `hooks/install.py:attach_kwargs()` (no selection arg); `agent_session.py:2395` |
| C2 | **High** | Skill per-env picker (`host_selections.skills`) **never enforced** — bound by role only | `agent_session_manager.py:771-789`; `skills/install.py` |
| C3 | **High** | Triggers have **no env binding** — only per-session, despite a 환경관리 sibling tab | `service/environment/*` (no trigger field); `CreateSessionModal.tsx` |
| C4 | **High** | `mcp_proxy` custom tools **crash at runtime** (`get_session_mcp_call_dispatcher` missing) | `custom_tools/adapters.py:319` |
| C5 | **Med** | `env_defaults` ★ **FE-seed-only** — API/preset/clone-created envs ignore it; existing envs never re-seed | `useEnvironmentDraftStore.ts`; `environment/service.py:478-531` |
| C6 | **Med** | Custom tools have **no ★ / no default-include**, unlike MCP (asymmetry) | `CustomToolsTab.tsx`; `env_defaults/service.py:38` |
| C7 | **Med** | `AgentSession._mcp_config` + tool-preset `allowed_mcp_servers` **dead** for SDK sessions | `agent_session.py:498`; `agent_session_manager.py:611-639` |
| C8 | **Low** | `python_inline` custom tool `exec()`s with **no sandbox** | `custom_tools/adapters.py:417` |
| C9 | **Low** | Custom-tools tab banner ("자동 노출") **misleading** — only `tools.external` names register | `CustomToolsTab.tsx:188` |
| C10 | **Low** | `manifest.subagents[]` **ignored** by Geny (built host-side) | `agent_session_manager.py:734-796` |

---

## 5. Recommendations — make "create → connect → use" coherent

### Target model (one sentence)
> Every attachable is a **host-global registry** (the tabs); each is **bound to an
> environment** through the manifest via **one uniform mechanism**; each binding is
> **actually enforced** at session build; and **★ default-include** works identically for
> all of them, server-side. Per-session override stays only where it makes sense (triggers).

### P1 — Fix the three dead/missing env bindings (correctness first)
1. **Enforce `host_selections.hooks`.** Add a `host_selection` param to
   `install_hook_runner` / `attach_kwargs` (mirror permissions); filter parsed hook entries
   by the `"<event>::<command>"` id; call it from `agent_session.py` with a generalized
   `_load_host_selection("hooks")`. Apply on the refresh path too.
2. **Enforce `host_selections.skills`** (or remove the picker). Preferred: after
   `install_skill_registry(role=…)`, intersect the registry with `manifest.host_selections.skills`
   before `attach_provider` (role gating stays the floor, env narrows further). If instead
   skills are deemed a pure role concern, **delete `SkillEnvPicker`** and document it.
3. **Give triggers an env binding.** Add `host_selections.trigger_preset` (single id) to the
   manifest; surface a trigger picker in the env editor (Stage 0, it's VTuber-runtime not a
   tool); have the VTuber session-create resolve the trigger from the env when the modal
   leaves it blank. Keep `CreateSessionModal` + `PUT /trigger-preset` as an **override**.
4. **Fix or hide `mcp_proxy`.** Implement `get_session_mcp_call_dispatcher` (bridge to the
   executor `MCPManager`) or hide the kind in the new-tool modal until it exists. Add a test
   that actually calls `arun`.

### P2 — Generalize the `host_selection` reader + enforcement
Refactor `_load_permission_host_selection` → `_load_host_selection(category)` returning
`manifest.host_selections.{category}`, and a shared `resolve(host_ids, selection)` helper.
The id contract already exists (`env_defaults/__init__.py:24-32`). Then hooks/skills/permissions
all enforce through one path. (Consider folding MCP/custom-tools "by name" selection into the
same `host_selections` model long-term, replacing the snapshot copy in `tools.mcp_servers`
with a reference resolved at instantiate time — kills snapshot drift.)

### P3 — Make ★ env-defaults uniform, server-side, and honest
- Move the seed into `EnvironmentService.create_blank/create_from_preset` (read
  `EnvDefaultsService`, apply when the caller didn't pass an explicit override) so
  API/preset/clone-created envs honor it; FE seeder becomes a preview.
- Add ★ to **Custom Tools** and **Triggers** (5th/6th `env_defaults` categories).
- Relabel the tooltip: "새 환경 생성 시 기본 포함 (기존 환경에는 영향 없음)"; optionally add an
  explicit "기존 환경에도 적용" action.

### P4 — Unify the per-env surface + label scope in the IA
- Consolidate the env editor's attachment story: today hooks/skills/permissions live in
  **Stage 0** and MCP/custom-tools in **Stage 10**. Offer one "이 환경의 구성요소
  (MCP · 스킬 · 도구 · 훅 · 권한 · 트리거)" panel, or at least cross-link both.
- Badge each registry tab with its binding model: "호스트 공용 · 환경별 선택" vs (until P1)
  "호스트 공용 · 세션별 부착", plus a one-line breadcrumb "이 항목을 환경에 연결하려면 →
  환경 편집 → Stage X".

### P5 — Surface "used by" (blast radius) on every registry
Generalize the existing `GET /api/trigger-presets/{id}/sessions` pattern to all six:
show "used by N envs" (MCP/skills/tools/hooks/perms) or "N sessions" (triggers) on each card,
so editing/deleting a host item shows its reach.

---

## 6. Suggested sequencing
1. **C4 (mcp_proxy)** + **C1/C2 dead-UI honesty note** — quick correctness/clarity wins.
2. **P1.1 + P1.2** (hooks/skills enforcement via the generalized reader) — turns two dead
   UIs real with one refactor (P2).
3. **P1.3** (triggers → env) — the highest user-visible "missing connection."
4. **P3** (server-side ★ + custom-tools/triggers ★) — consistency.
5. **P4/P5** (IA labeling + used-by) — discoverability polish.

---

### Appendix — key files
- Env core: `service/environment/{schemas,service,templates,role_defaults}.py`,
  `service/database/models/environment.py`, `geny_executor/core/environment.py`.
- Session wiring: `service/executor/agent_session_manager.py` (`:536-903, 1486-1526`),
  `service/executor/agent_session.py` (`:498, 1804-1845, 2368-2402`).
- MCP: `service/mcp_loader.py`, `controller/mcp_custom_controller.py`.
- Custom tools: `service/custom_tools/{models,store,adapters}.py`,
  `service/tool_loader.py`, `service/executor/geny_tool_provider.py`.
- Skills/Hooks/Perms: `service/skills/install.py`, `service/hooks/install.py`,
  `service/permission/install.py`.
- Triggers: `service/vtuber/thinking_trigger.py`, `service/trigger_preset/service.py`,
  `controller/agent_controller.py` (`:466-515`).
- env_defaults: `service/env_defaults/service.py`, `controller/env_defaults_controller.py`.
- FE: `frontend/src/components/env_management/{EnvManagementShell,EnvManagementHeader,
  OverviewView,GlobalSettingsView,HostSelectionPickers,EnvDefaultStarToggle}.{tsx,ts}`,
  `stages/Stage10ToolsEditor.tsx`, `components/tabs/{McpServers,Skills,CustomTools,Hooks,
  Permissions,Triggers}Tab.tsx`, `store/useEnvironmentDraftStore.ts`,
  `components/modals/CreateSessionModal.tsx`, `lib/triggerPresetApi.ts`.

---

## Remediation status — 2026-06-17 (follow-up batch)

All remaining critical/major findings from this audit were implemented in
one batch (the Trigger mapping + designatable default — C-trigger — shipped
earlier in #946 with geny-executor 2.6.0's `HostSelections.extras`):

| Item | Finding | Resolution |
|------|---------|------------|
| **C1** | Hook per-env picker (`host_selections.hooks`) never enforced — silent no-op | `install_hook_runner(host_selection=...)` now narrows the parsed `HookConfig` to exactly the selected hook ids (`"<event>::<command+args>"`, matching the FE / env_defaults scheme). Wired at `_build_pipeline` + the runtime-refresh path via the generalised `AgentSession._load_host_selection(category)`. Frozen-dataclass safe (`dataclasses.replace`). +7 tests. |
| **C2** | Skill per-env picker (`host_selections.skills`) never enforced — bound by role only | `install_skill_registry(host_selection=...)` adds a second gate (`_skill_in_host_selection`) orthogonal to the role gate, applied at all four load sources. Manager passes `_env_host_selection(env_id, "skills")`. +7 tests. |
| **C4** | `mcp_proxy` custom tool crashes at call time (`get_session_mcp_call_dispatcher` never implemented; adapter discards `session_id`) | Creation/replace of the kind is rejected server-side (`_build_definition` → 400) and hidden from the FE new-tool picker; runtime `ToolError` clarified to point at the env MCP server mapping. +3 tests. Implementing a real dispatcher is a redesign (needs session→MCPManager plumbing) tracked separately. |
| **C5** | env_defaults applied only by the FE draft seeder — API/preset/blank-created envs ignored ★ | `EnvironmentService._apply_env_defaults(manifest)` seeds `host_selections.{hooks,skills,permissions}` server-side on every non-override create path. `mcp_servers` (declarative configs) stays FE-materialised. +6 tests. |
| **C6** | Custom tools had no ★/default concept | New `custom_tools` env_defaults category (id = tool name). ★ toggle on each custom-tool card; server-side + FE-draft seeders both seed ★-marked custom (DB) tools into `tools.external` (empty set = legacy "seed all"). |
| **C7** | `self._mcp_config` / tool-preset `allowed_mcp_servers` dead for SDK sessions | Verified dead (assigned, never read; MCP resolves from manifest `tools.mcp_servers`). Documented in-code at both sites rather than removed — the kwarg is part of the `create()` signature and removal would risk the live MCP path without executor-internal verification. |
| **C9** | Misleading custom-tools banner ("auto-expose to every session; per-env is future") + stale permissions banner ("not enforced — preview only") | Both banner copies (ko + en) corrected: custom tools are per-env via `tools.external` (★ seeds new envs); per-env permission narrowing IS enforced. |

Not changed (low severity / out of scope): C8 `python_inline` runs unsandboxed
(by design — single-admin host; "hide this kind first" if ever opened up),
C10 `subagents[]` manifest field. Pre-existing unrelated test drift noted but
not chased: `blog-write` vs `blog_write` skill-id, several memory-routing /
default-manifest tests (fail on clean HEAD, unrelated to attachments).
