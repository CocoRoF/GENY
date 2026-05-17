# PR D1 — refactor(s12_agent): SubagentTypeDescriptor + SubAgentBuildContext + parameterized PipelineFactory

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/d1-subagent-descriptor` (deleted) |
| Base SHA | `20ca976` |
| PR # | [#199](https://github.com/CocoRoF/geny-executor/pull/199) |
| Merge SHA | `d592273` |
| Status | **merged** |

## 변경

- `SubagentTypeDescriptor` 4 신규 필드: `provider`, `provider_credentials_extras`, `parallel`, `max_concurrent`.
- `SubAgentBuildContext` (NEW, frozen) — parent/sub session ids + credentials + descriptor + workspace_snapshot + parent_state_shared.
- `PipelineFactory` 시그니처: `Callable[[], Any]` → `Callable[[SubAgentBuildContext], Pipeline | Awaitable[Pipeline]]`.
- `_resolve_pipeline(factory, ctx)` — ctx-arg 호출 + TypeError fallback (zero-arg 레거시).
- `SubagentTypeOrchestrator._dispatch_one`이 ctx 빌드 + 메타데이터 노출.
- 9 신규 케이스.

## 검증

3214 passed.
