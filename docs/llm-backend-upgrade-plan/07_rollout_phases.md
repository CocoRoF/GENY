# 07 · Rollout Phases

> 6 phase / ~20 PR. 각 phase 끝에서 머지 가능. back-compat 없으므로 부분 phase가 prod에서 동작할 필요 없음 — phase가 baseline 역할.

## 사이클 ID

- Geny 측: 본 폴더 `docs/llm-backend-upgrade-plan/` 자체가 `plan/`. PR 진행 시 `docs/llm-backend-upgrade-plan/progress/` 하위에 PR별 progress 파일 + README index 작성.
- geny-executor 측: 본 사이클 종료 시 **`v2.0.0`** 릴리즈 (semver major — API 시그니처 변경).

## 페이즈 개요

| Phase | 레포 | 끝의 의미 | 추정 PR | 의존성 |
|---|---|---|---|---|
| A — Foundation | executor | capabilities + types + errors + `_cli_runtime` + `credentials` + provider unification + conformance harness 골격 | 3 | — |
| B — Claude Code CLI | executor | `ClaudeCodeCLIClient` + 단독 conformance | 3 | A |
| C — Copilot CLI | executor | `CopilotCLIClient` + 단독 conformance | 2 | A |
| D — Sub-agent multi-provider | executor | Descriptor + Factory + Orchestrator 재설계, fork-mode multi-provider, sub-agent conformance | 4 | A (B/C와 병렬 가능) |
| E — Geny wiring | Geny | CredentialBundle + AgentSessionManager + default manifest 재작성 + sub-agent factory 실구현 + health | 5 | B+C+D 머지 후 executor v2.0.0 릴리즈 후 |
| F — Frontend + polish | Geny | 6-provider 카탈로그 + per-stage override UI + sub-agent 카탈로그 UI + e2e + 문서 | 3 | E |

총 **~20 PR**.

---

## Phase A · Foundation (executor)

### PR #A1 — `ClientCapabilities` + `APIRequest`/`APIResponse` + `ErrorCategory`

**파일:**
- `src/geny_executor/llm_client/base.py` — 9 신규 capability 필드
- `src/geny_executor/llm_client/types.py` — `response_format`, `session_hint`, `cost_usd`, `duration_ms`
- `src/geny_executor/core/errors.py` — 5 신규 enum + retry 분류 dict
- `tests/unit/test_llm_client_capabilities.py` (NEW)
- `tests/unit/test_llm_client_request_types.py` (NEW)
- `tests/unit/test_errors_categories.py` — 갱신

**Acceptance:**
- `pytest tests/` 통과
- 6 backend 모두 `ClientCapabilities`의 16 필드 explicitly 채움
- mypy strict OK

---

### PR #A2 — `_cli_runtime.py` + `credentials.py` + bridge.py 삭제

**파일:**
- `src/geny_executor/llm_client/_cli_runtime.py` (NEW)
- `src/geny_executor/llm_client/credentials.py` (NEW)
- `src/geny_executor/llm_client/bridge.py` (DELETED)
- `tests/llm_client/unit/test_cli_runtime.py` (NEW)
- `tests/llm_client/unit/test_credentials.py` (NEW)
- `tests/_fixtures/fake_echo_cli.py` (NEW)

**Acceptance:**
- fake binary로 process lifecycle (spawn, timeout, kill-tree, env scrub) 통과
- `ProviderCredentials.__repr__`이 api_key redact
- `bridge.py` 어떤 곳에서도 import 안 함

---

### PR #A3 — Provider unification + pipeline rewire + conformance harness 골격

**파일:**
- `src/geny_executor/core/pipeline.py` — `from_manifest_async(credentials=)`만 인정
- `src/geny_executor/core/mutation.py` — restore에서 strategies['provider'] 제거
- `src/geny_executor/core/environment.py` — StageManifestEntry validation
- `src/geny_executor/core/stage.py` — `resolve_local_client(state)`
- `src/geny_executor/stages/s06_api/artifact/default/stage.py` — config['provider'] 단일
- `src/geny_executor/stages/s02_context/.../llm_summary.py` — `resolve_local_client`
- `src/geny_executor/stages/s15_memory/.../reflection.py` — `resolve_local_client`
- `src/geny_executor/stages/s10_tool/.../stage.py` — CLI-managed-tools skip
- `tests/llm_client/conformance/harness.py` (NEW)
- `tests/llm_client/conformance/test_anthropic.py` (NEW)
- `tests/llm_client/conformance/test_openai.py` (NEW)
- `tests/llm_client/conformance/test_google.py` (NEW)
- `tests/llm_client/conformance/test_vllm.py` (NEW)

