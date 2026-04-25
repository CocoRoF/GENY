# Cycle 20260425_1 — Geny Adoption of geny-executor 1.0 (Phases 1·5·6·7·8 + 9c read + 10)

**Goal:** geny-executor `1.0.0` 가 ship 한 capability 중 `analysis/02` 의 28건 unwired 항목을 Geny host 에 흡수. 이전 cycle (G1.x–G5.x) 가 끝낸 Phase 9 위에서, 보안·운영·확장성 면을 모두 채워 production-ready 1.0 host 로 전환.

**Baseline:** `main` @ `e071518 docs(executor_uplift): mark v3 21-stage layout as shipped (G5.1) (#301)`
**Pin:** `geny-executor[web]>=1.0.0,<2.0.0`
**Cadence:** 6 sub-cycles (G6 → G11), 총 **33 PR**, 모두 단독 revert 가능.
**Sequencing 원칙:** R1 (G6.x) 이 R2/R6 의 선결, 그 외는 모두 병렬 진행 가능.

---

## 0. Pre-flight checklist

PR-0 (single, 비코드 PR — optional)
- `dev_docs/20260425_1/` README 추가 (cycle navigation)
- `executor_uplift/index.md` 의 "산출물 요약" 체크박스 갱신 (Phase 1–8 도 완료 표기)
- 사용자 승인: 이 cycle plan 그대로 진행할지

이후 G6.1 부터 PR 단위 시작.

---

## G6 — Phase 1 + Phase 5 (Capability flags + Permission + Hooks)

**Goal:** 보안·운영의 토대. Geny custom tool 에 capability 메타데이터 부여, permission matrix 적재, HookRunner 활성. 이 cycle 후 모든 tool 호출이 capability/policy/hook 3중 검사 통과.

### G6.1 — `ToolCapabilities` adoption on Geny custom tools

**범위:** `service/plugin/protocol.py`, `service/plugin/tamagotchi.py`, `service/executor/geny_tool_provider.py`, 그리고 game/event 계열 tool 들.

- `geny_executor.tools.base.ToolCapabilities` import
- 각 Geny tool 에 `capabilities = ToolCapabilities(...)` 클래스 변수 추가:
  - `feed_tool` / `play_tool` / `gift_tool` → `concurrency_safe=False, destructive=True (state mutation), idempotent=False`
  - `talk_tool` / `read_state` → `concurrency_safe=True, read_only=True`
  - `send_direct_message_external` → `network_egress=True, destructive=False`
- 기존 tool registry typing 강화 (`Sequence[Tool]` → `Sequence[Tool]` with capability assertion)

**테스트:** `tests/service/plugin/test_tool_capabilities.py` (신규) — 각 tool 의 capability 가 의도대로 분류됐는지 단언.

**Risk:** 0 — additive. 기존 호출자가 capability 를 안 봐도 동작.

### G6.2 — `PartitionExecutor` 활성화

**범위:** `service/executor/default_manifest.py` Stage 10 entry.

- `strategies={"executor": "sequential", "router": "registry"}` → `{"executor": "partition", "router": "registry"}`
- partition rule: `concurrency_safe=True` 그룹은 동시 실행, 그 외는 직렬.
- 기존 default `sequential` 도 fallback 유지.

**테스트:** `tests/service/executor/test_partition_execution.py` — read-only tool 두 개 동시 실행, destructive 와 read-only 섞으면 destructive 가 격리되는지.

**의존성:** G6.1 (capability flag 가 정확해야 partition 이 의미)

### G6.3 — Permission rule YAML loader + `attach_runtime` wiring

**범위:** `service/permission/{__init__.py, install.py}` (신규), `service/executor/agent_session.py`.

- `~/.geny/permissions.yaml` (또는 `<repo>/permissions.yaml`) 스캔 → `geny_executor.permission.loader.load_permission_rules` 호출
- 결과를 `Pipeline.attach_runtime(permission_rules=…, permission_mode="enforce|advisory")` 에 주입
- `service/tool_policy/policy.py` 의 ToolPolicyEngine 과 병행 (기존 호환), 단 deny 결정은 executor 의 PermissionGuard 가 owner
- 기본 모드: `advisory` (deny 시 경고만, 다음 sprint 에서 `enforce` 로 승격)

