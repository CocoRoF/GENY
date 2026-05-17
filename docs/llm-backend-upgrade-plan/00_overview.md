# 00 · Overview

## 1. Vision

`geny-executor`는 **LLM 실행을 일반화하는 framework**고, Geny는 그것을 *사용하는* 서비스다. 현재 framework는 4 vendor API만 LLM 백엔드로 인식하지만, 실제 LLM 실행 경로는 훨씬 다양하다 — 직접 API 호출, OpenAI-compat REST (vLLM), 그리고 **subscription 인증을 가지는 CLI 도구** (Claude Code, GitHub Copilot).

본 사이클은 이 모두를 **하나의 `BaseClient` 계약**과 **하나의 `CredentialBundle` 자격증명 전달 경로**로 통합한다. 그리고 동시에 **Stage 12 multi-agent system**이 backend 종류와 무관하게 sub-agent별 다른 provider를 사용할 수 있게 한다.

## 2. Scope

### In-scope (전부 프로덕션 품질)

| 항목 | 위치 |
|---|---|
| `ClientCapabilities` 9개 필드 추가 (structured_output, session_continuity, mcp_passthrough, budget_limit, cost_usage, supports_token_usage, is_subprocess, requires_workspace, streaming_granularity) | executor |
| `APIRequest.response_format` + `APIRequest.session_hint` 추가 | executor |
| `TokenUsage.cost_usd` + `duration_ms` 추가 | executor |
| 신규 에러 카테고리 5종 (CLI_NOT_FOUND, CLI_AUTH_FAILED, CLI_TIMEOUT, CLI_PROTOCOL_ERROR, CLI_PERMISSION_DENIED) | executor |
| 공용 `_cli_runtime.py` (subprocess primitives, stream-json 파서, env scrub, kill-tree) | executor |
| `ClaudeCodeCLIClient` (stream-json bidirectional) | executor |
| `CopilotCLIClient` (plain stdout) | executor |
| `ProviderCredentials` + `CredentialBundle` (자격증명 단일 전달 경로) | executor |
| Provider 저장 위치 통일 (`config["provider"]`만 사용, `strategies["provider"]` 제거) | executor + Geny |
| `SubagentTypeDescriptor`에 `provider` + `provider_credentials_extras` 추가 | executor |
| `PipelineFactory` 시그니처를 `Callable[[SubAgentBuildContext], Pipeline]`로 일반화 | executor |
| `SubagentTypeOrchestrator` 병렬 spawn (`descriptor.parallel=True` 시 asyncio.gather) | executor |
| Fork-mode skill을 `CredentialBundle` 기반으로 재배선 (`ANTHROPIC_API_KEY` hardcoded 제거) | executor |
| Per-stage `provider_override` + `model_override` (executor에선 model_override 이미 동작) | executor + Geny |
| Settings sections: `cli_backends.claude_code`, `cli_backends.copilot`, `api.{openai,google}_api_key` | Geny |
| `CredentialBundleBuilder` (settings → bundle) | Geny |
| `AgentSessionManager` 재배선 (provider 라우팅 + 자격증명 주입) | Geny |
| 새 default manifest (`config["provider"]` 기반, sub-agent orchestrator 활성화) | Geny |
| Geny sub-agent factory들의 실구현 (placeholder 제거) | Geny |
| Health check endpoint `/api/health/llm_backends` | Geny |
| Frontend provider 카탈로그 6개 확장 | Geny |
| Per-stage `model_override` + `provider_override` UI | Geny |
| CLI 백엔드 설정 카드 (`CLIBackendSettings.tsx`) | Geny |
| Sub-agent 카탈로그 UI (descriptor 편집 + provider 선택) | Geny |
| Conformance harness — 6 backend 동일 32+ 케이스 통과 | executor |
| Sub-agent conformance — multi-provider sub-agent 통과 | executor |

### Out-of-scope

- 새 vendor API (Mistral, Cohere) — 같은 패턴으로 후속 사이클.
- CLI daemon-mode (long-running subprocess + bidirectional stream-json) — 후속 사이클.
- 21-stage 자체 구조 리팩토링.
- Browser-use / computer-use 모달리티.
- 가격/billing 통합.

## 3. Non-goals

- **CLI 도구 번들링하지 않음.** 사용자가 시스템에 설치 (`which claude`, `which gh`). Geny는 경로 감지/health check만.
- **CLI 도구 내부 mocking 안 함.** prod path는 진짜 subprocess. 테스트는 fake binary fixture.
- **back-compat 안 함.** 본 사이클은 *fresh schema*. 옛 호출자 / 옛 manifest와의 양립을 위한 코드는 안 짠다.

## 4. Success criteria

