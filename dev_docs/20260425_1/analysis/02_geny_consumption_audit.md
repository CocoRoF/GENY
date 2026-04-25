# 02. Geny Consumption Audit — what the host actually wires

**Date:** 2026-04-25
**Source:** `/home/geny-workspace/Geny/backend/` + `/home/geny-workspace/Geny/frontend/src/` (직접 grep + Explore agent 두 패스)
**Purpose:** 01 번 인벤토리의 각 capability 가 host 에 wired 인지 unwired 인지 1:1 매핑.

용례:
- **WIRED** — backend 또는 frontend 가 import / 호출 / runtime 주입을 함. 파일 경로 명시.
- **PARTIAL** — 일부 경로만 연결. 누락 경로 명시.
- **UNWIRED** — 아무 곳에서도 import 되지 않음.

---

## 매핑 표 (Phase 1–10)

| # | Phase | Capability | 상태 | 근거 / 누락 사항 |
|---|---|---|---|---|
| 1 | P1 | `ToolCapabilities` 분류 (concurrency_safe, destructive, …) on Geny custom tools | **UNWIRED** | `service/plugin/protocol.py:202` 가 `Sequence[Any]` 로만 typing — 실제 `ToolCapabilities` 인스턴스화 없음. `service/tool_loader.py` 에도 호출 없음. |
| 2 | P1 | `permission.matrix.evaluate_permission` + `attach_runtime(permission_rules=…, permission_mode=…)` | **UNWIRED** | Geny 는 자체 `service/tool_policy/policy.py` (ToolPolicyEngine MINIMAL/CODING/RESEARCH/FULL) 만 운용. `attach_runtime` 호출 부 (`service/executor/agent_session.py`) 에 `permission_rules` 파라미터 전혀 안 넘김. |
| 3 | P1 | Hook event taxonomy 사용 — `HookEvent` import | **UNWIRED** | 코드베이스 전체에서 `geny_executor.hooks` import 없음. |
| 4 | P2 | Stage 10 PartitionExecutor 활용 (concurrency_safe 기반 그룹) | **UNWIRED (간접)** | manifest 가 `executor: "sequential"` (default_manifest.py:181) 만 발급. `partition` 옵션 미사용. |
| 5 | P3 | Built-in tool catalog 13 종 등록 | **WIRED** | `service/executor/default_manifest.py` 가 `built_in_tool_names=["*"]` 발급 → executor 가 `BUILT_IN_TOOL_CLASSES` 모두 등록. `tests/service/environment/test_tool_registry_roster.py` 에서 검증. |
| 6 | P3 | `AdhocToolProvider` 로 Geny 고유 tool 주입 | **WIRED** | `service/executor/geny_tool_provider.py` 가 `AdhocToolProvider` 서브클래스로 Geny 플랫폼 tool 노출. `agent_session._build_pipeline` 에서 주입. |
| 7 | P4 | `skills.loader.load_skills_dir` 호출 + `SkillTool` 등록 | **UNWIRED** | `geny_executor.skills` import 0건. `~/.geny/skills/` 또는 `<project>/skills/` 디렉토리 스캔 경로 없음. Frontend 에 Skill 관리 UI 없음. |
| 8 | P4 | Slash command (`/test`) → SkillTool 호출 | **UNWIRED** | Slash 파서 자체가 frontend 에 없음. |
| 9 | P5 | `HookRunner` 인스턴스화 + `attach_runtime(hook_runner=…)` | **UNWIRED** | `service/executor/agent_session.py` 의 `attach_runtime` 호출에 `hook_runner=` 미사용. `GENY_ALLOW_HOOKS` env 토글도 없음. |
| 10 | P5 | hooks YAML config 로더 | **UNWIRED** | `~/.geny/hooks.yaml` 또는 유사 경로 로더 없음. |
| 11 | P6 | `MCPManager.connect / disconnect / disable_server / enable_server` runtime 호출 | **UNWIRED** | `service/mcp_loader.py` 가 boot 타임에 `MCPManager` build 후 그대로 attach. Runtime add/remove API endpoint 없음. Frontend 의 `BuilderTab.tsx` MCP 서버 리스트는 read-only. |
| 12 | P6 | MCP FSM 상태 (`PENDING/CONNECTED/FAILED/NEEDS_AUTH/DISABLED`) UI 노출 | **UNWIRED** | `MCPConnectionState` import 없음. `mcp.server.state` 이벤트 구독자 없음. |
| 13 | P7 (S7.1) | `DynamicPersonaPromptBuilder` (s03 System) | **WIRED** | `service/persona/dynamic_builder.py` 가 직접 wrapping. |
| 14 | P7 (S7.2) | `MCPResourceRetriever` (s02 Context) | **UNWIRED** | manifest 의 `retriever` slot 이 `null` 또는 file/sql 만 사용. MCP resource 경로 미연결 (P6 unwired 가 선결). |
| 15 | P7 (S7.3) | `StructuredOutputParser` (s09 Parse) | **UNWIRED** | manifest 의 `parser` slot 이 `default` 만. structured output schema contract 사용 사례 없음. |
| 16 | P7 (S7.4) | `PermissionGuard` (s04 Guard) — `evaluate_permission` 호출 | **UNWIRED** | manifest guard chain 에 `permission` 미포함 (default_manifest 검토). `permission_rules` 가 attach_runtime 에 안 들어감 (#2 와 동일 원인). |
| 17 | P7 (S7.5) | `SubagentTypeOrchestrator` + `SubagentTypeRegistry` (s12 Agent) | **UNWIRED** | manifest 의 `orchestrator` slot 이 `single_agent` 만 (default_manifest.py:193). subagent type registry 정의 없음. |
| 18 | P7 (S7.6) | `EvaluationChain` (s14 Evaluate) | **UNWIRED** | s14 entry 가 default `signal_based` 만 발급. composite evaluator 미사용. |
| 19 | P7 (S7.7) | `MultiDimensionalBudgetController` (s16 Loop) | **UNWIRED** | s16 entry 가 default `standard` controller 만. `BudgetDimension` 정의 없음. |
| 20 | P7 (S7.8) | `AdaptiveModelRouter` (s06 API) + openai/google provider | **UNWIRED** | s06 entry 가 default `passthrough` router 만. Geny `model_provider` 는 anthropic 만 운용. |
| 21 | P7 (S7.9) | `StructuredReflectiveStrategy` (s18 Memory) | **UNWIRED** | s18 entry 가 `append_only` 또는 `no_memory`. structured reflection schema 정의 없음. |
| 22 | P7 (S7.10) | `ThinkingBudgetPlanner` (s08 Think) | **UNWIRED** | s08 entry 가 default `passthrough` processor 만. budget planner 미사용. |
| 23 | P7 (S7.11) | `OrderedEmitterChain` (s17 Emit) | **WIRED** | `service/emit/chain_install.py` 가 `OrderedEmitterChain` 으로 install (G2.1 사이클). |
| 24 | P7 (S7.12) | `MultiFormatYield` (s21 Yield) | **UNWIRED** | s21 entry 가 default formatter. multi-format 미사용. |
| 25 | P8 | `MemoryCredentialStore` / `FileCredentialStore` (MCP credential) | **UNWIRED** | `MCPLoader` 가 env-var expansion 만 사용 (mcp_loader.py:332-358). Credential store import 없음. |
| 26 | P8 | `OAuthFlow` (MCP OAuth 2.0 authorization-code) | **UNWIRED** | `oauth.OAuthFlow` import 없음. Google Drive 등 OAuth-required MCP 서버 미연결. |
| 27 | P8 | `mcp://` URI scheme handler | **UNWIRED** | `is_mcp_uri / parse_mcp_uri / build_mcp_uri` 호출 없음. |
| 28 | P8 | MCP prompts → Skills bridge | **UNWIRED** | `mcp_prompts_to_skills` 호출 없음 (Skill 시스템 자체가 unwired 라 자연스러움). |
| 29 | P9a | 21-stage manifest 발급 | **WIRED** | `service/executor/default_manifest.py` (G1.1). |
| 30 | P9b | Stage 11 (tool_review) — 5 reviewer chain 활성 (worker_adaptive) | **WIRED** | default_manifest preset override + `service/executor/agent_session.py` 의 WS event 분기 (G2.4). |
| 31 | P9b | Stage 13 (task_registry) — `TaskRegistry` 활성 + `TaskPolicy` 선택 | **UNWIRED** | scaffold default 만, advisory. `_PRESET_SCAFFOLD_OVERRIDES` 에 entry 없음. AgentTool 측 spawn 경로도 없음. |
| 32 | P9b | Stage 15 (hitl) — `PipelineResumeRequester` install | **WIRED** | `service/hitl/install.py` (G2.5). |
| 33 | P9b | Stage 19 (summarize) — `RuleBasedSummarizer` + `HeuristicImportance` 활성 | **WIRED** | worker_adaptive override (G2.2). LLM summarizer 는 미사용. |
| 34 | P9b | Stage 20 (persist) — `FilePersister` + `OnSignificantFrequency` install | **WIRED (write)** | `service/persist/install.py` (G2.3). 기록만, 복원 미연결. |
| 35 | P9c | `Pipeline.resume / list_pending_hitl / cancel_pending_hitl` REST | **WIRED** | `controller/agent_controller.py` GET/POST/DELETE `/api/agents/{id}/hitl/{pending,resume,{token}}` (G2.5 + G4.1). |
| 36 | P9c | `restore_state_from_checkpoint` 호출 + 복원 endpoint | **UNWIRED** | `service/persist/install.py` 에 read 측 함수 없음. controller 에도 resume-from-checkpoint endpoint 없음. |
| 37 | P10 | Frontend stage canvas (read-only) | **WIRED** | `frontend/src/components/session-env/PipelineCanvas.tsx` 21-stage (G1.2). |
| 38 | P10 | 실시간 stage execution dashboard (live event grid + token/cost meter) | **UNWIRED** | EventBus 이벤트는 WS 로 흐르지만 frontend 가 timeline 외 별도 "stage live grid" 없음. |
| 39 | P10 | Mutation audit log viewer | **UNWIRED** | `PipelineMutator` 변경이 EventBus 에 흐르지만 UI 없음. |

## 요약 카운트

| 상태 | Count |
|---|---|
| WIRED | 9 (#5, 6, 13, 23, 29, 30, 32, 33, 35) + #37 = **10** |
| WIRED (write only) | 1 (#34) |
| PARTIAL | 0 (Geny session/freshness 는 자체 구현이라 PARTIAL 이 아니라 N/A) |
| UNWIRED | **28** |

**Wired 비율 ≈ 27%.** 잔여물 28건이 다음 cycle 의 작업 단위.

## 영향도 sanity check

WIRED 28건의 합산 효과는 다음과 같이 작용:
- Geny session 이 Phase 1·4·5·6·8 의 보안·운영 기능을 못 누림 (permission, hooks, MCP runtime, OAuth, skills)
- Phase 7 의 stage strategy 풀 12 종 중 **2 종만 사용** (DynamicPersonaPromptBuilder, OrderedEmitterChain)
- Phase 9c 의 crash recovery 가 절반만 작동 (write OK, read-back UNKWN)
- Phase 10 미진행 — observability 가 read-only canvas + execution timeline 으로만 제공

→ 03 번 문서에서 우선순위와 의존성으로 정렬.