**테스트:**
- `tests/service/permission/test_install.py` — 빈 YAML → empty rules, 존재하지 않는 경로 → no-op
- `tests/service/permission/test_yaml_format.py` — sample YAML 라운드트립

**의존성:** 없음 (G6.1 과 병렬 가능)

### G6.4 — Stage 4 PermissionGuard 활성

**범위:** `service/executor/default_manifest.py` Stage 4 (Guard) chain.

- `chain_order={"guards": ["token_budget", "cost_budget", "iteration", "permission"]}` 추가
- worker_adaptive 부터 활성, worker_easy / vtuber 는 token + iteration 만

**테스트:** `tests/service/executor/test_permission_guard.py` — denied tool 호출 시 Stage 4 가 reject 발사, EventBus 에 `permission.denied` 이벤트.

**의존성:** G6.3

### G6.5 — `HookRunner` + `hooks.yaml` loader + `attach_runtime(hook_runner=…)`

**범위:** `service/hooks/{__init__.py, install.py}` (신규), `service/executor/agent_session.py`.

- `geny_executor.hooks.runner.HookRunner` 인스턴스화
- `~/.geny/hooks.yaml` 스캔 (없으면 no-op): event → list of subprocess command
- `Pipeline.attach_runtime(hook_runner=runner)` 에 주입
- env 토글 `GENY_ALLOW_HOOKS=1` (기본 off)
- 예제 hook 스크립트 3종: `hooks/examples/{pre_check.sh, audit_log.py, redact_secrets.sh}` (커밋, 실행 안 함)

**테스트:**
- `tests/service/hooks/test_install.py` — env off → runner 가 None 으로 주입, env on → 실제 runner
- `tests/service/hooks/test_hook_outcome.py` — hook 가 `{"continue": false}` 반환 시 tool 호출 차단되는지

### G6.6 — Frontend hook indicator (간단)

**범위:** `frontend/src/components/execution/ExecutionTimeline.tsx`.

- `event_type` 이 `pre_tool_use_hook` / `post_tool_use_hook` / `permission_denied` 인 경우 별도 아이콘 (Lock / ShieldOff)
- Stage 4 deny 가 timeline 에 inline 노출

**테스트:** 수동 — hook 활성 환경에서 visual 확인

**의존성:** G6.5 + G6.4 (이벤트가 흘러야)

### G6 Done definition

- worker_adaptive 가 capability flag 검사 + permission matrix + hook runner 3중 통과 후 tool 호출
- timeline 에 deny / hook block 이벤트 가시화
- regression: 기본 (env off, YAML 비어있음) 시 기존 동작 100% 유지

---

## G7 — Crash recovery + Skills

**Goal:** 운영 SLA (장애 후 복원) + 사용자 확장성 (코드 수정 없는 capability 추가). 두 항목 모두 단독 PR 가능, 묶어서 한 cycle 로.

### G7.1 — `restore_state_from_checkpoint` + REST endpoint

**범위:** `service/persist/restore.py` (신규), `controller/agent_controller.py`.

- `service/persist/install.py` 가 이미 갖고 있는 persister 인스턴스를 reuse
- `restore_state_from_checkpoint(persister, checkpoint_id)` 호출
- 신규 endpoint: `POST /api/agents/{id}/restore` body `{checkpoint_id}` → 새 세션 build + state 복원 + 200 OK with new session_id
- `state.session_runtime` 등 runtime 필드는 재바인딩 (executor 가 의도적으로 미복원 — manifest 에 명시)

**테스트:**
- `tests/service/persist/test_restore.py` — file persister 에 사전 기록 → restore endpoint 호출 → state.messages 복원 확인
- `tests/service/persist/test_restore_endpoint.py` — 알 수 없는 checkpoint_id → 404 (CheckpointNotFound 매핑)

### G7.2 — Frontend "Resume from checkpoint" UI

**범위:** `frontend/src/components/modals/RestoreCheckpointModal.tsx` (신규), Sidebar entry.

