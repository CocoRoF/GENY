# 01 · Current State Audit

> 본 사이클의 출발점. file:line 인용은 작성 시점(2026-05-17) 기준이며 구현 시 다시 검증한다. 발견된 *버그/wiring gap*은 본 사이클에서 청산.

## 1. geny-executor (v1.21.0)

### 1.1 패키지 구조 (LLM 관련)

```
src/geny_executor/
├── llm_client/
│   ├── base.py              # BaseClient ABC + ClientCapabilities
│   ├── types.py             # APIRequest / APIResponse / ContentBlock / TokenUsage
│   ├── registry.py          # ClientRegistry
│   ├── bridge.py            # ProviderBackedClient (legacy APIProvider 어댑터 — 제거 대상)
│   ├── anthropic.py
│   ├── openai.py / google.py / vllm.py
│   └── translators/
│       ├── __init__.py
│       └── _canonical.py
├── core/
│   ├── config.py            # ModelConfig, PipelineConfig
│   ├── environment.py       # PipelineManifest, StageManifestEntry
│   ├── mutation.py          # PipelineMutator (restore from manifest)
│   ├── pipeline.py          # Pipeline.from_manifest_async, _resolve_llm_client
│   ├── errors.py            # APIError, ErrorCategory
│   └── stage.py             # Stage base + resolve_model_config
├── stages/
│   ├── s06_api/             # API stage (Stage 6)
│   └── s12_agent/           # Agent stage (Stage 12)
│       ├── artifact/default/
│       │   ├── stage.py
│       │   └── orchestrators.py    # DelegateOrchestrator (legacy)
│       └── subagent_type.py        # SubagentTypeOrchestrator, Descriptor, Registry
└── skills/
    └── fork.py              # Fork-mode skill runner (ANTHROPIC_API_KEY hardcoded)
```

### 1.2 `BaseClient` + `ClientCapabilities`

`base.py:27` `ClientCapabilities` 현 7 필드 + `drops`. `base.py:48` `BaseClient` 추상 `_send(request, purpose)`. 외부 메서드 `create_message`, `create_message_stream`. `_build_request`에서 capability 체크 후 `feature_unsupported` 이벤트 emit.

### 1.3 `APIRequest` / `APIResponse`

`types.py:18` Anthropic-shape canonical. `types.py:54` 응답 — `content: List[ContentBlock]`, `stop_reason`, `usage`, `model`, `message_id`. 헬퍼 프로퍼티 `.text`, `.tool_calls`, `.thinking_blocks`.

### 1.4 Registry + provider 라우팅

`registry.py` static class. 4 builtin (`anthropic`, `openai`, `google`, `vllm`). lazy factory + `ImportError` rewrap.

### 1.5 Stage 6 — Provider 위치 분리 버그 (★ 본 사이클 청산)

본 audit의 핵심 발견.

```
[Geny default manifest factory]
  default_manifest.py:370-384 → entry.strategies["provider"] = "anthropic"
  (config["provider"] 안 씀)

[Executor restore]
  mutation.py:520-544 → stage_snap.strategies.items() 만 읽음
  (config 안 봄)

[Executor Stage update_config / get_config]
  s06_api/artifact/default/stage.py:226-244 → config["provider"] 읽고/씀

[Geny frontend]
  GlobalSettingsView.tsx:140-150 → apiStage.config.provider 만 읽고 씀
```

**시나리오**: 사용자가 UI에서 provider를 `openai`로 바꿈 → disk: `config={"provider":"openai"}` + `strategies={"provider":"anthropic"}` 공존 → 다음 세션 restore가 strategies를 신뢰 → **UI는 OpenAI 표시, 실제 호출은 Anthropic**. 회복 불가능한 silent divergence.

**원인**: PR-3 → PR-4 migration 중 `APIProvider`를 strategy slot에서 stage-level config로 옮기는 과정에서 restore 경로는 strategies 그대로 두고, get/update만 config로 옮김.

**처리**: 본 사이클이 `config["provider"]` 단일 위치로 통일 + `strategies["provider"]` 코드 완전 제거.

