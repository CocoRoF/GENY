# Cycle A — overview (executor 1.1.0 + Geny adopt)

**Cycle ID:** new-executor-uplift / 20260426_1
**PR 수:** 31 (executor 19 + Geny 12)
**Executor minor bump:** 1.0.x → **1.1.0**
**Geny pyproject bump:** `geny-executor>=1.1.0,<1.2.0`

본 cycle 의 목표는 [`02_capability_matrix.md`](../02_capability_matrix.md) 의 가장 큰 4 격차 동시 해결:
1. **A.5 / H.30 / H.31** — Task lifecycle (P0.1)
2. **F.25** — Slash commands (P0.2)
3. **A.2** — Built-in tool catalog HIGH/MED 14 중 P0.1/P0.4 외 (P0.3)
4. **N.45 / N.46** — Cron / scheduling (P0.4)

---

## 묶음 구성 (= plan 파일 1:1)

| 묶음 | Plan 파일 | Executor PR | Geny PR | 합계 |
|---|---|---|---|---|
| A.1 | [`cycle_A_p0_1_tasks.md`](cycle_A_p0_1_tasks.md) — Task lifecycle | 5 (PR-A.1.1 ~ A.1.5) | — | 5 |
| A.2 | [`cycle_A_p0_2_slash.md`](cycle_A_p0_2_slash.md) — Slash commands | 4 (PR-A.2.1 ~ A.2.4) | — | 4 |
| A.3 | [`cycle_A_p0_3_tools.md`](cycle_A_p0_3_tools.md) — Tool catalog | 7 (PR-A.3.1 ~ A.3.7) | — | 7 |
| A.4 | [`cycle_A_p0_4_cron.md`](cycle_A_p0_4_cron.md) — Cron | 3 (PR-A.4.1 ~ A.4.3) | — | 3 |
| A.5 | (cycle_A_p0_1_tasks.md 의 후반) — Geny 의 Tasks 적응 | — | 5 (PR-A.5.1 ~ A.5.5) | 5 |
| A.6 | (cycle_A_p0_2_slash.md 의 후반) — Geny 의 Slash 적응 | — | 2 (PR-A.6.1 ~ A.6.2) | 2 |
| A.7 | (cycle_A_p0_3_tools.md 의 후반) — Geny 의 Tool config 주입 | — | 2 (PR-A.7.1 ~ A.7.2) | 2 |
| A.8 | (cycle_A_p0_4_cron.md 의 후반) — Geny 의 Cron 적응 | — | 3 (PR-A.8.1 ~ A.8.3) | 3 |
| **합계** | | **19** | **12** | **31** |

> Plan 파일은 묶음별 1개 (executor + Geny 양쪽 모두 포함).

---

## DAG (의존성 그래프)

### Executor (1.1.0 release 까지)

```
                         ┌─ PR-A.1.1 (AgentTool built-in)
                         │
                         ├─ PR-A.1.2 (TaskRegistryStore ABC + in-memory)
                         │       │
                         │       └─ PR-A.1.3 (file-backed TaskRegistryStore)
                         │
[Stage 12+13 already] ───┤
                         ├─ PR-A.1.4 (TaskRunner + lifecycle hook)
                         │       │
                         │       └─ PR-A.1.5 (6 task tools: Create/Get/List/Update/Output/Stop)
                         │
                         ├─ PR-A.2.1 (SlashCommandRegistry + parser + types)
                         │       │
                         │       ├─ PR-A.2.2 (6 introspection commands: cost/clear/status/help/memory/context)
                         │       └─ PR-A.2.3 (6 control commands: tasks/cancel/compact/config/model/preset-info)
                         │       │
                         │       └─ PR-A.2.4 (project/user discovery path API)
                         │
                         ├─ PR-A.3.1 (AskUserQuestionTool, HITL slot 활용)
                         ├─ PR-A.3.2 (PushNotificationTool + notifications section schema)
                         ├─ PR-A.3.3 (MCP wrapper 4종 — MCPTool/ListMcpResources/ReadMcpResource/McpAuth)
                         ├─ PR-A.3.4 (Worktree 2 tool: Enter/Exit)
                         ├─ PR-A.3.5 (LSP/REPL/Brief 3 tool)
                         ├─ PR-A.3.6 (Config/Monitor/SendUserFile 3 tool)
                         └─ PR-A.3.7 (SendMessageTool ABC + reference channel)
                         │
                         ├─ PR-A.4.1 (CronJobStore ABC + in-memory + file-backed)
                         │       │
                         │       └─ PR-A.4.2 (3 cron tools: CronCreate/Delete/List)
                         │       │
                         │       └─ PR-A.4.3 (Cron daemon + lifecycle hook, P0.1 의 TaskRunner 통합)

→ release 1.1.0 (CHANGELOG.md 작성, version bump, tag push)
```