1. ✅ `ClientRegistry.available()`이 6개 반환: `anthropic, openai, google, vllm, claude_code_cli, copilot_cli`.
2. ✅ 6 backend 모두가 conformance harness 통과 (capability-aware skip).
3. ✅ `manifest.stages[N].config["provider"]` 단일 위치로 통일 — `strategies["provider"]` 코드 전체에서 제거.
4. ✅ Geny가 `CredentialBundle` 하나만 executor에 넘김. `api_key` 단일 인자 경로 사라짐.
5. ✅ Stage 12 SubagentTypeOrchestrator가 default로 활성화되고, descriptor의 `provider` 필드대로 다른 LLM backend를 spawn.
6. ✅ Geny에서 4 종류 sub-agent factory 실구현 (`worker`, `researcher`, `summarizer`, `critic` 또는 final 셋) — 각 factory가 자기 manifest + provider 가짐.
7. ✅ Fork-mode skill이 `provider` 메타데이터를 보고 그에 맞는 client로 호출 — Anthropic 외 backend로도 fork 가능.
8. ✅ Geny `settings.json`에서 6 provider 모두 설정 가능, CLI 백엔드 경로/auth UX가 명확.
9. ✅ Frontend `GlobalSettingsView`가 6 provider 노출, 모든 stage에 `model_override` + `provider_override` UI 노출.
10. ✅ 신규 sub-agent 카탈로그 UI에서 sub-agent 추가/편집 + 각 sub-agent에 provider 선택 가능.
11. ✅ `/api/health/llm_backends`가 6 backend 상태 보고.
12. ✅ Stage 6 streaming이 6 backend 모두에서 검증됨 (capability=False면 fallback 표시).
13. ✅ Per-stage `provider_override` 사용 시 Stage 2 (context), 11 (tool_review), 14 (evaluate), 18 (memory reflection), 19 (summarize)에서 다른 provider 작동.
14. ✅ 21-stage 전체 회귀 0건 (conformance + integration test).

## 5. Guiding principles

### P1. Framework holds the abstraction; service holds the policy.
`BaseClient`는 "어떻게 LLM을 호출하는가"만 안다. "**언제** CLI를 쓰는가" "**무슨** API key를 가져오는가"는 Geny 책임.

### P2. Capability-first, not provider-first.
Stage / sub-agent orchestrator는 `client.capabilities.*`만 본다. provider 이름으로 분기하지 않는다.

### P3. CLI는 vendor SDK와 동등 시민.
`ClaudeCodeCLIClient`도 `BaseClient`를 상속, 동일한 `APIRequest`/`APIResponse`. 차이는 `_send()` 안에서 SDK 대신 subprocess.

### P4. No silent capability skip.
미지원 기능 요청 시 `llm_client.feature_unsupported` 이벤트 emit. 호출자가 결정.

### P5. Single source of truth.
- Provider 위치: `manifest.stages[N].config["provider"]` 하나뿐.
- 자격증명: `CredentialBundle` 하나뿐.
- Sub-agent registry: `SubagentTypeRegistry` 하나뿐. placeholder factory는 존재하지 않는다.

### P6. Credentials never leave Geny except into executor's runtime.
`api_key` / CLI auth는 `CredentialBundle` 한 번 흐르고 executor 내부에서만 산다. 로그/메모리 dump/event_sink에 누출 금지.

### P7. CLI auth는 외부 시스템 신뢰.
`claude` CLI는 `~/.claude/` 자체 state. `gh copilot`은 `~/.config/gh/`. Geny는 경로 지정 + env override만, 인증 흐름 흉내 X.

### P8. Sub-agent는 자기 manifest + 자기 client.
sub-pipeline의 `state.llm_client`는 sub-pipeline의 자기 stage 6 provider로 *새로* resolve된다. parent client 상속 안 함. descriptor에 명시된 provider override가 sub-pipeline의 stage 6 provider를 결정.

## 6. Strategic ordering (6 phases)

자세한 PR mapping은 [07_rollout_phases.md](./07_rollout_phases.md).

- **Phase A — Foundation** (executor) · capabilities + types + errors + `_cli_runtime` + `credentials` + provider unification primitives + conformance harness 골격.
- **Phase B — Claude Code CLI** (executor) · `ClaudeCodeCLIClient` + 단독 conformance.
- **Phase C — Copilot CLI** (executor) · `CopilotCLIClient` + 단독 conformance.
- **Phase D — Sub-agent multi-provider** (executor) · descriptor 확장 + factory 재설계 + orchestrator 병렬 옵션 + fork-mode skill 재배선 + sub-agent conformance.
- **Phase E — Geny wiring** (Geny) · settings + CredentialBundle builder + `AgentSessionManager` + default manifest 재작성 + sub-agent factory 실구현 + health check.
- **Phase F — Frontend + polish** (Geny) · provider 카탈로그 + per-stage override UI + sub-agent 카탈로그 UI + e2e + 문서.

각 phase 종료 후에 머지 가능해야 함. 그러나 *부분 phase 머지 후 시스템이 작동해야 한다는 제약은 없음* — back-compat 안 하므로 phase 전체가 묶여서 다음 phase의 baseline 역할.

## 7. Cycle exit definition

본 사이클은 다음이 모두 충족될 때 종료:

1. executor `v2.0.0` PyPI 릴리즈 (semver major — back-compat 깨졌으므로).
2. Geny가 그 버전 pin.
3. Geny의 default manifest가 새 schema로 재작성됨.
4. Geny에서 6 provider 모두 세션 생성 가능.
5. Stage 12 sub-agent가 worker 환경에서 실제 동작 (descriptor 1+개 등록 + spawn 성공).
6. Multi-provider sub-agent 시연: 1 세션 안에서 stage 6은 anthropic, sub-agent는 openai로 spawn 검증.
7. Fork-mode skill이 non-anthropic provider로 실행 검증.
8. Frontend e2e가 6 provider × 2 sub-agent provider override 시나리오 통과.
9. Conformance harness 6 backend + sub-agent multi-provider suite 100% 통과.
10. CHANGELOG / 문서 갱신 + cycle wrap-up postmortem 작성.