### 1.6 `ModelConfig` + `model_override` 메커니즘

`config.py:13` `ModelConfig` dataclass (model, max_tokens, temperature, top_p, top_k, stop_sequences, thinking_*).

`environment.py:205` `StageManifestEntry.model_override: Optional[Dict[str, Any]]` — stage-level override.

`mutation.py:481-557` 스냅샷/복원 경로:
- 저장: `stage._model_override.to_dict()` → manifest
- 복원: `stage.model_override = ModelConfig.from_dict(stage_snap.model_override)`

`Stage.resolve_model_config(state)`이 override 우선, 없으면 PipelineConfig.model 사용.

**상태**: 메커니즘은 완전히 동작. Geny frontend가 글로벌 model만 노출하고 per-stage override UI를 안 그릴 뿐. → 본 사이클이 UI 추가.

### 1.7 Stage 12 sub-agent 메커니즘 (★ 본 사이클 강화)

#### 구조

```
s12_agent/
├── artifact/default/
│   ├── stage.py             # AgentStage
│   └── orchestrators.py     # DelegateOrchestrator (legacy)
└── subagent_type.py         # SubagentTypeOrchestrator + Descriptor + Registry
```

#### 두 오케스트레이터

**(a) `DelegateOrchestrator`** ([`orchestrators.py:52-89`](../../../../geny-executor/src/geny_executor/stages/s12_agent/artifact/default/orchestrators.py))
- `state.delegate_requests` 리스트의 각 항목에서 `agent_type` 추출
- `self._factory.create(agent_type)` 호출 → `Pipeline` 인스턴스
- 새 `PipelineState` 생성 (`session_id="{parent}-sub-{agent_type}-{uuid}"`)
- `await sub_pipeline.run(task, sub_state)` — **순차** (asyncio.gather 없음)

**(b) `SubagentTypeOrchestrator`** ([`subagent_type.py:134-178`](../../../../geny-executor/src/geny_executor/stages/s12_agent/subagent_type.py))
- `SubagentTypeRegistry`에서 `agent_type`으로 `SubagentTypeDescriptor` lookup
- `_resolve_pipeline()` (line 126-131) — sync/async factory 모두 인정
- descriptor.metadata (description, allowed_tools, model_override)를 결과에 담음
- workspace snapshot threading (line 244-246) — `parent.shared["workspace_snapshot"]` 전파

#### `SubagentTypeDescriptor` 현 schema

`subagent_type.py:84-89`:
```python
@dataclass
class SubagentTypeDescriptor:
    agent_type: str
    factory: PipelineFactory                    # Callable[[], Any]  ← zero-arg
    description: str = ""
    allowed_tools: tuple[str, ...] = ()
    model_override: Optional[str] = None        # "claude-opus-4-7" 등 model id만
    extras: Dict[str, Any] = field(default_factory=dict)
```

**핵심 gap**:
- `provider` 필드 없음. `model_override`만 있고 provider는 sub-pipeline의 자기 manifest에 종속.
- `PipelineFactory = Callable[[], Any]` — zero-arg. spawn 시점에 provider/credentials 주입 불가.
- → 본 사이클이 `provider`, `provider_credentials_extras`, `parallel` 필드 추가 + factory 시그니처를 `Callable[[SubAgentBuildContext], Pipeline]`로 일반화.

#### Sub-agent의 `state.llm_client` 결정 경로

`pipeline.py:1139-1140`:
```python
if state.llm_client is None:
    state.llm_client = self._resolve_llm_client()
```

Sub-pipeline은 fresh `PipelineState`로 시작 (`state.llm_client=None`) → sub-pipeline의 `_resolve_llm_client()`가 자기 stage 6 provider를 새로 빌드. **즉 sub-pipeline의 manifest에 다른 provider가 적혀 있으면 다른 client가 생긴다.**

→ 메커니즘적으로는 **multi-provider sub-agent 가능**. 다만 factory에 그 manifest를 다르게 만들도록 파라미터를 주는 길이 없다 (zero-arg factory).

#### Concurrency

