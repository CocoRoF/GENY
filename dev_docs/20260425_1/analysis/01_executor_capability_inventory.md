# 01. geny-executor 1.0.0 Capability Inventory

**Date:** 2026-04-25
**Source:** `/home/geny-workspace/geny-executor/` (CHANGELOG.md + 직접 코드 확인)
**Purpose:** 다음 cycle 의 baseline. "executor 가 무엇을 ship 했는지" 의 단일 진실원.

executor uplift 는 0.32.0 (Phase 1) → 1.0.0 (Phase 9c + stability) 로 **Phase 1–9 전부 마감**, Phase 10 만 deferred. 본 문서는 그 산출물을 phase 단위로 인덱싱한다. 어느 한 줄도 "Geny 가 쓴다" 는 가정 없음 — wiring 점검은 02 번 문서에서.

---

## Phase 1 — Foundation (`0.32.0`)

| Area | Module | 핵심 심볼 |
|---|---|---|
| Tool ABC capability flags | `geny_executor.tools.base.ToolCapabilities` | `concurrency_safe`, `read_only`, `destructive`, `idempotent`, `network_egress`, `interrupt`, `max_result_chars` |
| Permission rule matrix | `geny_executor.permission.{matrix, loader, types}` | `evaluate_permission(...)`, `load_permission_rules(yaml_path)`, `PermissionRule` |
| Hook event taxonomy | `geny_executor.hooks.events.HookEvent` | 16 enum: SESSION_START/END, PIPELINE_START/END, STAGE_ENTER/EXIT, USER_PROMPT_SUBMIT, PRE/POST_TOOL_USE, POST_TOOL_FAILURE, PERMISSION_REQUEST/DENIED, LOOP_ITERATION_END, CWD_CHANGED, MCP_SERVER_STATE, NOTIFICATION |
| Stage 10 partition exec | `geny_executor.stages.s10_tool.artifact.default.executors.PartitionExecutor` | concurrency-grouped tool 실행 |

## Phase 2 — Orchestration (`0.33.0`)

| Area | Module | 핵심 심볼 |
|---|---|---|
| Streaming partitioned tool exec | `s10_tool` | `PartitionExecutor` 가 group A/B/C 별 동시성 정책 적용 |

## Phase 3 — Built-in Tool Catalog 6→13 (`0.34.0`)

`geny_executor.tools.built_in.BUILT_IN_TOOL_CLASSES` (모듈 init):

1. `ReadTool` 2. `WriteTool` 3. `EditTool` 4. `BashTool` 5. `GlobTool` 6. `GrepTool` (legacy 6)
7. `WebFetchTool` 8. `WebSearchTool` 9. `TodoWriteTool` 10. `NotebookEditTool` 11. `ToolSearchTool` 12. `EnterPlanModeTool` 13. `ExitPlanModeTool`

각 tool 은 `ToolCapabilities` 로 분류됨 (예: `BashTool.capabilities = ToolCapabilities(destructive=True, network_egress=True, ...)`).

`ToolProvider` ABC + `AdhocToolProvider` 구현 — 호스트가 추가 tool 을 주입할 표준 채널.

## Phase 4 — Skills (`0.35.0`)

| Module | 핵심 심볼 |
|---|---|
| `geny_executor.skills.types` | `Skill` dataclass (id, name, description, prompt, allowed_tools, model, source) |
| `geny_executor.skills.frontmatter` | YAML frontmatter parser for `SKILL.md` |
| `geny_executor.skills.loader` | `load_skills_dir(root: Path) -> List[Skill]` |
| `geny_executor.skills.registry` | `SkillRegistry` 에 등록 / 조회 |
| `geny_executor.skills.skill_tool` | `SkillTool` (Tool ABC), `SkillToolProvider(registry, name=...)` |
| `geny_executor.skills.mcp_bridge` | `mcp_prompts_to_skills(manager: MCPManager) -> List[Skill]` (Phase 8 에서 채워짐) |

## Phase 5 — Hooks (`0.36.0`)

| Module | 핵심 심볼 |
|---|---|
| `geny_executor.hooks.runner.HookRunner` | `fire(event: HookEvent, payload) -> HookOutcome` (async) |
| `geny_executor.hooks.config` | `load_hooks_config(yaml_path)` → `List[HookConfigEntry]` |
| Stage 10 PRE/POST_TOOL_USE wiring | `s10_tool` 가 `state.shared['hook_runner']` 사용 |

`HookRunner` 는 subprocess 기반: hook 스크립트 stdin 에 JSON payload, stdout 에 `{"continue": bool, "modified_payload": ...}` JSON. Timeout fail-open.

## Phase 6 — MCP Uplift (`0.37.0`)

| Module | 핵심 심볼 |
|---|---|
| `geny_executor.tools.mcp.manager.MCPManager` | `connect(name, config)`, `disconnect(name)`, `disable_server(name)`, `enable_server(name)`, `discover_tools()`, `discover_all()`, `build_registry()`, `test_connection()` |
| `geny_executor.tools.mcp.state.MCPConnectionState` | `PENDING / CONNECTED / FAILED / NEEDS_AUTH / DISABLED` enum |
| Annotation → `ToolCapabilities` 자동 매핑 | MCP `annotations.readOnlyHint`, `destructiveHint` 등을 적절한 `ToolCapabilities` 필드로 변환 |
| `attach_runtime(mcp_manager=…)` kwarg | Pipeline 에 MCP 매니저 주입 |

`mcp.server.state` 이벤트가 EventBus 로 흐름 — UI 가 구독 가능.