- 세션이 `error` 상태로 끝났거나 `crashed` 표시 시 "Restore" 버튼
- 클릭 → checkpoint 목록 (별도 endpoint `GET /api/agents/{id}/checkpoints`) 표시 → 선택 → POST restore

**테스트:** 수동 — SIGKILL 후 시뮬레이션, 복원 성공 visual

**의존성:** G7.1

### G7.3 — Skills loader + `~/.geny/skills/` 디렉토리

**범위:** `service/skills/{__init__.py, install.py}` (신규), `service/executor/agent_session.py`, `service/executor/default_manifest.py`.

- `geny_executor.skills.loader.load_skills_dir(Path.home() / ".geny" / "skills")` 호출
- 결과 `SkillRegistry` 를 `Pipeline.attach_runtime(session_runtime=…)` 의 session_runtime 에 attach (registry 노출)
- `SkillToolProvider(registry, name="skill")` 를 `geny_tool_provider` 와 병렬로 등록
- env 토글 `GENY_ALLOW_USER_SKILLS=1` (기본 off, 보안 항목)

**테스트:**
- `tests/service/skills/test_install.py` — 디렉토리 없음 → no-op, 한 개 skill 추가 → tool 등록 확인
- `tests/service/skills/test_skill_invocation.py` — `SkillTool(skill="summarize-session")` 호출 → prompt + allowed_tools sub-pipeline 실행

### G7.4 — Frontend slash command parser + Skill 목록

**범위:** `frontend/src/components/tabs/CommandTab.tsx`, `frontend/src/components/SkillPanel.tsx` (신규), `agentApi.skills`.

- `/skill-id` 입력 시 SkillTool 호출로 변환 (기존 prompt 본문 위에 prefix)
- 사이드 패널: `~/.geny/skills/` 의 skill 목록 + 각 skill 클릭 시 `/skill-id` 자동 입력
- 새 endpoint `GET /api/skills/list`

**테스트:** 수동

**의존성:** G7.3

### G7.5 — 번들 skill 3종

**범위:** `backend/skills/bundled/{summarize_session, search_web_and_summarize, draft_pr}/SKILL.md`

- `summarize-session` — 현재 session 의 messages 를 압축 (Stage 19 reuse)
- `search-web-and-summarize` — WebSearch + WebFetch + 요약 (Phase 3 built-in tool 사용)
- `draft-pr` — git status / diff → PR draft prompt

**테스트:** `tests/service/skills/test_bundled_skills.py` — 각 SKILL.md frontmatter 파싱 + allowed_tools 검증

### G7 Done definition

- SIGKILL 후 `Restore` 버튼으로 같은 sessionId 의 마지막 checkpoint 로 복원
- `~/.geny/skills/test.md` 추가 후 다음 세션의 slash command 에서 `/test` 동작
- 번들 skill 3개가 worker_adaptive 에서 호출 가능

---

## G8 — Phase 6 MCP runtime FSM

**Goal:** Geny operator 가 재시작 없이 MCP 서버 add/remove/disable 가능. FSM 상태가 frontend 에 노출.

### G8.1 — MCP admin REST endpoints

**범위:** `controller/mcp_controller.py` (신규), `service/mcp_loader.py` 확장.

- `GET /api/mcp/servers` — 현재 MCPManager 의 서버 목록 + 각 FSM 상태
- `POST /api/mcp/servers` body `{name, config}` → `MCPManager.connect(name, config)`
- `DELETE /api/mcp/servers/{name}` → `MCPManager.disconnect(name)`
- `POST /api/mcp/servers/{name}/disable` / `POST /api/mcp/servers/{name}/enable`
- `POST /api/mcp/servers/{name}/test` → `MCPManager.test_connection(name)`

**테스트:**
- `tests/controller/test_mcp_controller.py` — happy path 4종 + 알 수 없는 서버 → 404 + 이미 연결된 서버 → 409

### G8.2 — `mcp.server.state` event subscriber + WS broadcast

**범위:** `service/executor/agent_session.py` event loop, `service/logging/session_logger.py`.

