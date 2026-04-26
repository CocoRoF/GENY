# 06. Priority Buckets

본 chapter 는 deep dive 4 chapter (02~05) 의 모든 갭을 우선순위로 묶는다. 각 묶음은 단일 cycle 에 ship 가능한 사이즈.

---

## 우선순위 결정 기준

| 기준 | 가중치 |
|---|---|
| **A. 사용자 명시 1순위** (built-in tool) | 매우 높음 |
| **B. visibility-first principle** ("보이지 않는 데이터는 편집할 수 없다") | 높음 |
| **C. backend 가 이미 ship 됐는데 UI 없음** ("쉬운 갭") | 높음 |
| **D. 운영자 일상 빈도** (자주 보는가) | 중 |
| **E. backend 신규 ship 필요** ("어려운 갭") | 낮음 |

→ **P0** = A 또는 B+C 결합
→ **P1** = D + 부분 B
→ **P2** = E 만 또는 nice-to-have

---

## P0 — 다음 cycle critical path

### P0.1 — Built-in tool catalog viewer (사용자 명시 1순위)

[`02_gap_built_in_tools.md`](02_gap_built_in_tools.md) §3.1 의 단계 1 + 단계 2.

| PR | Scope | 추정 |
|---|---|---|
| 1 | `/api/tools/catalog/built-in` 응답 enrich (input_schema/capabilities/group/version) | S |
| 2 | Frontend: ToolCatalogTab 신규 — sidebar + 카드 그리드 + 상세 패널 | M |
| 3 | `/api/environments/{id}` 응답에 resolved built-in 추가 | S |
| 4 | Frontend: ToolCatalogTab "Active in preset" toggle | S |

**추정:** 4 PR. 한 cycle 에 ship.
**효과:** 사용자가 가진 33개 도구를 한 화면에서 보고, preset 별 활성 여부를 시각적으로 확인.

### P0.2 — Permission rules CRUD UI

[`03_gap_settings_editing.md`](03_gap_settings_editing.md) §1.

| PR | Scope | 추정 |
|---|---|---|
| 1 | `/api/permissions/rules` POST/PUT/DELETE | S |
| 2 | Frontend: PermissionsTab — rule 표 + Add/Edit 모달 | M |
| 3 | ExecutionTimeline detail 에 matched rule 표시 (audit) | S |

**추정:** 3 PR.
**효과:** 운영자가 yaml 직접 편집 없이 rule CRUD. ExecutionTimeline 에서 "왜 deny 됐는지" 추적.

### P0.3 — Hook configuration CRUD + recent fires

[`03_gap_settings_editing.md`](03_gap_settings_editing.md) §2 + [`05_gap_observability.md`](05_gap_observability.md) §6.

| PR | Scope | 추정 |
|---|---|---|
| 1 | `/api/hooks/entries` POST/PUT/DELETE | S |
| 2 | Hook fire ring buffer (executor) + `/api/admin/hook-fires` endpoint | M |
| 3 | Frontend: HooksTab — entries 표 + Add 모달 + recent fires log | M |

**추정:** 3 PR.
**효과:** Hook 설정 + 동작 검증 한 화면에서.

### P0.4 — Recent tool activity + Workspace viewer

[`05_gap_observability.md`](05_gap_observability.md) §1 + §2 + §7.

| PR | Scope | 추정 |
|---|---|---|
| 1 | `/api/admin/recent-tool-events` endpoint | S |
| 2 | `/api/admin/recent-permissions` + permission event emission | M |
| 3 | `/api/agents/{sid}/workspace` GET endpoint | S |
| 4 | AdminPanel "Recent Activity" 통합 패널 (tool + permission) | M |
| 5 | Frontend: CommandTab 헤더 workspace badge | S |

**추정:** 5 PR.
**효과:** 운영자가 "지금 무슨 일이 일어나고 있는지" 한 화면에서. Workspace state 가시화.

### P0 합계

**15 PR. 1 cycle (≈ 2주) 사이즈.** 4 갭 영역에서 가장 시급한 표면을 모두 노출.

---

## P1 — 후속 cycle 의 polish + extension

### P1.1 — Settings.json framework section 편집기

[`03_gap_settings_editing.md`](03_gap_settings_editing.md) §3.

