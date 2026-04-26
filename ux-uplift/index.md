# ux-uplift — Geny UI/UX + 데이터 편집성 심층 분석

**Date:** 2026-04-26
**Status:** Analysis only — no plan / no PRs (caller decides scope)
**Trigger:** cycle A+B+C+D (`new-executor-uplift/`) 가 60+ PR 로 backend 표면을 크게 늘렸지만, *사용자가 그 표면을 보고 / 편집하고 / 적용*할 수 있는 UI 갭이 큼. 1순위 사례: executor 의 33개 built-in tool — **사용자는 자신이 어떤 도구를 가진지 볼 화면이 없고, preset 별로 어떤 도구가 enable 됐는지도 못 본다**.

본 폴더는 그 갭의 전체를 매핑하고, 우선순위로 묶고, 상위 항목의 설계 초안을 적는다. 이전 `new-executor-uplift/` 가 *capability* 갭이었다면 본 폴더는 *visibility / editability / applicability* 갭.

---

## 폴더 구조

```
ux-uplift/
├── index.md                              ← 이 파일
├── 00_methodology.md                     ← 어떻게 갭을 식별했는지
├── 01_capability_visibility_matrix.md    ← 모든 backend capability ↔ UI 노출 매트릭스
├── 02_gap_built_in_tools.md              ← Deep dive #1: built-in tool 카탈로그
├── 03_gap_settings_editing.md            ← Deep dive #2: settings / permissions / hooks
├── 04_gap_session_data.md                ← Deep dive #3: skill / task / cron / memory 편집
├── 05_gap_observability.md               ← Deep dive #4: workspace / events / admin viewer
├── 06_priority_buckets.md                ← P0/P1/P2 우선순위
└── 07_design_sketches.md                 ← Top 5 우선순위의 UX 디자인 초안
```

---

## 한 눈에 보는 결과

### 발견된 UX 갭 (요약)

| # | 갭 | 영향 |
|---|---|---|
| 1 | **Built-in tool 카탈로그 viewer 없음** — 사용자는 33 도구 중 무엇이 활성화됐는지 모름 | HIGH |
| 2 | **Built-in tool 개별 활성화 불가** — preset 단위로 `["*"]` or `[]` hardcoded | HIGH |
| 3 | **Permission rules 편집기 없음** — `/api/permissions/list` GET만, 추가/수정/삭제 불가 | HIGH |
| 4 | **Hooks 편집기 없음** — `/api/hooks/list` GET만, env opt-in + yaml 수동 편집만 | HIGH |
| 5 | **Settings.json framework section 편집기 없음** — Geny preset/vtuber만 있고 permissions/hooks/skills/model/telemetry 무시 | MED |
| 6 | **PermissionsConfig (PR-D.3.4) UI 안 보임** — config 등록은 됐지만 SettingsTab 카테고리에서 노출 검증 안 됨 | MED |
| 7 | **Skill 편집기 없음** — `/api/skills/list` GET만, SkillPanel 은 read-only chip | MED |
| 8 | **Task / Cron payload schema dynamic 노출 부재** — CronTab Add Job 모달은 raw JSON textarea | MED |
| 9 | **Subagent type 카탈로그 viewer 없음** — worker / researcher / vtuber-narrator 3종 등록만, 사용자는 무엇이 가능한지 모름 | MED |
| 10 | **Workspace state viewer 없음** — workspace_stack 시드만, 현재 worktree / branch 표시 안 됨 | LOW |
| 11 | **MCP OAuth flow UI 미통합** — endpoint 있지만 사용자 flow 없음 | MED |
| 12 | **Recent tool events ring buffer 미노출** — PR-B.1.3 ring buffer 있지만 보일 endpoint 없음 | LOW |
| 13 | **Notification endpoints 편집기 없음** — yaml/env 수동 등록만 | LOW |
| 14 | **SendMessageChannel 활성 목록 viewer 없음** | LOW |
| 15 | **In-process hook handler 등록/조회 UI 없음** | LOW |

→ HIGH 4건 + MED 6건 + LOW 5건 = **15 갭**

### 거시 진단

**현 상태:** Geny backend 가 cycle A+B+D 동안 *capability rich* 해졌으나 frontend / REST 가 그 capability 의 *visibility* 를 반영하지 못함. 사용자는:

- 어떤 도구를 자신이 갖고 있는지 모름 (built-in 33 + custom + MCP)
- 어떤 권한 규칙이 활성인지 / 어떻게 바꿀지 모름
- 어떤 hook 이 fire 하는지 모름
- 어떤 subagent 를 spawn 할 수 있는지 모름
- 자신의 session 이 현재 어떤 workspace 에 있는지 모름

이 모든 정보가 *backend 에 있는데* UI 에 안 흐름.

**가장 큰 병목:** "보기" 가 빠진 것 (visibility) ≫ "편집" 이 빠진 것 (editability). 보이지 않는 데이터는 편집할 수도 없다 — 우선순위는 "viewer 먼저, editor 그 다음".

---

## 다음 cycle 권장 순서

[`06_priority_buckets.md`](06_priority_buckets.md) 의 P0 묶음 (HIGH 4건) 을 한 cycle 에 묶어 처리. 그 후 P1 (MED 6건), P2 (LOW 5건). 상세는 [`07_design_sketches.md`](07_design_sketches.md).

---

## 본 분석의 명시적 carve-out

본 분석이 *덮지 않는* 영역:
- 디자인 시스템 / 색상 / 타이포그래피 같은 *visual* 디자인 — 별도 디자인 cycle
- 모바일 반응형 — 기존 isMobile 스위치 외 검토 안 함
- i18n 추가 — 한국어/영어 외 추가 안 함
- 접근성 (a11y) — 별도 audit cycle

본 분석은 **"backend 가 노출하는 것을 사용자가 볼 / 편집할 수 있는가"** 한 차원에 집중.

---

## 다음 문서

- [`00_methodology.md`](00_methodology.md) — 갭 식별 방법론
- [`01_capability_visibility_matrix.md`](01_capability_visibility_matrix.md) — 전체 매트릭스