**Acceptance:**
- 기존 4 provider conformance 통과 (mocked)
- `pytest tests/` 통과
- `Pipeline.from_manifest_async(api_key=str)` 같은 호출이 `TypeError` raise
- `manifest.stages[N].strategies["provider"]` 발견 시 `ConfigError`

---

## Phase B · Claude Code CLI (executor)

### PR #B1 — `translators/_cli.py` (claude_code 부분)

**파일:**
- `src/geny_executor/llm_client/translators/_cli.py` (NEW — claude_code 함수만)
- `src/geny_executor/llm_client/translators/__init__.py` — re-export
- `tests/llm_client/unit/test_translators_cli_claude_code.py` (NEW)
- `tests/_fixtures/claude_responses/*.jsonl`

**Acceptance:**
- argv 빌더 golden test
- stream-json → canonical assembler test
- thinking budget → effort 매핑

---

### PR #B2 — `claude_code.py` + registry 등록

**파일:**
- `src/geny_executor/llm_client/claude_code.py` (NEW)
- `src/geny_executor/llm_client/registry.py` — `claude_code_cli` 팩토리
- `src/geny_executor/llm_client/__init__.py` — re-export
- `tests/llm_client/unit/test_claude_code.py` (NEW)
- `tests/_fixtures/fake_claude.py` (NEW)

**Acceptance:**
- `ClientRegistry.available()` length 5
- fake binary oneshot + streaming 단위 통과
- `mypy` 통과

---

### PR #B3 — `conformance/test_claude_code_cli.py`

**파일:**
- `tests/llm_client/conformance/test_claude_code_cli.py` (NEW)
- 추가 stream-json fixture (`thinking`, `tool_use`, `session_resume`, `json_schema`)

**Acceptance:**
- conformance 통과 (capability-aware skip)
- session continuity round-trip 검증
- error category 매핑 5종 검증

---

## Phase C · Copilot CLI (executor)

### PR #C1 — `translators/_cli.py` (copilot 부분) + `copilot.py`

**파일:**
- `src/geny_executor/llm_client/translators/_cli.py` — copilot 함수 추가
- `src/geny_executor/llm_client/copilot.py` (NEW)
- `src/geny_executor/llm_client/registry.py` — `copilot_cli` 팩토리
- `src/geny_executor/llm_client/__init__.py` — re-export
- `tests/llm_client/unit/test_copilot.py` (NEW)
- `tests/_fixtures/fake_gh.py` (NEW)

**Acceptance:**
- `ClientRegistry.available()` length 6
- fake gh oneshot 통과
- streaming fallback 검증

---

### PR #C2 — `conformance/test_copilot_cli.py`

**파일:**
- `tests/llm_client/conformance/test_copilot_cli.py` (NEW)

**Acceptance:**
- conformance 통과 (대부분 capability-skip)
- error category 매핑

---

## Phase D · Sub-agent multi-provider (executor)

### PR #D1 — `SubagentTypeDescriptor` + `SubAgentBuildContext` + `PipelineFactory` 재설계

**파일:**
- `src/geny_executor/stages/s12_agent/subagent_type.py` — Descriptor 확장, Context dataclass, Factory 시그니처
- `src/geny_executor/stages/s12_agent/artifact/default/orchestrators.py` — `DelegateOrchestrator` 삭제, `SingleAgentOrchestrator` 유지
- `src/geny_executor/stages/s12_agent/artifact/default/stage.py` — orchestrator wiring 단순화
- `tests/unit/test_subagent_descriptor.py` (NEW)
- `tests/subagent/test_subagent_type_orchestrator.py` (NEW) — serial 케이스

**Acceptance:**
- Descriptor 신규 필드 검증
- Context 생성/전파 검증
- SingleAgent orchestrator 회귀 없음
- Serial dispatch 정상

---

### PR #D2 — Parallel sub-agent orchestrator

**파일:**
- `src/geny_executor/stages/s12_agent/subagent_type.py` — parallel 그룹 + Semaphore + gather
- `tests/subagent/test_subagent_parallel.py` (NEW)

**Acceptance:**
- parallel=True 그룹 동시 실행 시 wall time ≤ serial의 1.5x
- max_concurrent 상한 준수
- 한 sub-agent 실패가 형제 중단 안 시킴

---

### PR #D3 — Pipeline registry hookup + state runtime exposure

**파일:**
- `src/geny_executor/core/pipeline.py` — `subagent_registry` slot, state.runtime.{credentials, subagent_registry} expose
- `tests/subagent/test_subagent_credential_propagation.py` (NEW)