5 section × dataclass + 1 SettingsTab 카테고리 분리 = **6 PR.**

### P1.2 — Skill viewer + CRUD

[`04_gap_session_data.md`](04_gap_session_data.md) §1.

5 PR.

### P1.3 — TasksTab New Task + SubagentType catalog

[`04_gap_session_data.md`](04_gap_session_data.md) §2 + §4.

3 PR (TasksTab 보강) + 2 PR (subagent catalog) = **5 PR.**

### P1.4 — CronTab 보강 (next_fire / cronstrue / kind schema / history)

[`04_gap_session_data.md`](04_gap_session_data.md) §3.

4 PR.

### P1.5 — Built-in tool 개별 enable/disable

[`02_gap_built_in_tools.md`](02_gap_built_in_tools.md) §3.3 (단계 3).

ToolPresetDefinition migration + ToolSetsTab 모달 확장 = **4 PR.**

### P1.6 — Lifespan status + Cron daemon status + Task runner queue

[`05_gap_observability.md`](05_gap_observability.md) §3+§4+§5.

6 PR (각 영역 2 PR).

### P1 합계

**30 PR. 2 cycle 사이즈.**

---

## P2 — long-tail (nice-to-have)

| 영역 | PR 수 |
|---|---|
| MCP custom server 추가 UI ([01](01_capability_visibility_matrix.md) C.2) | 3 |
| MCP OAuth flow UI ([01](01_capability_visibility_matrix.md) C.3) | 4 |
| Notification endpoint + SendMessage channel UI ([04](04_gap_session_data.md) §5) | 3 |
| Tool 사용량 / 호출 카운터 ([02](02_gap_built_in_tools.md) §4) | 3 |
| Settings migration 상태 viewer ([03](03_gap_settings_editing.md) §3.5) | 1 |
| In-process hook handler list endpoint ([01](01_capability_visibility_matrix.md) E.4) | 2 |

**P2 합계:** 16 PR. 큰 cycle 또는 분할.

---

## 권장 cycle 구조

```
Cycle E — ux-uplift / 20260427_1 (P0)
─────────────────────────────────────
P0.1 Built-in tool catalog viewer       [4 PR]   ──┐
P0.2 Permission rules CRUD UI            [3 PR]   │── 15 PR
P0.3 Hook configuration CRUD             [3 PR]   │   (~2주)
P0.4 Recent activity + Workspace viewer  [5 PR]   ──┘

Cycle F — ux-uplift / 20260428_1 (P1 part 1)
─────────────────────────────────────────────
P1.1 Settings framework section editors  [6 PR]   ──┐
P1.2 Skill viewer + CRUD                  [5 PR]   │── 16 PR
P1.5 Built-in tool individual control     [4 PR]   │
P1.6 Status viewers (lifespan/cron/tasks) [1 PR partial]──┘

Cycle G — ux-uplift / 20260429_1 (P1 part 2)
─────────────────────────────────────────────
P1.3 TasksTab + Subagent catalog         [5 PR]   ──┐
P1.4 CronTab 보강                         [4 PR]   │── 14 PR
P1.6 잔여 (status viewers)               [5 PR]   │
P2 selected items                        [— PR]   ──┘

Cycle H — audit + carve-outs (P2 + ops)
```

각 cycle 종료마다 audit cycle 1번씩 — `executor_uplift/20260425_3` / `new-executor-uplift/followup/05` 패턴 유지.

---

## P0 acceptance criteria

Cycle E 종료 시점에:

- [ ] ToolCatalogTab 으로 33개 도구 조회 가능 (사용자 1순위 명시)
- [ ] 각 도구의 input_schema / capabilities 표시
- [ ] preset 별 활성 도구 시각화
- [ ] PermissionsTab 에서 rule 추가 / 수정 / 삭제 가능
- [ ] HooksTab 에서 entry CRUD + recent fires
- [ ] AdminPanel 에 "Recent Tool Activity" + "Permission Activity"
- [ ] CommandTab 헤더에 workspace badge
- [ ] 기존 회귀 0

---

## 다음 chapter

- [`07_design_sketches.md`](07_design_sketches.md) — Top 5 우선순위의 UX 디자인 초안
