# Plan — new-executor-uplift 의 step-by-step 실행 계획

**Date:** 2026-04-25
**Status:** Plan only — execution pending caller approval
**Source axiom:** [`../00_layering_principle.md`](../00_layering_principle.md)
**Source priority:** [`../03_priority_buckets.md`](../03_priority_buckets.md)
**Source design:** [`../04_design_sketches.md`](../04_design_sketches.md)

본 plan 은 위 분석 3 종을 **PR 단위 실행 가능한 step** 으로 분해. 각 PR 은 단일 sprint = 단일 PR 패턴. 모든 file path / ABC signature / test name / 의존성 / migration / risk + mitigation 을 명시.

---

## 폴더 구조

```
plan/
├── index.md                              ← 이 파일
├── 00_conventions.md                     ← branch / commit / PR / test / 호환성 규칙
│
├── cycle_A_overview.md                   ← Cycle A (executor 1.1 + Geny adopt) 흐름 + DAG
├── cycle_A_p0_1_tasks.md                 ← P0.1 Task lifecycle 의 10 PR
├── cycle_A_p0_2_slash.md                 ← P0.2 Slash commands 의 6 PR
├── cycle_A_p0_3_tools.md                 ← P0.3 Tool catalog 의 9 PR
├── cycle_A_p0_4_cron.md                  ← P0.4 Cron 의 6 PR
│
├── cycle_B_overview.md                   ← Cycle B (executor 1.2 + Geny adopt) 흐름 + DAG
├── cycle_B_p1_1_in_process_hooks.md      ← P1.1 의 3 PR
├── cycle_B_p1_2_auto_compaction.md       ← P1.2 의 1 PR
├── cycle_B_p1_3_settings.md              ← P1.3 의 5 PR
├── cycle_B_p1_4_skill_richness.md        ← P1.4 의 4 PR
├── cycle_B_p1_5_plan_mode.md             ← P1.5 의 3 PR
├── cycle_B_p1_6_worktree_lsp_depth.md    ← P1.6 의 3 PR
│
└── cycle_C_audit.md                      ← Cycle A + B 의 audit cycle
```

---

## 전체 PR 분포

| Cycle | Repo | PR 수 | 핵심 |
|---|---|---|---|
| A | geny-executor (→ 1.1.0) | 19 | Task lifecycle / Slash commands / Tool catalog / Cron — 모두 EXEC-CORE |
| A | Geny (1.1 채택 후) | 12 | SubagentTypeRegistry seed / REST 어댑터 / Frontend tabs / Postgres backend |
| B | geny-executor (→ 1.2.0) | 11 | In-process hooks / Auto-compaction / settings.json / Skill schema / PLAN mode / Worktree-LSP depth |
| B | Geny (1.2 채택 후) | 8 | Migrator / Geny 전용 section / 새 mode UI |
| C | 양 repo audit | ~7 | 새 surface 의 테스트 / docstring / API doc + 운영 데이터 결함 fix |
| **총합** | | **~57** | |

---

## Cycle DAG (high-level)

```
Cycle A
  geny-executor 1.1.x bump (19 PR)
    A.exec.1: Task system (PR-A.1.1 ~ A.1.5)
    A.exec.2: Slash commands (PR-A.2.1 ~ A.2.4)
    A.exec.3: Tool catalog (PR-A.3.1 ~ A.3.7)
    A.exec.4: Cron (PR-A.4.1 ~ A.4.3)
  → release 1.1.0
  Geny pyproject 1.1.x bump + 12 PR
    A.geny.1: Tasks (PR-A.5.1 ~ A.5.5)
    A.geny.2: Slash (PR-A.6.1 ~ A.6.2)
    A.geny.3: Tool config (PR-A.7.1 ~ A.7.2)
    A.geny.4: Cron (PR-A.8.1 ~ A.8.3)

Cycle B (동일 패턴, 1.2 minor)

Cycle C: 양 repo audit
```

상세 DAG (PR 간 의존성 + 동시 실행 가능 묶음) 은 각 cycle overview 참조.

---

## PR ID 명명 규칙

- **PR-A.1.1**: Cycle A / 묶음 1 (P0.1 Task) / 묶음 내 첫 번째 PR
- **PR-A.5.3**: Cycle A / 묶음 5 (Geny 의 Tasks 적응) / 세 번째 PR
- **PR-B.3.2**: Cycle B / 묶음 3 (P1.3 settings) / 두 번째 PR
- **PR-C.1**: Cycle C audit / 첫 번째 PR

각 PR 의 git 브랜치 / 커밋 메시지 양식은 [`00_conventions.md`](00_conventions.md) 참조.

---

## 본 plan 사용법

### 실행자가 cycle 시작 시

1. [`00_conventions.md`](00_conventions.md) 한 번 통독 — branch / commit / PR template / test 컨벤션 동의.
2. 시작할 cycle 의 overview 통독 (예: [`cycle_A_overview.md`](cycle_A_overview.md)) — 묶음 / DAG / 의존성 / cross-repo 순서 확인.
3. 첫 묶음의 plan 파일 (예: [`cycle_A_p0_1_tasks.md`](cycle_A_p0_1_tasks.md)) 펼쳐서 PR-A.1.1 부터 순서대로.
4. 각 PR 의 acceptance criteria 통과해야 다음 PR 진행.
5. 묶음 완료 시 cycle overview 의 progress 표 업데이트 (체크박스).
6. 모든 묶음 완료 후 cycle 종료 → 다음 cycle 의 overview 로.

### 본 plan 의 변경

- 실행 중 새 의존성 / 기술적 제약 발견 시 **plan 파일을 직접 수정** (memory 가 아닌 docs).
- 큰 scope 변경 시 cycle overview 의 "Change log" 섹션에 한 줄 추가.

---

## 다음 문서

- [`00_conventions.md`](00_conventions.md) — 실행 컨벤션
- [`cycle_A_overview.md`](cycle_A_overview.md) — 첫 cycle 시작점