- `mcp.server.state` 이벤트를 잡아 `log_stage_event(event_type="mcp_server_state", data={...})` 로 직렬화
- frontend 의 ExecutionTimeline / 새 MCPStatusPanel 이 구독

### G8.3 — Frontend MCP admin panel

**범위:** `frontend/src/components/tabs/MCPTab.tsx` (신규 또는 BuilderTab 확장).

- 서버 리스트 + FSM 상태 (PENDING/CONNECTED/FAILED/NEEDS_AUTH/DISABLED) 컬러 칩
- Add server 모달 (`+ New MCP server`) — name + transport + config JSON
- 각 서버 우측에 disable/enable/disconnect 버튼

**테스트:** 수동

### G8.4 — Manifest mcp_servers 와 runtime add 의 충돌 처리

**범위:** `service/mcp_loader.py`.

- 기존 manifest 의 `tools.mcp_servers` 와 runtime add 를 어떻게 병합할지 명시
  - 결정: manifest 의 server 는 "기본 정적", runtime add 는 "세션 한정 동적". 같은 이름이면 manifest 가 우선 (warning).
- 문서: `service/mcp_loader.py` docstring 에 명시

**테스트:** `tests/service/test_mcp_runtime.py` — 같은 이름의 runtime add → 거부 + 409

### G8 Done definition

- `POST /api/mcp/servers {name: "filesystem", config: {...}}` → 다음 턴부터 `mcp__filesystem__*` tool 가시
- 서버 연결 실패 시 해당 tool 만 invisible, 다른 서버 영향 없음
- `mcp.server.state` 이벤트가 UI 에 흐름

---

## G9 — Phase 7 stage strategy 흡수 (12 sprints, 11 sprint 만 잔여)

**Goal:** executor 의 풍부한 strategy 풀을 Geny manifest 가 실제 사용. S7.1 (DynamicPersonaPromptBuilder), S7.11 (OrderedEmitterChain) 은 이미 wired — 11개 잔여.

각 sprint 는 **단일 PR** = manifest entry 변경 + 활성 preset 표 + integration 테스트 + 문서. Risk 가 낮으므로 1 PR/일 페이스로 진행.

### G9.1 — S7.2 `MCPResourceRetriever` (s02 Context)

- manifest s02 의 `retriever` slot 옵션에 `mcp_resource` 추가
- worker_adaptive override 에서 활성, retriever config 에 server name list
- **의존성:** G8 (MCP runtime 이 있어야)
- 테스트: `tests/service/executor/test_context_mcp_retriever.py`

### G9.2 — S7.3 `StructuredOutputParser` (s09 Parse)

- manifest s09 의 `parser` slot 옵션에 `structured_output` 추가
- 사용 예: vtuber preset 의 affect_tag JSON 응답에 schema 강제
- 테스트: `tests/service/executor/test_structured_output.py`

### G9.3 — S7.4 `PermissionGuard` (s04 Guard) — **G6.4 와 합체**

이미 G6.4 에서 처리됨. G9.3 은 skip.

### G9.4 — S7.5 `SubagentTypeOrchestrator` (s12 Agent)

- `service/agent_types/{__init__.py, registry.py}` (신규) — Geny 가 정의하는 subagent type (worker / researcher / vtuber-narrator …)
- manifest s12 `orchestrator` 옵션에 `subagent_type` 추가
- 테스트: `tests/service/agent_types/test_subagent_type.py`

### G9.5 — S7.6 `EvaluationChain` (s14 Evaluate)

- manifest s14 `strategy` 옵션에 `evaluation_chain` 추가
- worker_adaptive 가 `[signal_based, criteria_based]` chain 사용
- 테스트: `tests/service/executor/test_evaluation_chain.py`

### G9.6 — S7.7 `MultiDimensionalBudgetController` (s16 Loop)

- manifest s16 `controller` 옵션에 `multi_dimensional` 추가
- 기본 dimensions: `iterations`, `cost_usd`, `walltime_seconds`
- 테스트: `tests/service/executor/test_multi_budget.py`

