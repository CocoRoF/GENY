# 08 · Testing Strategy

> 핵심 risk: (a) 6 backend 동작 일관성, (b) CLI 백엔드 머신별 환경 차이, (c) sub-agent multi-provider 시나리오. **Conformance harness + Sub-agent suite + Geny integration**의 3-tier 검증.

## 1. 피라미드

```
              ┌────────────────────────┐
              │  Manual QA / e2e       │  Playwright: 6 provider + 2 sub-agent
              ├────────────────────────┤
              │  Geny integration      │  AgentSessionManager, default manifest
              ├────────────────────────┤
              │  Sub-agent suite       │  ★ multi-provider sub-agent + parallel
              ├────────────────────────┤
              │  Conformance harness   │  ★ 6 backend × 32+ cases
              ├────────────────────────┤
              │  Unit                  │  type/cap/registry/runtime/translators
              └────────────────────────┘
```

## 2. Unit tests

### 2.1 executor

| 영역 | 파일 | 검증 |
|---|---|---|
| Capabilities (16 fields) | `tests/unit/test_llm_client_capabilities.py` | default, frozen, helper |
| Types (response_format, session_hint, cost_usd, duration_ms) | `tests/unit/test_llm_client_request_types.py` | 직렬화 round-trip |
| Errors (5 new categories + retry classification) | `tests/unit/test_errors_categories.py` | enum + retry dict |
| Credentials | `tests/llm_client/unit/test_credentials.py` | require(), __repr__ redact |
| CLI runtime | `tests/llm_client/unit/test_cli_runtime.py` | spawn / timeout / kill-tree / env scrub / stream-json parse |
| Translators (claude_code) | `tests/llm_client/unit/test_translators_cli_claude_code.py` | argv golden + thinking→effort |
| Translators (copilot) | `tests/llm_client/unit/test_translators_cli_copilot.py` | argv + prompt compose |
| Claude Code client | `tests/llm_client/unit/test_claude_code.py` | init / capability / binary resolve |
| Copilot client | `tests/llm_client/unit/test_copilot.py` | 동일 |
| Registry | `tests/unit/test_llm_client_registry.py` | 6 builtin, custom register |
| Subagent descriptor | `tests/unit/test_subagent_descriptor.py` | 신규 필드, validation |
| Subagent orchestrator (serial) | `tests/subagent/test_subagent_type_orchestrator.py` | dispatch order, error isolation |
| Subagent orchestrator (parallel) | `tests/subagent/test_subagent_parallel.py` | gather, semaphore, wall time |
| Credential propagation | `tests/subagent/test_subagent_credential_propagation.py` | parent → ctx → sub-pipeline |
| Fork-mode multi-provider | `tests/subagent/test_fork_multi_provider.py` | skill.provider 적용 |

### 2.2 Geny

| 영역 | 파일 | 검증 |
|---|---|---|
| Settings sections (CLI + subagents) | `backend/tests/test_settings_sections.py` | schema + install |
| CredentialBundleBuilder | `backend/tests/test_settings_credentials.py` | 6 provider 묶음 + env fallback |
| Subagent registry builder | `backend/tests/test_subagent_registry_builder.py` | seed 부트스트랩 + factory 생성 |
| Default manifest | `backend/tests/test_default_manifest.py` | 21-stage shape + provider 위치 |
| AgentSessionManager 라우팅 | `backend/tests/test_agent_session_routing.py` | 6 provider 라우팅 + 자격증명 누락 메시지 |
| Sub-agent session flow | `backend/tests/test_subagent_session_flow.py` | end-to-end spawn |
| Health endpoint | `backend/tests/test_health_llm_backends.py` | mock binary / mock auth |
| API CLI backends | `backend/tests/test_api_cli_backends.py` | GET/PUT + health |
| API subagents | `backend/tests/test_api_subagents.py` | CRUD |
| Reseed script | `backend/tests/test_reseed_environments.py` | 옛 manifest 제거 + 새 seed |
| modelCatalog | `frontend/__tests__/modelCatalog.test.ts` | 6 provider 일관성 |
| ProviderPicker | `frontend/__tests__/ProviderPicker.test.tsx` | 6 provider 표시 |
| StageEditorView | `frontend/__tests__/StageEditorView.test.tsx` | model/provider override panel |
| CLIBackendSettings | `frontend/__tests__/CLIBackendSettings.test.tsx` | form + health |
| SubagentCatalogView | `frontend/__tests__/SubagentCatalogView.test.tsx` | CRUD + default reseed |

## 3. Conformance harness (★ 핵심)

### 3.1 디자인

