# Cycle B — overview (executor 1.2.0 + Geny adopt)

**Cycle ID:** new-executor-uplift / 20260427_1
**PR 수:** 19 (executor 11 + Geny 8)
**Executor minor bump:** 1.1.x → **1.2.0**
**Geny pyproject bump:** `geny-executor>=1.2.0,<1.3.0`
**Prerequisite:** Cycle A 완료 (executor 1.1.0 + Geny 채택)

---

## 본 cycle 의 목표

Cycle A 가 4 거대 격차를 해소했다면, Cycle B 는 **polish + extension 의 17 항목** 처리:

1. **C.11** — In-process hook callbacks (P1.1)
2. **T.53** — Auto-compaction trigger (P1.2)
3. **K.38 / K.39 / K.41** — Settings.json 통일 (P1.3)
4. **D.12 / D.13 / D.15** — Skill schema 풍부화 (P1.4)
5. **B.7 / B.6** — PLAN mode 확장 (acceptEdits / dontAsk + flag/policy/session source) (P1.5)
6. **A.2 의 P0.3 잔여** + Worktree/LSP 통합 깊이 (P1.6)

---

## 묶음 구성 (= plan 파일 1:1)

| 묶음 | Plan 파일 | Executor PR | Geny PR | 합계 |
|---|---|---|---|---|
| B.1 | [`cycle_B_p1_1_in_process_hooks.md`](cycle_B_p1_1_in_process_hooks.md) | 2 | 1 | 3 |
| B.2 | [`cycle_B_p1_2_auto_compaction.md`](cycle_B_p1_2_auto_compaction.md) | 1 | 0 | 1 |
| B.3 | [`cycle_B_p1_3_settings.md`](cycle_B_p1_3_settings.md) | 2 | 3 | 5 |
| B.4 | [`cycle_B_p1_4_skill_richness.md`](cycle_B_p1_4_skill_richness.md) | 3 | 1 | 4 |
| B.5 | [`cycle_B_p1_5_plan_mode.md`](cycle_B_p1_5_plan_mode.md) | 2 | 1 | 3 |
| B.6 | [`cycle_B_p1_6_worktree_lsp_depth.md`](cycle_B_p1_6_worktree_lsp_depth.md) | 1 | 2 | 3 |
| **합계** | | **11** | **8** | **19** |

---

## DAG (의존성 그래프)

### Executor (1.2.0 release 까지)

```
                         ┌─ PR-B.1.1 (HookRunner.register_in_process API)
                         │       │
                         │       └─ PR-B.1.2 (in-process handler propagation tests)
                         │
                         ├─ PR-B.2.1 (Stage 19 frequency policy: on_context_fill)
                         │
                         ├─ PR-B.3.1 (settings.json loader + section schema)
                         │       │
                         │       └─ PR-B.3.2 (register_section ABC + 5 표준 section)
                         │
                         ├─ PR-B.4.1 (SKILL.md schema 확장: category/examples/effort)
                         ├─ PR-B.4.2 (Skill execution_mode forked impl)
                         ├─ PR-B.4.3 (MCP→skill 자동 변환 loader)
                         │
                         ├─ PR-B.5.1 (PermissionMode enum 확장: acceptEdits/dontAsk)
                         │       │
                         │       └─ PR-B.5.2 (Permission rule_source ABC: flag/policy/session)
                         │
                         └─ PR-B.6.1 (SubagentTypeOrchestrator 의 worktree integration)

→ release 1.2.0 (CHANGELOG.md, version bump, tag push)
```

병렬 실행 가능:
- B.1 / B.2 / B.3 / B.4 / B.5 / B.6 모두 상호 독립
- 단 B.3 의 PR-B.3.2 는 B.3.1 후

### Geny (1.2.0 채택 후)

```
[chore(deps): bump geny-executor 1.1.x → 1.2.0]

                         ├─ PR-B.1.3 (in-process hook use case wiring: permission_logger / task_future)
                         │
                         ├─ PR-B.3.3 (settings.json migrator: 4 YAML → settings.json)
                         │       │
                         │       └─ PR-B.3.4 (기존 install.py 들 swap to loader.get_section)
                         │              │
                         │              └─ PR-B.3.5 (Geny 전용 section: preset / vtuber)
                         │
                         ├─ PR-B.4.4 (bundled skill 3종 frontmatter 갱신 + frontend 표시)
                         │
                         ├─ PR-B.5.3 (frontend: 새 PLAN mode toggle + preset default)
                         │
                         ├─ PR-B.6.2 (코드 worker preset 의 default Worktree 정책)
                         └─ PR-B.6.3 (LSP language adapter config wiring)
```

---

## Cross-repo 순서

```
1. Executor 11 PR 머지
2. 1.2.0 release tag
3. Geny chore(deps) PR
4. Geny 8 PR 진행
5. 운영 배포
6. Cycle B 완료 → Cycle C
```

---

## Acceptance criteria (Cycle B 전체)

- [ ] Executor 1.2.0 release tag 존재
- [ ] Executor 11 PR 머지 + CHANGELOG entry
- [ ] Geny 8 PR 머지
- [ ] **settings.json migration 정상 동작** (기존 4 YAML 자동 변환 + .bak)
- [ ] 기존 운영 환경 0 회귀 (worker_adaptive / vtuber 동작 동일)
- [ ] 새 PLAN mode (acceptEdits / dontAsk) frontend 에서 toggle
- [ ] Auto-compaction 자동 trigger 운영 환경에서 1회 이상 발화
- [ ] In-process hook 의 latency 감소 측정 (vs subprocess: ~10x ↓ 기대)

---

## Change log (실행 중 갱신)

(아직 시작 전)

---

## 다음 문서

- [`cycle_B_p1_1_in_process_hooks.md`](cycle_B_p1_1_in_process_hooks.md) — 첫 묶음 시작점