**병렬 실행 가능 묶음:**
- A.1 / A.2 / A.3 / A.4 모두 **상호 독립** (단 A.4 의 PR-A.4.3 은 A.1 의 PR-A.1.4 의 TaskRunner 패턴 재사용 → A.1 먼저 권장).
- 각 묶음 내부는 위 DAG 의 의존 순서.

**총 머지 시점**: 19 PR 모두 머지 → CHANGELOG.md unreleased → 1.1.0 → tag push.

### Geny (1.1.0 채택 후)

```
[chore(deps): bump geny-executor 1.0.x → 1.1.0]   ← 이 PR 머지 후 아래 가능

                         ├─ PR-A.5.1 (SubagentTypeRegistry seed: worker/researcher/vtuber-narrator)
                         │
                         ├─ PR-A.5.2 (Postgres TaskRegistryStore)
                         │       │
                         │       └─ PR-A.5.3 (FastAPI lifespan: TaskRunner + register_task_store)
                         │
                         ├─ PR-A.5.4 (/api/agents/{id}/tasks endpoint × 5)
                         │       │
                         │       └─ PR-A.5.5 (TasksTab.tsx)
                         │
                         ├─ PR-A.6.1 (SlashCommandRegistry register: /preset, /skill-id)
                         │       │
                         │       └─ PR-A.6.2 (/api/slash-commands endpoint + CommandTab.tsx 자동완성)
                         │
                         ├─ PR-A.7.1 (notifications.endpoints settings 주입)
                         ├─ PR-A.7.2 (SendMessage channel impl: 기존 send_dm 통합)
                         │
                         ├─ PR-A.8.1 (Postgres CronJobStore)
                         │       │
                         │       └─ PR-A.8.2 (FastAPI lifespan: Cron daemon + register_cron_store)
                         │
                         └─ PR-A.8.3 (/api/cron/jobs endpoint + CronTab.tsx)
```

**병렬 실행 가능 묶음:**
- A.5 / A.6 / A.7 / A.8 모두 **상호 독립**. 단 A.7 의 PR-A.7.1 (notifications) 은 P1.3 settings.json 이전이라 임시 yaml/env 로 inject (P1.3 머지 후 settings 화).

---

## Cross-repo 순서

```
1. Executor 19 PR 머지
2. CHANGELOG / version bump / git tag (1.1.0)
3. internal package release
4. Geny chore(deps) PR (pyproject)
5. Geny 12 PR 진행
6. Geny 운영 배포 (docker compose)
7. Cycle A 종료 → Cycle B 또는 Cycle C audit
```

---

## Acceptance criteria (Cycle A 전체)

- [ ] Executor 1.1.0 release tag 존재
- [ ] Executor 의 19 PR 모두 머지 + CHANGELOG entry
- [ ] Executor 의 새 module (tools / slash_commands / cron / runtime/task_runner) 모두 line coverage ≥ 90%
- [ ] Geny 의 12 PR 모두 머지
- [ ] Geny 의 새 endpoint (5 tasks + 4 cron + 1 slash-commands list) 모두 auth required
- [ ] Geny 의 새 tab 3종 (TasksTab / CronTab / CommandTab 자동완성) 운영 환경에서 manual smoke OK
- [ ] 기존 21-stage worker_adaptive / vtuber preset **0 회귀**
- [ ] settings.json 미적용이지만 새 settings section (notifications) 의 임시 yaml / env wiring 정상 동작
- [ ] [`cycle_C_audit.md`](cycle_C_audit.md) 의 audit checklist 1차 통과

---

## Change log (실행 중 갱신)

(아직 시작 전)

---

## 다음 문서

- [`cycle_A_p0_1_tasks.md`](cycle_A_p0_1_tasks.md) — 첫 묶음 (Task lifecycle 10 PR) 시작점