### G9.7 — S7.8 `AdaptiveModelRouter` (s06 API) + openai/google provider

- manifest s06 `router` 옵션에 `adaptive` 추가
- model classifier: turn 길이 / tool call 빈도 / cost 누적으로 Opus → Sonnet → Haiku 라우팅
- (선택) openai/google provider 등록 (env 토글)
- 테스트: `tests/service/executor/test_adaptive_router.py`

### G9.8 — S7.9 `StructuredReflectiveStrategy` (s18 Memory)

- manifest s18 `strategy` 옵션에 `structured_reflective` 추가
- reflection schema 정의 (`{insights: [...], tags: [...], importance: ...}`)
- 테스트: `tests/service/executor/test_structured_reflection.py`

### G9.9 — S7.10 `ThinkingBudgetPlanner` (s08 Think)

- manifest s08 에 `budget_planner` slot 신설
- adaptive: 첫 턴 high budget, 이후 점차 감소
- 테스트: `tests/service/executor/test_thinking_budget.py`

### G9.10 — S7.11 (이미 G2.1 에서 wired)

skip.

### G9.11 — S7.12 `MultiFormatYield` (s21 Yield)

- manifest s21 `formatter` 옵션에 `multi_format` 추가
- output formats: text / structured_json / streaming chunks 동시 지원
- 테스트: `tests/service/executor/test_multi_format_yield.py`

### G9 Done definition

- 11 stage strategy 모두 manifest 에서 사용 가능
- worker_adaptive preset 이 strategy 풀 절반 이상 활성
- 회귀: 300-seed 비교에서 vtuber / worker_easy 변화 없음

---

## G10 — Phase 8 OAuth + URI + bridge

**Goal:** MCP 운영 자동화. OAuth-required 서버 (Google Drive 등) 사용 가능, prompts 가 자동 skill 화.

### G10.1 — Credential store

- `service/credentials/{__init__.py, install.py}` (신규)
- `FileCredentialStore` 사용, `~/.geny/credentials.json` 저장 (OS keychain 은 deferred)
- MCPManager 에 주입 (`attach_credential_store`)

**테스트:** `tests/service/credentials/test_install.py`

### G10.2 — OAuth flow

- `service/oauth/{flow.py, callback_server.py}` (신규)
- `geny_executor.tools.mcp.oauth.OAuthFlow` 활용
- 신규 endpoint: `POST /api/mcp/servers/{name}/auth/start` → authorization URL 반환, `GET /oauth/callback` → token 저장
- frontend: NEEDS_AUTH 상태 서버 우측에 "Authorize" 버튼

**테스트:** `tests/service/oauth/test_flow.py` (mock authorization)

### G10.3 — `mcp://` URI scheme handler

- `service/mcp_uri.py` (신규) — frontend 가 `mcp://server/resource` 를 클릭 시 backend 로 resolve
- 신규 endpoint: `GET /api/mcp/resources?uri=mcp://...`

**테스트:** `tests/service/test_mcp_uri.py`

### G10.4 — MCP prompts → Skills bridge

- `service/skills/install.py` 에 `mcp_prompts_to_skills(mcp_manager)` 호출 추가 (G7.3 위에서)
- 동기화 timing: MCP server connect 직후, registry rebuild

**테스트:** `tests/service/skills/test_mcp_bridge.py`

### G10 Done definition

- Google Drive MCP 연결 → 브라우저 consent → 성공
- 연결된 MCP 의 prompt 가 `/api/skills/list` 에 자동 표기

---

## G11 — Phase 10 Observability dashboard

**Goal:** EventBus 의 모든 이벤트가 가시화. 운영자가 stage 실행·token·cost·mutation 을 실시간으로 봄.

### G11.1 — Live stage execution grid

- `frontend/src/components/dashboard/StageGrid.tsx` (신규)
- 21 stage cell, 각 cell 에 현재 iteration 의 enter/exit/duration 색상
- `stage.enter / stage.exit` 이벤트 구독

### G11.2 — Token / cost meter (실시간)

- `frontend/src/components/dashboard/TokenMeter.tsx` (신규)
- `token.usage` 이벤트 구독 → 누적 input/output/cache + cost
- 한계 대비 게이지

