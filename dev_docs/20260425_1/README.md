# Cycle 20260425_1 — Geny Adoption of geny-executor 1.0

**Created:** 2026-04-25
**Status:** Plan ready, awaiting approval
**Goal:** geny-executor 1.0.0 가 ship 한 capability (Phase 1·5·6·7·8 + 9c read + 10) 의 Geny host 측 adoption.

## 배경

이전 cycle (G1.x → G5.x) 가 Phase 9 (21-stage 재구성) 의 Geny 통합을 끝냈음. executor 측은 1.0.0 까지 Phase 1–9 모두 ship 됐으나, **Geny host 가 그 capability 의 27% 만 사용 중**. 본 cycle 은 잔여 28건의 unwired capability 를 흡수.

## 폴더 구조

```
20260425_1/
├── README.md                                      ← 이 파일
├── analysis/
│   ├── 01_executor_capability_inventory.md       ← executor 1.0 가 ship 한 모든 capability
│   ├── 02_geny_consumption_audit.md              ← wired/unwired 1:1 매핑
│   └── 03_gap_summary.md                         ← 우선순위 + sprint 묶음
├── plan/
│   └── cycle_plan.md                             ← 6 sub-cycle, 31 PR, 검증 매트릭스
└── progress/
    └── README.md                                  ← PR 머지마다 추가될 progress 노트의 인덱스
```

## 읽는 순서

1. `analysis/01` — executor 가 무엇을 ship 했는지 (baseline)
2. `analysis/02` — Geny 가 그 중 무엇을 쓰는지 (현 상태)
3. `analysis/03` — 잔여물의 우선순위와 의존성
4. `plan/cycle_plan.md` — 실제 실행 계획

## Cycle 요약

| Sub-cycle | 주제 | PR 수 |
|---|---|---|
| G6 | Phase 1 capability flags + permission + Phase 5 hooks | 6 |
| G7 | Phase 9c crash recovery + Phase 4 skills | 5 |
| G8 | Phase 6 MCP runtime FSM | 4 |
| G9 | Phase 7 stage strategy 흡수 (11 잔여) | 9 |
| G10 | Phase 8 OAuth + URI + bridge | 4 |
| G11 | Phase 10 Observability dashboard | 3 |
| **합계** | | **31** |

## 다음 행동

사용자 승인 후 G6.1 부터 순차 진행. 각 PR 머지 직후 `progress/<sprint>_<topic>.md` 추가, `progress/README.md` 트래킹 표 갱신.

## 관련 문서

- `Geny/executor_uplift/` — uplift 의 원본 설계 문서
- `Geny/executor_uplift/12_detailed_plan.md` — executor 측 구현 manual (Phase 1–10)
- 이전 cycle: 단일 cycle 폴더 없음 (G1–G5 는 PR description + 메모리로만 트래킹) — 본 cycle 부터 progress 폴더 표준 적용