```python
# tests/llm_client/conformance/harness.py

class ConformanceTestSuite:
    """Provider-agnostic contract tests."""

    def get_client(self, *, mode: Literal["mocked","live"] = "mocked") -> BaseClient: ...
    def get_simple_model_config(self) -> ModelConfig: ...
    def expected_capabilities(self) -> ClientCapabilities: ...

    # 모든 backend
    async def test_basic_text_completion(self): ...
    async def test_response_is_canonical_shape(self): ...
    async def test_token_usage_populated_or_marked_unsupported(self): ...
    async def test_translates_known_errors(self): ...
    # ... (32+ cases)

def capability(name: str):
    """Decorator: skip if get_client().capabilities.<name> is False."""
```

### 3.2 케이스 (32+)

기본 (모든 backend):
1. basic_text_completion
2. response_is_canonical_shape
3. token_usage_populated_or_marked_unsupported
4. emits_unsupported_for_dropped_fields
5. translates_auth_error
6. translates_timeout_error
7. translates_bad_request_error
8. canonical_messages_round_trip
9. concurrent_calls_no_interference
10. event_sink_receives_unsupported_events
11. response_model_field
12. response_message_id_field
13. purpose_label_propagated
14. max_tokens_respected_or_dropped
15. temperature_respected_or_dropped

Capability-gated:
16. `@capability("supports_streaming")` streaming_yields_text_deltas
17. `@capability("supports_streaming")` streaming_completes_with_message_complete
18. `@capability("supports_thinking")` thinking_blocks_present
19. `@capability("supports_thinking")` thinking_budget_applied
20. `@capability("supports_tools")` tool_use_round_trip
21. `@capability("supports_tools")` tool_use_serialization_round_trip
22. `@capability("supports_tool_choice")` tool_choice_any_forces_call
23. `@capability("supports_tool_choice")` tool_choice_none_disables
24. `@capability("supports_structured_output")` json_schema_returns_valid_json
25. `@capability("supports_session_continuity")` resume_session_carries_context
26. `@capability("supports_mcp_passthrough")` mcp_config_passed
27. `@capability("supports_budget_limit")` budget_truncates_run
28. `@capability("supports_cost_usage")` cost_usd_populated
29. `@capability("is_subprocess")` binary_not_found_emits_cli_not_found
30. `@capability("is_subprocess")` timeout_emits_cli_timeout
31. `@capability("is_subprocess")` kill_tree_on_cancellation
32. `@capability("requires_workspace")` workspace_dir_isolated

### 3.3 실행 모드

- `pytest tests/llm_client/conformance/` — default **mocked** mode
- `pytest tests/llm_client/conformance/ --live=anthropic,openai` — live API (CI secret 필요)
- `pytest tests/llm_client/conformance/ --live=claude_code_cli` — 진짜 binary
- CI는 mocked만. live는 별도 manual workflow.

### 3.4 Mocked 모드 구현

| Backend | Mock 도구 |
|---|---|
| anthropic | `respx` HTTPS mock |
| openai | `respx` |
| google | gRPC stub |
| vllm | `respx` |
| claude_code_cli | `tests/_fixtures/fake_claude.py` (stdout에 stream-json 시퀀스) |
| copilot_cli | `tests/_fixtures/fake_gh.py` (stdout에 plain text) |

`conftest.py`가 fake binary들을 `PATH` 앞에 prepend.

## 4. Sub-agent suite

`tests/subagent/`:

| 파일 | 검증 |
|---|---|
| `test_subagent_descriptor.py` | 신규 필드 (provider, parallel, max_concurrent, model_override:ModelConfig) |
| `test_subagent_type_orchestrator.py` | serial dispatch, error isolation, workspace snapshot |
| `test_subagent_parallel.py` | parallel 그룹, semaphore, max_concurrent, 단일 실패 격리 |
| `test_subagent_credential_propagation.py` | parent.credentials == sub.runtime.credentials |
| `test_subagent_multi_provider.py` | stage 6=anthropic + sub-agent provider=openai, 둘 다 호출 검증 |
| `test_subagent_nested_blocked.py` | sub-pipeline의 stage 12 orchestrator=single_agent 강제 검증 |
| `test_fork_multi_provider.py` | fork-mode skill의 provider 명시 → 그에 맞는 client 사용 |

### 4.1 multi_provider 시나리오 (E2E)