## Phase 7 — Stage Enhancements (`0.38.x`–`0.41.0`)

12 sprint, stage 별 strategy 풀 확장:

| Sprint | Stage | 신규 strategy / 기능 |
|---|---|---|
| S7.1 | s03 System | `DynamicPersonaPromptBuilder` (`persona/builder.py`) |
| S7.2 | s02 Context | `MCPResourceRetriever` (Phase 6 의존) |
| S7.3 | s09 Parse | `StructuredOutputParser` schema contract |
| S7.4 | s04 Guard | `PermissionGuard` 에서 `permission.matrix.evaluate_permission` 호출 |
| S7.5 | s12 Agent | `SubagentTypeOrchestrator` + `SubagentTypeRegistry` + `SubagentTypeDescriptor` |
| S7.6 | s14 Evaluate | `EvaluationChain` (composite evaluator) |
| S7.7 | s16 Loop | `MultiDimensionalBudgetController` (token/cost/iteration/walltime 다축 예산) |
| S7.8 | s06 API | `AdaptiveModelRouter` (Opus/Sonnet/Haiku 라우팅) + openai/google provider |
| S7.9 | s18 Memory | `StructuredReflectiveStrategy` (스키마 기반 reflection) |
| S7.10 | s08 Think | `ThinkingBudgetPlanner` adaptive budget |
| S7.11 | s17 Emit | `OrderedEmitterChain` (priority + barrier emit) |
| S7.12 | s21 Yield | `MultiFormatYield` (`s21_yield.artifact.default.multi_format`) |

## Phase 8 — MCP Advanced (`0.42.0`)

| Module | 핵심 심볼 |
|---|---|
| `geny_executor.tools.mcp.credentials` | `CredentialStore` Protocol + `MemoryCredentialStore`, `FileCredentialStore` |
| `geny_executor.tools.mcp.oauth` | `OAuthFlow` (authorization-code, callback port + state) |
| `geny_executor.tools.mcp.uri` | `is_mcp_uri()`, `parse_mcp_uri()`, `build_mcp_uri()` for `mcp://server/resource` |
| `geny_executor.skills.mcp_bridge.mcp_prompts_to_skills` | MCP prompt → Skill 자동 변환 |

## Phase 9a — 21-stage scaffolding (`0.43.0`)

- Stages renamed (`s11_agent → s12_agent`, `s12 → s14`, `s13 → s16`, `s14 → s17`, `s15 → s18`, `s16 → s21`)
- 5 신규 scaffold: `s11_tool_review`, `s13_task_registry`, `s15_hitl`, `s19_summarize`, `s20_persist` (모두 pass-through default)
- Loop boundary: `LOOP_END=16`, `FINALIZE_START=17`, `FINALIZE_END=21`
- Manifest v2 → v3 auto-migration

## Phase 9b — Real strategy slots (`0.46.0`)

| Stage | 신규 strategies |
|---|---|
| s11 tool_review | `Reviewer` ABC + 5 default: `SchemaReviewer`, `SensitivePatternReviewer`, `DestructiveResultReviewer`, `NetworkAuditReviewer`, `SizeReviewer` (chain) |
| s13 task_registry | `TaskRegistry` ABC + `InMemoryRegistry`, `TaskPolicy` (eager_wait / fire_and_forget / timed_wait) |
| s15 hitl | `Requester` ABC + `NullRequester` (always-approve), `TimeoutPolicy` (indefinite / auto_approve / auto_reject) |
| s19 summarize | `Summarizer` ABC + `NoSummary`, `RuleBasedSummarizer`, `LLMSummarizer` (Haiku override), `HybridSummarizer`; `Importance` (`FixedImportance`, `HeuristicImportance`, `LLMImportance`) |
| s20 persist | `Persister` ABC + `NoPersist`, `FilePersister`, (Postgres / Redis are host-side); `FrequencyPolicy` (`EveryTurn`, `EveryNTurns`, `OnSignificant`) |

## Phase 9c — Pipeline.resume + crash recovery (`1.0.0`)

| API | Module |
|---|---|
| `Pipeline._pending_hitl: Dict[str, Future[HITLDecision]]` | `core/pipeline.py` |
| `Pipeline.list_pending_hitl() -> List[str]` | `core/pipeline.py` |
| `Pipeline.resume(token, decision)` | `core/pipeline.py` |
| `Pipeline.cancel_pending_hitl(token) -> bool` | `core/pipeline.py` |
| `PipelineResumeRequester(pipeline)` | `s15_hitl/...` (slot id `"pipeline_resume"`) |
| `restore_state_from_checkpoint(persister, checkpoint_id)` | `s20_persist/restore.py` |
| `state_from_payload(payload)` | `s20_persist/restore.py` |
| `CheckpointNotFound` exception | `s20_persist/restore.py` |

## Pipeline 1.0 `attach_runtime` 전체 시그니처

```
Pipeline.attach_runtime(
    memory_retriever=None,
    memory_strategy=None,
    memory_persistence=None,
    system_builder=None,
    tool_context=None,
    llm_client=None,
    session_runtime=None,
    hook_runner=None,            # ← Phase 5
    mcp_manager=None,            # ← Phase 6
    permission_rules=None,       # ← Phase 1
    permission_mode=None,        # ← Phase 1
)
```

## Phase 10 — Observability (deferred)

`PROGRESS.md` 와 `CHANGELOG.md` 모두 명시: "Phase 10 (Observability — frontend dashboard) remains optional and does not block 1.0".  EventBus 자체는 모든 phase 에서 이벤트 방출 중 — 시각화 측이 미구현일 뿐.
