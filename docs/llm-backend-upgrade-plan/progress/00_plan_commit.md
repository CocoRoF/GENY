# PR #0 — docs: add LLM backend upgrade plan

> Geny 측 plan + progress baseline을 main에 커밋.

## 메타데이터

| 항목 | 값 |
|---|---|
| Repo | `Geny` |
| Branch | `docs/llm-backend-upgrade-plan` (deleted after merge) |
| Base SHA | `f81637a` |
| PR # | https://github.com/CocoRoF/Geny/pull/773 |
| Merge SHA | `d67d09c` |
| Status | **merged** |
| Date opened | 2026-05-17 |
| Date merged | 2026-05-17 |

## 목적

`docs/llm-backend-upgrade-plan/` (11개 plan markdown + progress 폴더 시드) 를 Geny `main`에 commit. 본 사이클 모든 작업의 *referenceable plan*을 제공.

## 포함 변경

```
A docs/llm-backend-upgrade-plan/README.md
A docs/llm-backend-upgrade-plan/00_overview.md
A docs/llm-backend-upgrade-plan/01_current_state.md
A docs/llm-backend-upgrade-plan/02_target_architecture.md
A docs/llm-backend-upgrade-plan/03_executor_changes.md
A docs/llm-backend-upgrade-plan/04_geny_changes.md
A docs/llm-backend-upgrade-plan/05_sub_agent_system.md
A docs/llm-backend-upgrade-plan/06_stage_compatibility.md
A docs/llm-backend-upgrade-plan/07_rollout_phases.md
A docs/llm-backend-upgrade-plan/08_testing_strategy.md
A docs/llm-backend-upgrade-plan/09_open_questions.md
A docs/llm-backend-upgrade-plan/progress/README.md
A docs/llm-backend-upgrade-plan/progress/baseline.md
A docs/llm-backend-upgrade-plan/progress/00_plan_commit.md
```

사용자의 별도 미커밋 변경 (vendor/geny-avatar, docs/plan/*, docs/progress/*) 은 **건드리지 않음** — 본 PR은 신규 폴더 add만.

## Acceptance

- [ ] `git diff main..docs/llm-backend-upgrade-plan -- docs/llm-backend-upgrade-plan/` 가 14개 파일 add만 보여줌
- [ ] PR 본문에 본 progress 파일 링크
- [ ] Merge 후 main에서 `ls docs/llm-backend-upgrade-plan/` 11 docs + progress/ 폴더 확인

## Rollback

머지 후 문제 시:
```bash
git revert <merge_sha> --no-edit
git push origin main
```

플랜 문서만 추가하므로 revert는 단순. 본 PR이 다음 PR들의 의존성이 아님 (executor 작업이 먼저 진행 가능, 다만 progress 추적이 끊김).

## Implementation log

| Step | Action | SHA | Notes |
|---|---|---|---|
| 1 | branch 생성 | — | `docs/llm-backend-upgrade-plan` from `f81637a` |
| 2 | files staged | — | 14 files in `docs/llm-backend-upgrade-plan/` only |
| 3 | commit | `4ccb815` | `docs: add LLM backend upgrade plan` |
| 4 | push origin | — | branch pushed |
| 5 | PR open | #773 | https://github.com/CocoRoF/Geny/pull/773 |
| 6 | merge | `d67d09c` | squash; branch auto-deleted |
| 7 | main pull | — | up to date with origin/main at `d67d09c` |

## Result

Plan docs live at `docs/llm-backend-upgrade-plan/` on Geny `main`. All subsequent
PRs in this cycle will reference this plan and append their progress files here.
