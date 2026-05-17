# PR E2 — refactor(executor): AgentSessionManager + EnvironmentService consume CredentialBundle

| 항목 | 값 |
|---|---|
| Repo | `Geny` |
| Branch | `feat/llm-backend/e2-session-manager` (deleted) |
| Base SHA | `1fcf105` |
| PR # | [#775](https://github.com/CocoRoF/Geny/pull/775) |
| Merge SHA | `27dc25b` |
| Status | **merged** |

## 변경

- `AgentSessionManager.create_agent_session` → `CredentialBundleBuilder().build()` + `SubagentRegistryBuilder().build()`.
- `_extract_primary_provider(env_id)`: stages[6].config["provider"] (1순위) → strategies["provider"] (fallback).
- 자격증명 누락 시 한국어 메시지로 fail-fast.
- `EnvironmentService.instantiate_pipeline`에 `credentials=`, `subagent_registry=` kwarg 추가.
- legacy ANTHROPIC_API_KEY hard requirement 제거.