`subagent_type.py:168-178`:
```python
async def orchestrate(self, state):
    sub_results = []
    for raw in state.delegate_requests:
        sub_results.append(await self._dispatch_one(state, raw))
```

**Sequential.** asyncio.gather 같은 fan-out 없음. → 본 사이클이 `descriptor.parallel=True` 옵션으로 fan-out 가능하게.

#### Workspace snapshot threading

`subagent_type.py:237-246` — `parent.shared["workspace_snapshot"]`을 sub_state에 복사. 즉 sub-agent는 parent의 cwd/branch를 본다. 본 사이클은 이걸 그대로 유지.

### 1.8 Geny의 sub-agent unwired 상태 (★ 본 사이클 wire-up)

[`Geny/backend/service/agent_types/registry.py:59-100`](../../../../Geny/backend/service/agent_types/registry.py):

```python
def _placeholder_factory():
    raise NotImplementedError("Sub-agent factory not yet wired.")

DEFAULT_DESCRIPTORS = [
    SubagentTypeDescriptor(
        agent_type="worker",
        factory=_placeholder_factory,
        description="...",
    ),
    # ...
]
```

[`Geny/backend/service/executor/default_manifest.py:424-428`](../../../../Geny/backend/service/executor/default_manifest.py):
```python
StageManifestEntry(
    order=12, name="agent",
    strategies={"orchestrator": "single_agent"},   # ← no-op
    config={"max_delegations": 4},
)
```

**결과**: Geny 환경에서 stage 12는 **`single_agent` orchestrator** (no-op) 사용 → sub-agent 호출 자체가 발생 안 함. 사용자가 UI에서 "delegate" 요청을 보내도 spawn 안 됨.

본 사이클이 청산:
- default manifest stage 12 strategy를 `"subagent_type"`로 교체
- Geny placeholder factory들을 실구현으로 교체 (worker/researcher/summarizer/critic 또는 final 셋)
- 각 factory가 sub-pipeline manifest + 자기 provider 빌드
- UI에서 sub-agent 카탈로그 편집 가능하게

### 1.9 Fork-mode skill의 hardcoded ANTHROPIC_API_KEY (★ 본 사이클 청산)

[`skills/fork.py:106-127`](../../../../geny-executor/src/geny_executor/skills/fork.py):
- fork-mode skill이 sub-pipeline을 돌리지 않고 *직접* `ProviderBackedClient`를 만들어 1턴 호출
- line 106: `api_key = os.environ.get("ANTHROPIC_API_KEY")` — 환경변수에서 직접 읽음
- line 127: anthropic 클라이언트로 직접 호출

**결과**: fork-mode skill은 vendor 무관하게 항상 Anthropic. 사용자가 OpenAI 환경이어도 fork만은 Anthropic으로 돌아감.

본 사이클: fork-mode skill을 `CredentialBundle` 기반으로 재배선. skill descriptor에 `provider: Optional[str]` 추가 (스킬 정의 시 명시), 안 적혀 있으면 parent 환경의 default provider 사용.

### 1.10 ProviderBackedClient (legacy bridge, 제거 대상)

[`llm_client/bridge.py:22-98`](../../../../geny-executor/src/geny_executor/llm_client/bridge.py) — PR-3 → PR-4 마이그레이션용 어댑터. APIProvider를 BaseClient로 wrap. 본 사이클은 *clean break*이므로 이 bridge 클래스 제거 + `Pipeline._resolve_llm_client`의 두 번째 fallback (line 1160-1173) 삭제.

### 1.11 Tests

- `tests/unit/test_llm_client_base.py` — EchoClient 기반 capability 게이팅
- `tests/unit/test_llm_client_registry.py` — 4 builtin + custom register
- `tests/unit/test_llm_client_state.py` — state.llm_client / attach_runtime
- `tests/llm_client/` — 빈 디렉토리 (conformance harness가 들어갈 자리)

본 사이클 추가: `tests/llm_client/conformance/`, `tests/llm_client/unit/`, `tests/_fixtures/`.

## 2. Geny (현재 main)

