# Baseline — LLM Backend Upgrade Cycle

> 사이클 시작 시점의 *완전한 상태 스냅샷*. 무엇이 잘못되어도 여기로 돌아온다.

## 작성 시점

- 날짜: 2026-05-17
- 작업자: Claude (CocoRoF account via gh CLI)
- 사용자 의도: LLM 백엔드 일반화 (Anthropic/OpenAI/Google/vLLM + Claude Code CLI + Copilot CLI) + Stage 12 multi-agent multi-provider 활성화

## Repo 1 — geny-executor

| 항목 | 값 |
|---|---|
| Path | `/home/geny-workspace/geny-executor` |
| Remote | `https://github.com/CocoRoF/geny-executor.git` |
| Branch | `main` |
| HEAD SHA | `474522a` |
| HEAD message | `feat(memory): root _index.json is a bounded folder-tree summary (1.21.0) (#190)` |
| pyproject version | `1.21.0` |
| Working tree | clean |

마지막 3 커밋:
```
474522a feat(memory): root _index.json is a bounded folder-tree summary (1.21.0) (#190)
ae36110 feat(memory): provider-driven Stage 2 / Stage 18 / index plane (1.20.0) (#189)
ffe54f1 feat(memory): cross-loop safe locks + consolidated install (1.19.0) (#188)
```

## Repo 2 — Geny

| 항목 | 값 |
|---|---|
| Path | `/home/geny-workspace/Geny` |
| Remote | `https://github.com/CocoRoF/Geny.git` |
| Branch | `main` |
| HEAD SHA | `f81637a` |
| HEAD message | `Merge pull request #772 from CocoRoF/feat/vtuber-screen-observation-skill` |
| Working tree | 사용자 미커밋 변경 존재 (별도 작업, 본 사이클이 건드리지 않음) |

### 사용자 미커밋 변경 (참고만 — 본 사이클 건드리지 않음)

```
 D docs/plan/BLOG_AGENT_INTEGRATION.md
 D docs/plan/GENY_AVATAR_INTEGRATION.md
 D docs/plan/MEMORY_EXECUTOR_OWNED_PLAN.md
 D docs/plan/MEMORY_THIN_ADAPTER_PLAN.md
 D docs/plan/P0_FIX_HOOK_AND_ATTACH_REGRESSION.md
 D docs/plan/P1_OPERATOR_VALIDATION_CHECKLIST.md
 D docs/plan/P2_INDEX_HIERARCHY_AND_SIDEBAR.md
 D docs/plan/P3_PROMPT_LOGGING_AND_LOG_FORWARDING.md
 D docs/progress/GENY_AVATAR_INTEGRATION_PROGRESS.md
 D docs/progress/MEMORY_EXECUTOR_OWNED_PROGRESS.md
 D docs/progress/MEMORY_REFACTOR_AUDIT_REPORT.md
 M vendor/geny-avatar
?? docs/llm-backend-upgrade-plan/
```

본 사이클의 PR들은 위 변경과 무관하게 `docs/llm-backend-upgrade-plan/`만 staged하여 commit.

## gh CLI auth

| 항목 | 값 |
|---|---|
| Host | github.com |
| Account | CocoRoF |
| Scopes | gist, read:org, repo |
| 권한 | repo push, PR create/merge 가능 |

## Branch 명명 규칙

```
feat/llm-backend/<phase>-<short-name>
```

예시:
- `feat/llm-backend/a1-capabilities-types-errors`
- `feat/llm-backend/d3-pipeline-subagent`

본 사이클의 PR 외 다른 branch는 건드리지 않음.

## Merge 정책

- Squash merge (단일 클린 커밋 보장).
- PR description에 progress 파일 링크.
- merge 후 본 README의 해당 row에 merge SHA 기록.
- merge 후 즉시 main pull → 다음 PR base 잡음.

## 위험 작업 — 사용자 명시 승인 필요

다음은 본 사이클 진행 중 절대 자동 실행하지 않음. 사용자가 명시적으로 시킬 때만:

- `git push --force` / `--force-with-lease`
- `git reset --hard` on main
- `git branch -D main`
- 본 baseline에 있는 SHA 미만으로 rewind
- PyPI publish (Phase D 종료 후 별도 확인)
- Geny default manifest 적용을 위한 prod DB reseed (Phase E5)

## 사이클 종료 조건

[07_rollout_phases.md "Done" 조건](../07_rollout_phases.md#done-조건) 10항 충족 + 본 progress의 모든 row가 `merged` 상태.
