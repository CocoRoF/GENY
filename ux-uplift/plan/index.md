# ux-uplift Execution Plan

**Source:** [`../06_priority_buckets.md`](../06_priority_buckets.md) + [`../07_design_sketches.md`](../07_design_sketches.md)

PR 단위 분해. design sketch (07) 가 이미 wireframe + schema + file path 포함이므로 본 plan 은 PR ID + 의존성 + acceptance 만 명시.

---

## Cycle E (P0) — 15 PR · UX 가시성 critical path

### 묶음 E.1 — ToolCatalogTab (D1, 4 PR)

| PR | 핵심 변경 | 의존 |
|---|---|---|
| E.1.1 | Backend: `/api/tools/catalog/built-in` 응답 enrich (input_schema/capabilities/group/version) | — |
| E.1.2 | Frontend: ToolCatalogTab — sidebar(group) + 카드 그리드 + 상세 패널 | E.1.1 |
| E.1.3 | Backend: `/api/environments/{id}` 응답에 resolved built-in 추가 | — |
| E.1.4 | Frontend: ToolCatalogTab "Active in preset" toggle + tab nav 등록 | E.1.2 + E.1.3 |

### 묶음 E.2 — PermissionsTab (D2, 3 PR)

| PR | 핵심 변경 | 의존 |
|---|---|---|
| E.2.1 | Backend: `/api/permissions/rules` POST/PUT/DELETE — settings.json mutate | — |
| E.2.2 | Frontend: PermissionsTab — rule 표 + Add/Edit 모달 + tab nav | E.2.1 |
| E.2.3 | Backend+Frontend: ExecutionTimeline detail 에 matched rule 표시 | E.2.1 |

### 묶음 E.3 — HooksTab (D3, 3 PR)

| PR | 핵심 변경 | 의존 |
|---|---|---|
| E.3.1 | Backend: `/api/hooks/entries` POST/PUT/DELETE | — |
| E.3.2 | Backend: HookRunner fire ring buffer (executor PR) + `/api/admin/hook-fires` | E.3.1 |
| E.3.3 | Frontend: HooksTab — entries / in-process / recent fires + tab nav | E.3.1 + E.3.2 |

### 묶음 E.4 — Recent Activity + Workspace badge (D4, 5 PR)

| PR | 핵심 변경 | 의존 |
|---|---|---|
| E.4.1 | Backend: `/api/admin/recent-tool-events` (PR-B.1.3 ring buffer 노출) | — |
| E.4.2 | Backend: `/api/admin/recent-permissions` + permission decision EventBus emit | — |
| E.4.3 | Backend: `/api/agents/{sid}/workspace` GET + `/cleanup` POST | — |
| E.4.4 | Frontend: AdminPanel "Recent Activity" + "Permission Activity" 패널 | E.4.1 + E.4.2 |
| E.4.5 | Frontend: CommandTab 헤더 WorkspaceBadge + StackModal | E.4.3 |

---

## Cycle F (P1) — 30 PR · polish + extension

### 묶음 F.1 — Settings.json framework editors (6 PR)

각 section 마다 register_config dataclass + ConfigField:
- F.1.1 HooksConfig
- F.1.2 SkillsConfig
- F.1.3 ModelConfig
- F.1.4 TelemetryConfig
- F.1.5 NotificationsConfig (array editor)
- F.1.6 SettingsTab "Framework" / "Geny" 카테고리 분리

### 묶음 F.2 — Skill viewer + CRUD (5 PR)

- F.2.1 `/api/skills/{id}` GET (single + body)
- F.2.2 SkillPanel chip detail 모달
- F.2.3 `/api/skills` POST/PUT/DELETE (user skills)
- F.2.4 SkillsTab CRUD UI + tab nav
- F.2.5 settings.json:skills.user_skills_enabled toggle

### 묶음 F.3 — TasksTab + SubagentType (5 PR)

- F.3.1 `/api/subagent-types` GET
- F.3.2 TasksTab "New Task" 모달
- F.3.3 TasksTab row "Schedule as cron" 액션
- F.3.4 AdminPanel "Subagent Types" 패널
- F.3.5 SubagentType desc editor (선택; defer 가능)

### 묶음 F.4 — CronTab 보강 (4 PR)

- F.4.1 `/api/cron/jobs` 응답 enrich (next_fire_at) + `/status` PATCH
- F.4.2 CronTab Add Job 모달 enrich (cronstrue + kind-별 form)
- F.4.3 CronTab row enable toggle + expand
- F.4.4 `/api/cron/jobs/{name}/history` + 표시

### 묶음 F.5 — Built-in tool per-preset editor (4 PR; D5)

- F.5.1 ToolPresetDefinition built_in_tools/built_in_mode/built_in_deny 필드 + migration
- F.5.2 manifest 빌드 시 ToolPreset built_in 반영
- F.5.3 ToolSetsTab edit 모달 "Built-in tools" 섹션
- F.5.4 ExecutionTimeline 에 deny 된 built-in 표시

### 묶음 F.6 — Status viewers (6 PR)

- F.6.1 lifespan_status dict + `/api/admin/lifespan-status`
- F.6.2 AdminPanel "System Status" 패널
- F.6.3 CronRunner.last_tick_at + `/api/cron/status`
- F.6.4 CronTab 헤더 status badge
- F.6.5 BackgroundTaskRunner queue stats + endpoint
- F.6.6 TasksTab capacity meter

---

## Cycle G (P2) — long-tail (16 PR)

| 영역 | PR 수 |
|---|---|
| MCP custom server 추가 UI | 3 |
| MCP OAuth flow UI | 4 |
| Notification endpoint + SendMessage channel UI | 3 |
| Tool 사용량 / 호출 카운터 | 3 |
| Settings migration 상태 viewer | 1 |
| In-process hook handler list endpoint | 2 |

---

## 총합

- **Cycle E (P0): 15 PR**
- **Cycle F (P1): 30 PR**
- **Cycle G (P2): 16 PR**
- **합계: ~61 PR**

executor 측 PR 도 포함:
- E.3.2 — HookRunner fire ring buffer (executor 1.4.0 minor)
- E.4.2 — permission decision EventBus emit (executor minor)
- F.5.x — manifest 빌드 시 deny list 차감 (executor minor)

executor 변경은 cycle E 머지 전에 별도 release tag 필요 (1.4.0).

---

## PR 명명 규칙

- E.1.1 ~ E.4.5 (cycle E)
- F.1.1 ~ F.6.6 (cycle F)
- G.x.y (cycle G)

cycle A~D 의 PR 명명과 이어짐. 이전 cycle 의 PR-D.x.y 형식과 동일.

---

## 다음

execute 시작. PR-E.1.1 부터 순차.