```python
async def test_stage6_anthropic_subagent_openai(mocked_clients):
    bundle = CredentialBundle(by_provider={
        "anthropic": ProviderCredentials(api_key="A_KEY"),
        "openai":    ProviderCredentials(api_key="O_KEY"),
    })
    reg = SubagentTypeRegistry()
    reg.register(SubagentTypeDescriptor(
        agent_type="researcher",
        provider="openai",
        factory=mocked_subagent_factory,
        ...
    ))
    parent_manifest = make_test_manifest(stage6_provider="anthropic", stage12="subagent_type")
    pipeline = await Pipeline.from_manifest_async(
        parent_manifest, credentials=bundle, subagent_registry=reg,
    )
    # ... run with delegate request
    # ... assert: anthropic mock was called for parent stage 6
    #             openai mock was called from sub-pipeline stage 6
```

## 5. Geny integration tests

| Scenario | 파일 |
|---|---|
| anthropic flow (baseline) | `test_agent_session_anthropic_flow.py` |
| openai flow (wiring gap fix) | `test_agent_session_openai_flow.py` |
| claude_code_cli flow | `test_agent_session_claude_code_flow.py` |
| copilot_cli flow | `test_agent_session_copilot_flow.py` |
| missing credentials | `test_agent_session_missing_credentials.py` |
| per-stage override | `test_per_stage_override_flow.py` |
| sub-agent end-to-end | `test_subagent_session_flow.py` |
| sub-agent multi-provider | `test_subagent_multi_provider_flow.py` |
| fork skill multi-provider | `test_fork_skill_multi_provider.py` |
| reseed environments | `test_reseed_environments.py` |

## 6. Frontend tests

- `__tests__/modelCatalog.test.ts` — 6 provider 카탈로그
- `__tests__/ProviderPicker.test.tsx` — 6 provider 렌더
- `__tests__/StageEditorView.test.tsx` — override panel
- `__tests__/CLIBackendSettings.test.tsx` — form + health
- `__tests__/SubagentCatalogView.test.tsx` — CRUD + reseed
- Playwright e2e (Phase F): 6 provider × 2 sub-agent provider override 시나리오

## 7. Manual QA checklist (Phase F 종료 시)

- [ ] Geny UI에서 6 provider 모두 선택 → 세션 생성 OK
- [ ] CLI 백엔드 binary 없는 머신에서 한국어 안내
- [ ] gh auth 미인증에서 copilot_cli 안내
- [ ] Stage 19 (summarize) provider_override="openai" → 정상
- [ ] Stage 18 (memory reflection) provider_override="claude_code_cli" → 정상
- [ ] Sub-agent UI에서 4 default seed 표시
- [ ] researcher (anthropic/opus, parallel=True) + summarizer (openai/mini, parallel=True) 동시 호출 시 fan-out 관측
- [ ] critic (claude_code_cli) sub-agent spawn 시 subprocess 발생 검증
- [ ] fork-mode skill provider="openai" → openai client로 호출
- [ ] `/api/health/llm_backends` 6 backend 보고
- [ ] reseed 후 옛 manifest 잔재 없음

## 8. Performance / smoke

`tests/perf/` (manual, not CI):
- `test_cli_cold_start.py` — spawn → first token / message_complete
- `test_cli_concurrency.py` — 10 parallel CLI calls, fd leak 점검
- `test_subagent_parallel_overhead.py` — parallel sub-agent fan-out 시 wall time

## 9. Regression invariants (매 PR 머지 후)

executor:
- `pytest tests/` 전체
- `pytest tests/llm_client/conformance/` (mocked)
- `pytest tests/subagent/`
- `mypy src/geny_executor` strict
- `ruff check src/geny_executor`

Geny:
- `pytest backend/tests/`
- `npm test --prefix frontend/`
- `npm run typecheck --prefix frontend/`
- `docker compose -f docker-compose.dev-core.yml up` 부트 → 1 happy session

## 10. CI/CD

- GitHub Actions: matrix `live_api=false` job (default).
- 별도 manual workflow: live API + 실제 binary self-hosted runner — out-of-scope this cycle (필요 시 Phase E 종료 후 결정).

## 11. Coverage 목표

| 영역 | line coverage |
|---|---|
| `geny_executor/llm_client/base.py` | 95% |
| `geny_executor/llm_client/_cli_runtime.py` | 90% |
| `geny_executor/llm_client/claude_code.py` | 85% |
| `geny_executor/llm_client/copilot.py` | 80% |
| `geny_executor/llm_client/translators/_cli.py` | 90% |
| `geny_executor/llm_client/credentials.py` | 95% |
| `geny_executor/stages/s12_agent/subagent_type.py` | 90% |
| `geny_executor/skills/fork.py` | 85% |
| `Geny/backend/service/settings/credentials.py` | 90% |
| `Geny/backend/service/agent_types/` | 85% |
| `Geny/backend/service/health/llm_backends.py` | 85% |

전체 패키지 coverage 5%+ 상승 목표.
