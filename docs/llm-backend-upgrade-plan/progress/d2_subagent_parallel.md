# PR D2 — feat(s12_agent): parallel orchestrator with bounded semaphore

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/d2-subagent-parallel` (deleted) |
| Base SHA | `d592273` |
| PR # | [#200](https://github.com/CocoRoF/geny-executor/pull/200) |
| Merge SHA | `85b226d` |
| Status | **merged** |

## 변경

- `SubagentTypeOrchestrator.orchestrate` 두-패스:
  - serial 그룹 (descriptor.parallel=False) — 입력 순서 보존
  - parallel 그룹 — `asyncio.gather` + Semaphore(`min(max_concurrent)`)
- 실패 격리 보존.
- 7 신규 케이스 (wall-time / cap / mixed-cap / 순서 / 격리 / 빈 리스트 / pure-serial).

## 검증

3221 passed.