### G11.3 — Mutation audit log viewer

- `frontend/src/components/dashboard/MutationLog.tsx` (신규)
- `mutation.applied` 이벤트 구독 → 시간순 리스트 + 각 mutation 의 kind/before/after

### G11 Done definition

- Dashboard 페이지 (`/dashboard?session=<id>`) 에서 stage grid + token meter + mutation log 동시 표시
- session 종료 후에도 마지막 상태 유지 (snapshot)

---

## 검증 매트릭스 (cycle 단위)

| Cycle | 검증 항목 | pass 조건 |
|---|---|---|
| G6 | Capability flag + permission + hook | env off → 기존 동작 0 회귀 / env on → deny + hook block 동작 |
| G7 | Crash recovery + Skills | SIGKILL 후 restore 성공 / `~/.geny/skills/test.md` → `/test` 동작 |
| G8 | MCP runtime | runtime add 후 다음 턴 tool 가시 / disable → 즉시 invisible |
| G9 | 11 stage strategy | 각 strategy 통합 테스트 green / vtuber·worker_easy 회귀 0 |
| G10 | OAuth + URI + bridge | Google Drive consent 성공 / MCP prompt → skill list |
| G11 | Dashboard | stage grid live update / token meter ≤ 1s lag |

## Rollback 전략

- G6 (보안): env 토글 off 로 원복
- G7 (recovery/skills): endpoint disable + skills directory 비우기
- G8 (MCP): runtime add 거부 (config 만 사용)
- G9 (stage strategy): preset override 표에서 해당 entry 삭제
- G10 (OAuth): credential store 파일 삭제
- G11 (dashboard): frontend route hide

각 항목이 단독 revert 가능 — 1.0 stability commitment 기준 backward compatible.

## 진행 트래킹

각 PR 머지 후 `progress/<sprint>_<topic>.md` 추가. README 패턴은 `Geny/dev_docs/20260424_1/progress/pr1_archive_legacy.md` 참고.

---

## 부록 A — PR 의존성 그래프

```
G6.1 ──┬─► G6.2
       └─► G6.4 ──► G6.6 (frontend)
G6.3 ──► G6.4
G6.5 ──► G6.6

G7.1 ──► G7.2 (frontend)
G7.3 ──► G7.4 (frontend) ──► G7.5

G8.1 ──┬─► G8.2 ──► G8.3 (frontend)
       └─► G8.4

G9.1 ◄── G8 (MCP runtime)
G9.{2,4,5,6,7,8,9,11} 모두 독립
G9.3 = skip (G6.4 와 동일)
G9.10 = skip (G2.1 에서 wired)

G10.1 ──► G10.2 ──► G10.3
G10.4 ◄── G7.3 + G8 + G10.2

G11.{1,2,3} 모두 독립, 단 EventBus 가 활성이어야
```

## 부록 B — 예상 일정 (solo, 1 PR/일 페이스)

| Cycle | Sprint 수 | 일수 |
|---|---|---|
| G6 | 6 | 6 |
| G7 | 5 | 5 |
| G8 | 4 | 4 |
| G9 | 9 (S7.3/.10 skip 후 잔여) | 9 |
| G10 | 4 | 4 |
| G11 | 3 | 3 |
| **합계** | **31** | **~31 일** |

병렬 (Pair) 시 G9 / G10 / G11 동시 진행 가능 → ~3 주 단축.

## 부록 C — 미진행 항목 정렬 (Phase 9b 잔여)

`analysis/02 #31` (Stage 13 task_registry 미활성) 은 본 cycle 범위 밖. AgentTool spawn 경로 자체가 없는 상태에서 task_registry 만 활성화하면 의미 없음. **별도 Cycle (G12.x)** 로 분리:
- AgentTool / SubagentType (G9.4 결과) 위에서 sub-agent spawn UI + task registry 사용 — Phase 7+9 종합

이 plan 은 `dev_docs/20260425_1` cycle 의 33개 PR 만 담는다. G12.x 는 다음 cycle 에서 분리 작성.
