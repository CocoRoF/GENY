# PR E1 — feat(settings): multi-provider API keys + CLI backend configs + Bundle/Registry builders

| 항목 | 값 |
|---|---|
| Repo | `Geny` |
| Branch | `feat/llm-backend/e1-settings-credentials` (deleted) |
| Base SHA | `10e01d5` |
| PR # | [#774](https://github.com/CocoRoF/Geny/pull/774) |
| Merge SHA | `1fcf105` |
| Status | **merged** |
| Date | 2026-05-17 |

## 변경

- `geny-executor` 의존성 `1.21.0` → `2.0.0`.
- `APIConfig`에 `openai_api_key` + `google_api_key` 추가. PROVIDER_OPTIONS에 `claude_code_cli`, `copilot_cli` 추가.
- `CLIBackendClaudeCodeConfig` + `CLIBackendCopilotConfig` 신규 (BaseConfig dataclass).
- `CredentialBundleBuilder` (`service/executor/credentials.py`) — APIConfig + CLI configs → executor의 `CredentialBundle`.
- `SubagentRegistryBuilder` (`service/agent_types/builder.py`).
- Seed descriptors: 5종 (worker / researcher / summarizer / critic / vtuber-narrator), 각각 provider 힌트.

## Smoke 검증

```
CredentialBundleBuilder.build().by_provider  # ['anthropic', 'google', 'openai', 'vllm']
SubagentRegistryBuilder.build().list_types() # ['critic', 'researcher', 'summarizer', 'vtuber-narrator', 'worker']
  critic: provider='claude_code_cli'
  researcher: provider='anthropic'
  summarizer: provider='openai'
```

## 다음 PR (E2)

- AgentSessionManager 재배선: `api_key=` 단일 채널 → `credentials=CredentialBundle`
- EnvironmentService.instantiate_pipeline 시그니처 확장
- SubagentTypeRegistry 주입