### 2.1 Provider 결정 경로 (현 상태)

```
user/role
  ↓
role_defaults.resolve_env_id(role, env_id)
  ↓
env_id ("template-worker-env" | "template-vtuber-env")
  ↓
EnvironmentService.load_manifest(env_id)
  ↓
Manifest:
  stages[6].strategies["provider"] = "anthropic"   ← restore가 신뢰
  stages[6].config = {}                            ← frontend가 씀
  stages[12].strategies["orchestrator"] = "single_agent"   ← no-op
  ↓
AgentSessionManager:
  api_key = ANTHROPIC_API_KEY only (HARDCODED)
  ↓
EnvironmentService.instantiate_pipeline(env_id, api_key=…)
  ↓
Pipeline.from_manifest_async(manifest, api_key=…)
  ↓
Stage 6._resolve_client → ClientRegistry.get("anthropic")
```

**Gap (본 사이클 청산)**:
1. UI provider 변경이 실제 호출에 반영 안 됨 (1.5 참조)
2. ANTHROPIC_API_KEY hardcoded — OpenAI/Google 선택 시 빈 키 (silent bug)
3. Stage 12가 no-op → multi-agent 미동작
4. CLI 백엔드 자체가 옵션 외 (registry에 없음)

### 2.2 Settings layer

[`backend/service/settings/sections.py:122`](../../../../Geny/backend/service/settings/sections.py):
```python
class ModelConfigSection(BaseModel):
    provider: Optional[str] = None
    name:     Optional[str] = None
    max_tokens:  Optional[int] = Field(None, ge=1)
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)
    top_p:       Optional[float] = Field(None, ge=0.0, le=1.0)
    base_url:    Optional[str] = None
```

`APIConfig` (별도)는 `anthropic_api_key`만 가짐. OpenAI/Google 자격증명 필드 없음. CLI 백엔드 sections 없음.

### 2.3 21-Stage manifest (default)

[`default_manifest.py`](../../../../Geny/backend/service/executor/default_manifest.py) — 21개 `StageManifestEntry`. 활성 stage: 1,2,3,4,5,6,7,8,9,10,12,14,16,17,18,21. 비활성 default: 11(tool_review), 13(task_registry), 15(hitl), 19(summarize), 20(persist).

Stage 6: provider는 strategies, 다른 모든 strategy도 그대로.
Stage 12: orchestrator는 `single_agent` (no-op).

### 2.4 Frontend

- [`modelCatalog.ts`](../../../../Geny/frontend/src/lib/modelCatalog.ts) — 4 provider 카탈로그.
- [`GlobalSettingsView.tsx`](../../../../Geny/frontend/src/components/env_management/GlobalSettingsView.tsx) — stage 6 `config["provider"]` 읽기/쓰기 (단 disk의 strategies와 어긋남).
- per-stage model_override UI 없음.
- sub-agent 카탈로그 UI 없음.

## 3. CLI 백엔드 surface (벤더 사실 그대로)

### 3.1 `claude` (Claude Code CLI)

- 비대화형: `claude -p "..." [--output-format text|json|stream-json]`
- bidirectional streaming: `--input-format stream-json --output-format stream-json --include-partial-messages`
- 주요 옵션:
  - `--model` (alias 또는 full ID)
  - `--system-prompt` / `--append-system-prompt`
  - `--allowedTools` / `--disallowedTools`
  - `--mcp-config` (file or JSON string)
  - `--session-id` / `-c` / `-r`
  - `--json-schema` (structured output)
  - `--max-budget-usd`
  - `--effort <low|medium|high|xhigh|max>` (thinking)
  - `--bare` (no hooks/auto-memory/LSP)
  - `--permission-mode`
- 인증: `claude auth` / `claude setup-token` / `ANTHROPIC_API_KEY` / `apiKeyHelper` (in --settings)
- stream-json 라인 종류: `system, user, assistant (delta|full), result, error`

### 3.2 `gh copilot` (GitHub Copilot CLI)