**Acceptance:**
- sub-pipeline의 state.runtime.credentials == parent의 credentials
- multi-provider 시연: stage 6=anthropic + sub-agent provider=openai 동시 실행

---

### PR #D4 — Fork-mode skill 재배선 + conformance suite

**파일:**
- `src/geny_executor/skills/fork.py` — `CredentialBundle` 인자, provider 명시 가능
- `src/geny_executor/skills/...` — skill descriptor에 provider 필드 추가
- `tests/subagent/test_fork_multi_provider.py` (NEW)
- `tests/llm_client/conformance/test_subagent_multi_provider.py` (NEW)
- `CHANGELOG.md` — `v2.0.0` 항목 작성

**Acceptance:**
- fork-mode skill이 anthropic 외 backend로 실행 검증
- `ANTHROPIC_API_KEY` 직접 참조 코드 grep 결과 0건
- executor `v2.0.0` 릴리즈 준비

---

> Phase D 종료 후 executor `v2.0.0` PyPI 릴리즈.

---

## Phase E · Geny wiring

### PR #E1 — Settings sections + CredentialBundleBuilder + SubagentRegistryBuilder

**파일:**
- `Geny/backend/service/settings/sections.py` — APIConfig 확장, CLI sections, SubagentsSection
- `Geny/backend/service/settings/install.py` — 신규 sections 등록
- `Geny/backend/service/settings/credentials.py` (NEW)
- `Geny/backend/service/agent_types/seed.py` (NEW) — DEFAULT_SUBAGENT_SEED
- `Geny/backend/service/agent_types/registry.py` — placeholder 제거, SubagentRegistryBuilder
- `Geny/backend/service/agent_types/factories.py` (NEW) — make_default_subagent_pipeline
- `Geny/backend/tests/test_settings_credentials.py` (NEW)
- `Geny/backend/tests/test_subagent_registry_builder.py` (NEW)
- `Geny/pyproject.toml` (or requirements) — `geny-executor>=2.0.0,<2.1.0`

**Acceptance:**
- CredentialBundleBuilder가 6 provider 묶음 빌드
- SubagentRegistryBuilder가 DEFAULT_SUBAGENT_SEED 자동 부트스트랩
- `_placeholder_factory` 문자열 grep 결과 0건

---

### PR #E2 — AgentSessionManager 재배선 + EnvironmentService.instantiate_pipeline

**파일:**
- `Geny/backend/service/executor/agent_session_manager.py` — credentials + subagent_registry 주입
- `Geny/backend/service/environment/service.py` — `instantiate_pipeline(credentials=, subagent_registry=)`
- `Geny/backend/tests/test_agent_session_routing.py` (NEW)
- `Geny/backend/tests/test_subagent_session_flow.py` (NEW)

**Acceptance:**
- anthropic 세션 정상
- openai 세션 정상 (현 wiring gap 해소)
- claude_code_cli 세션 정상 (binary 있는 머신)
- 자격증명 누락 시 한국어 안내
- sub-agent spawn end-to-end 통과

---

### PR #E3 — Default manifest 재작성

**파일:**
- `Geny/backend/service/executor/default_manifest.py` — 21-stage 재작성
- `Geny/backend/service/environment/templates.py` — worker/vtuber preset 갱신
- `Geny/backend/tests/test_default_manifest.py` (NEW)

**Acceptance:**
- 모든 stage가 새 schema (`config["provider"]` 단일 위치)
- Stage 12 orchestrator = `subagent_type`
- 기존 환경 마이그레이션 없음 (clean break) — DB의 옛 manifest는 Geny가 부팅 시 default로 재시드

---

### PR #E4 — Health endpoint + API 라우트

**파일:**
- `Geny/backend/service/health/llm_backends.py` (NEW)
- `Geny/backend/api/health.py` — `/api/health/llm_backends`
- `Geny/backend/api/settings_cli_backends.py` (NEW)
- `Geny/backend/api/settings_subagents.py` (NEW)
- `Geny/backend/tests/test_health_llm_backends.py` (NEW)
- `Geny/backend/tests/test_api_cli_backends.py` (NEW)
- `Geny/backend/tests/test_api_subagents.py` (NEW)

**Acceptance:**
- 6 backend health 모두 보고
- CLI settings PUT 후 health 반영
- subagents CRUD 정상

---

### PR #E5 — 환경 reseeding + dev/QA env 정리

**파일:**
- `Geny/backend/scripts/reseed_environments.py` (NEW) — DB의 옛 manifest 제거 + 새 default seed
- `Geny/backend/tests/test_reseed_environments.py` (NEW)