- 비대화형: `gh copilot -p "..." --allow-tool 'shell(git)'`
- 인증: `gh auth login` + Copilot subscription
- stream/structured 미지원 → stdout plain text
- 도구는 `--allow-tool` allowlist만

### 3.3 미설치 머신에서의 동작

작성자 머신: `claude` 있음 (`/home/hrjang/.local/bin/claude`), `gh` 있음, `copilot` 본체 미설치 (`gh copilot` 첫 실행 시 다운로드 프롬프트). → CLI 백엔드 사용자는 직접 설치해야 함. Geny는 health check로만 점검.

## 4. Capability 매트릭스 (사실)

| Capability | anthropic | openai | google | vllm | claude_code_cli | copilot_cli |
|---|---|---|---|---|---|---|
| thinking | ✅ native | ⚠ reasoning_effort | ⚠ thinking_config | ❌ | ✅ `--effort` | ❌ |
| tools | ✅ | ✅ | ✅ | ⚠ off-default | ✅ built-in+MCP | ⚠ `--allow-tool` |
| tool_choice | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| streaming | ✅ | ✅ | ✅ | ✅ | ✅ stream-json | ❌ |
| stop_sequences | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| top_k | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| system_prompt | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠ prepend |
| structured (JSON schema) | partial | ✅ | ✅ | partial | ✅ `--json-schema` | ❌ |
| session continuity | host-managed | host-managed | host-managed | host-managed | ✅ `--session-id` | ❌ |
| MCP passthrough | host attach | host attach | host attach | host attach | ✅ `--mcp-config` | ❌ |
| budget limit | post-hoc | post-hoc | post-hoc | post-hoc | ✅ `--max-budget-usd` | ❌ |
| token usage | ✅ | ✅ | ✅ | ⚠ partial | ✅ | ❌ |
| cost usage | post-hoc | post-hoc | post-hoc | post-hoc | ✅ | ❌ |

본 사이클이 추가하는 `ClientCapabilities` 9 필드는 이 매트릭스의 직접 매핑.

## 5. 사이클 진입 전 청산해야 할 부채 요약

| # | 부채 | 위치 | 처리 |
|---|---|---|---|
| 1 | provider 위치 분리 | manifest.config vs strategies | `config["provider"]`로 통일, strategies에서 완전 제거 |
| 2 | `Pipeline.from_manifest_async(api_key=str)` 단일 자격증명 경로 | `pipeline.py` | `credentials=CredentialBundle` 단일 시그니처로 교체 |
| 3 | `ProviderBackedClient` legacy bridge | `bridge.py` | 제거 |
| 4 | Geny `ANTHROPIC_API_KEY` hardcoded | `agent_session_manager.py:643-652` | `CredentialBundleBuilder` 빌드 |
| 5 | Geny `APIConfig`에 openai/google 키 없음 | `settings/sections.py` | 필드 추가 |
| 6 | Stage 12 orchestrator no-op | `default_manifest.py:424-428` | `subagent_type`로 교체 |
| 7 | Geny `_placeholder_factory(NotImplementedError)` | `agent_types/registry.py` | 실구현으로 교체 |
| 8 | `SubagentTypeDescriptor` provider 필드 부재 | `subagent_type.py:84-89` | `provider`, `provider_credentials_extras`, `parallel` 추가 |
| 9 | `PipelineFactory` zero-arg | `subagent_type.py:57` | `Callable[[SubAgentBuildContext], Pipeline]`로 변경 |
| 10 | `SubagentTypeOrchestrator` sequential만 | `subagent_type.py:168-178` | `descriptor.parallel=True` 시 asyncio.gather |
| 11 | Fork-mode skill ANTHROPIC_API_KEY hardcoded | `skills/fork.py:106-127` | `CredentialBundle` 기반 재배선 |
| 12 | Frontend per-stage model_override UI 없음 | `GlobalSettingsView.tsx` | per-stage 패널 추가 |
| 13 | Frontend sub-agent 카탈로그 없음 | (전무) | 신규 UI |
| 14 | CLI 백엔드 자체 부재 | executor + Geny 양쪽 | 신규 추가 |