**Acceptance:**
- dev/staging DB에서 reseed 후 6 provider 모두 동작
- DB에 strategies['provider'] 키 잔재 0건

---

## Phase F · Frontend + polish

### PR #F1 — modelCatalog + ProviderPicker + GlobalSettingsView + CapabilityBadges

**파일:**
- `Geny/frontend/src/lib/modelCatalog.ts` — 6 provider
- `Geny/frontend/src/components/env_management/GlobalSettingsView.tsx` — kind=cli 핸들링
- `Geny/frontend/src/components/env_management/ProviderPicker.tsx`
- `Geny/frontend/src/components/env_management/CapabilityBadges.tsx` (NEW)
- `Geny/frontend/__tests__/modelCatalog.test.ts` (NEW)
- `Geny/frontend/__tests__/ProviderPicker.test.tsx` (NEW)

**Acceptance:**
- TS exhaustive switch에 6 provider 모두 매핑
- GlobalSettingsView가 strategies['provider']를 절대 쓰지 않음 (grep 0건)

---

### PR #F2 — Stage editor (model_override + provider_override) + CLI Backend Settings + Subagent Catalog

**파일:**
- `Geny/frontend/src/components/env_management/StageEditorView.tsx` — 모든 stage panel
- `Geny/frontend/src/components/env_management/stage_panels/ModelOverridePanel.tsx` (NEW)
- `Geny/frontend/src/components/env_management/stage_panels/ProviderOverridePanel.tsx` (NEW)
- `Geny/frontend/src/components/settings/CLIBackendSettings.tsx` (NEW)
- `Geny/frontend/src/components/settings/SubagentCatalogView.tsx` (NEW)
- `Geny/frontend/src/lib/api/llmBackends.ts` (NEW)
- `Geny/frontend/src/lib/api/subagents.ts` (NEW)
- `Geny/frontend/__tests__/StageEditorView.test.tsx` (NEW)
- `Geny/frontend/__tests__/CLIBackendSettings.test.tsx` (NEW)
- `Geny/frontend/__tests__/SubagentCatalogView.test.tsx` (NEW)

**Acceptance:**
- 모든 stage에 model_override + provider_override UI
- CLI 백엔드 health 결과 표시
- sub-agent CRUD 정상
- Playwright e2e: 1 happy path (provider 변경 → 세션 생성 → 응답)

---

### PR #F3 — Docs + progress wrap-up + postmortem

**파일:**
- `Geny/docs/llm-backend-upgrade-plan/progress/` — PR별 progress 파일 + README index
- `Geny/docs/llm-backend-upgrade-plan/postmortem.md` (NEW)
- `Geny/README.md` — CLI 백엔드 + sub-agent 안내
- `Geny/docs/MULTI_PROVIDER_GUIDE.md` (NEW, optional) — 사용자용 가이드

**Acceptance:**
- progress 모든 행 ✅
- README가 onboarding 시나리오 검증
- postmortem 작성

---

## 페이즈 간 머지 정책

각 phase 끝에 머지 가능하나, **back-compat invariant 없음**:
- Phase A 후: executor가 새 API. 옛 Geny는 깨짐.
- Phase B/C 후: 새 backend 추가. 옛 Geny는 여전히 깨짐 (Phase A에서 API 바뀌었으므로).
- Phase D 후: executor v2.0.0 릴리즈 가능.
- Phase E 후: Geny가 새 executor와 동작.
- Phase F 후: UX 완료.

→ **Phase A → D는 executor 단독 진행. Phase E는 D 완료 후 시작. Phase F는 E 완료 후.**

Phase B/C/D는 서로 병렬 가능 (A 의존만).

## 추정 시간 (solo dev focus time)

| Phase | 일수 |
|---|---|
| A | 2~3 |
| B | 2~3 |
| C | 1 |
| D | 2~3 |
| E | 3~4 |
| F | 2~3 |
| **합** | **12~17 working days** |

## "Done" 조건

1. ✅ executor `v2.0.0` PyPI 릴리즈
2. ✅ `ClientRegistry.available()` length 6
3. ✅ Geny가 v2.0.0 pin, 6 provider 모두 세션 생성
4. ✅ Stage 12 sub-agent default 동작 (4 default seed)
5. ✅ Multi-provider sub-agent 시연 (stage 6=anthropic + sub=openai/claude_code_cli)
6. ✅ Fork-mode skill multi-provider 시연
7. ✅ Frontend e2e 통과
8. ✅ Conformance + sub-agent suite 100% 통과
9. ✅ progress README ✅
10. ✅ postmortem 작성
