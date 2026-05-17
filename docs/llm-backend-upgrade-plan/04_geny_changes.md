# 04 · `Geny` Changes

> back-compat 없음. 기존 manifest는 **재작성**, 기존 wiring은 **교체**, placeholder factory는 **제거**.

## 1. 최종 모듈 트리 (Geny 변경 부분)

```
backend/service/
├── settings/
│   ├── sections.py                     # APIConfig 확장, CLI sections, SubagentsSection
│   ├── install.py                      # 신규 sections 등록
│   └── credentials.py                  # NEW: CredentialBundleBuilder
├── agent_types/
│   ├── registry.py                     # placeholder 제거, default seed로 교체
│   ├── factories.py                    # NEW: make_default_subagent_pipeline, factory generator
│   └── seed.py                         # NEW: default 4 sub-agent seed
├── environment/
│   ├── service.py                      # instantiate_pipeline 시그니처 정리
│   └── templates.py                    # default env들이 새 manifest 사용
├── executor/
│   ├── agent_session_manager.py        # credentials + subagent_registry 주입
│   └── default_manifest.py             # 21-stage 재작성 (config['provider'] 사용, stage 12 활성)
├── health/
│   └── llm_backends.py                 # NEW
└── api/
    ├── settings_cli_backends.py        # NEW: PUT /api/settings/cli_backends/*
    ├── settings_subagents.py           # NEW: GET/POST /api/settings/subagents
    └── health.py                       # /api/health/llm_backends 라우트 추가

frontend/src/
├── lib/
│   ├── modelCatalog.ts                 # 6 provider
│   └── api/
│       ├── llmBackends.ts              # NEW
│       └── subagents.ts                # NEW
├── components/
│   ├── env_management/
│   │   ├── GlobalSettingsView.tsx      # kind=cli 핸들링
│   │   ├── StageEditorView.tsx         # model_override + provider_override
│   │   ├── ProviderPicker.tsx          # 6 provider
│   │   └── CapabilityBadges.tsx        # NEW
│   ├── settings/
│   │   ├── CLIBackendSettings.tsx      # NEW
│   │   └── SubagentCatalogView.tsx     # NEW
│   └── env_management/
│       └── stage_panels/               # NEW: per-stage panel set
```

## 2. Settings

### 2.1 sections.py 최종

[02 §14](./02_target_architecture.md#14-geny-settings-final) 그대로:
- `APIConfig` (anthropic/openai/google API keys)
- `ModelConfigSection` (global default)
- `CLIBackendClaudeCodeSection`
- `CLIBackendCopilotSection`
- `SubagentEntry`, `SubagentsSection`

### 2.2 install.py

```python
register_section("api",                              APIConfig)
register_section("model",                            ModelConfigSection)
register_section("cli_backends.claude_code",         CLIBackendClaudeCodeSection)
register_section("cli_backends.copilot",             CLIBackendCopilotSection)
register_section("subagents",                        SubagentsSection)
```

### 2.3 credentials.py (NEW)

[02 §15](./02_target_architecture.md#15-geny-credentialbundlebuilder-final) 그대로.

## 3. AgentSessionManager 재배선

`backend/service/executor/agent_session_manager.py` — 기존 `ANTHROPIC_API_KEY` 추출 코드 (line 643-705 영역) **전부 삭제**하고:

```python
async def create_agent_session(self, request: CreateAgentSessionRequest) -> AgentSession:
    env_id = resolve_env_id(request.role, request.env_id)

    # 1) Build credentials bundle
    cm = get_config_manager()
    credentials = CredentialBundleBuilder(cm).build()

    # 2) Build subagent registry
    subagent_registry = SubagentRegistryBuilder(cm).build()

    # 3) Manifest preflight: validate provider references
    primary = self._extract_primary_provider(env_id)
    try:
        credentials.require(primary)
    except ConfigError as e:
        raise SessionCreateError(
            f"환경 '{env_id}'의 Stage 6 provider '{primary}'의 자격증명이 누락되었습니다. "
            f"Settings → '{provider_to_settings_section(primary)}' 에서 설정해 주세요. ({e})"
        ) from e

    # 4) Preflight CLI backends (best-effort)
    self._preflight_providers(self._referenced_providers(env_id), credentials)

    # 5) Instantiate pipeline
    prebuilt = await self._environment_service.instantiate_pipeline(
        env_id,
        credentials=credentials,
        subagent_registry=subagent_registry,
        adhoc_providers=adhoc_providers,
    )

    # 6) Metadata
    session = self._build_session(...)
    session.metadata["llm_provider"] = primary
    session.metadata["llm_provider_overrides"] = self._collect_overrides(env_id)
    session.metadata["subagent_types"] = [d.agent_type for d in subagent_registry.descriptors]
    return session
```

helper들:
- `_extract_primary_provider(env_id)`: manifest 로드 후 `stages[6].config["provider"]` 추출. strategies 안 봄.
- `_referenced_providers(env_id)`: 모든 stage의 `config.provider` + `config.provider_override` + subagent registry의 provider들 합집합.
- `_preflight_providers(names, creds)`: CLI 백엔드면 binary 존재 best-effort 확인.

## 4. EnvironmentService 변경

```python
async def instantiate_pipeline(
    self,
    env_id: str,
    *,
    credentials: CredentialBundle,                  # required
    subagent_registry: SubagentTypeRegistry | None = None,
    strict: bool = True,
    adhoc_providers: Sequence[Any] = (),
) -> Pipeline:
    manifest = self.load_manifest(env_id)
    return await Pipeline.from_manifest_async(
        manifest,
        credentials=credentials,
        subagent_registry=subagent_registry,
        strict=strict,
        adhoc_providers=adhoc_providers,
    )
```

`api_key` 인자 **없음**. legacy migration 코드 (`_migrate_legacy_mock_provider`) **삭제**.

## 5. default_manifest.py 재작성

[02 §17](./02_target_architecture.md#17-geny-default-manifest-final-re-written) 그대로. 핵심:
- Stage 6: `config={"provider": "anthropic"}`. `strategies`는 retry/router만.
- Stage 12: `strategies={"orchestrator": "subagent_type"}`. `config={"max_delegations": 4}`. **활성화.**
- 다른 stage는 그대로지만 모든 provider 키 위치를 `config["provider"]`로 통일.

Worker/VTuber preset은 active 플래그 + tool roster 차이만. Provider는 worker가 anthropic, vtuber도 anthropic default — 사용자가 settings에서 변경.

## 6. Sub-agent factory 실구현

### 6.1 `agent_types/factories.py` (NEW)

```python
async def make_default_subagent_pipeline(ctx: SubAgentBuildContext) -> Pipeline:
    desc = ctx.descriptor

    # Build a sub-pipeline manifest based on the parent's 21-stage template
    sub_manifest = build_subagent_base_manifest(
        allowed_tools=desc.allowed_tools,
        enable_summarize=False,        # sub-agent는 light-weight
        enable_persist=False,
    )

    provider = desc.provider or "anthropic"
    sub_manifest = patch_stage_provider(sub_manifest, stage_order=6, provider=provider)

    if desc.model_override is not None:
        sub_manifest = patch_global_model(sub_manifest, desc.model_override)

    # Nested sub-agent 차단
    sub_manifest = force_orchestrator(sub_manifest, stage_order=12, value="single_agent")

    return await Pipeline.from_manifest_async(
        sub_manifest,
        credentials=ctx.credentials,
        subagent_registry=None,
        strict=True,
    )


def make_subagent_factory(entry: SubagentEntry) -> PipelineFactory:
    """settings.subagents entry → factory."""
    async def factory(ctx: SubAgentBuildContext) -> Pipeline:
        return await make_default_subagent_pipeline(ctx)
    return factory
```

helper 들:
- `build_subagent_base_manifest(...)` — default 21-stage 복제.
- `patch_stage_provider(manifest, stage_order, provider)` — manifest.stages[N].config["provider"] 설정.
- `patch_global_model(manifest, model_config)` — manifest.model 설정.
- `force_orchestrator(manifest, stage_order, value)` — manifest.stages[N].strategies["orchestrator"] 설정.

### 6.2 `agent_types/seed.py` (NEW)

```python
DEFAULT_SUBAGENT_SEED: list[SubagentEntry] = [
    SubagentEntry(
        agent_type="worker",
        description="General-purpose helper that inherits parent provider.",
        provider=None,            # null = parent와 동일
        allowed_tools=["Read", "Write", "Bash"],
        parallel=False, max_concurrent=1,
    ),
    SubagentEntry(
        agent_type="researcher",
        description="Deep research with web access.",
        provider="anthropic",
        model="claude-opus-4-7",
        allowed_tools=["WebFetch", "WebSearch", "Read"],
        parallel=True, max_concurrent=2,
    ),
    SubagentEntry(
        agent_type="summarizer",
        description="Cheap summarization.",
        provider="openai",
        model="gpt-4o-mini",
        allowed_tools=[],
        parallel=True, max_concurrent=4,
    ),
    SubagentEntry(
        agent_type="critic",
        description="Code-aware review using Claude Code CLI.",
        provider="claude_code_cli",
        allowed_tools=["Read"],
        parallel=False, max_concurrent=1,
    ),
]
```

부트 시 seed가 settings에 없으면 자동 등록 (one-time bootstrap). 사용자가 삭제/편집 가능.

### 6.3 `agent_types/registry.py` 재작성

기존 `_placeholder_factory` + `DEFAULT_DESCRIPTORS` **전부 삭제**.

```python
class SubagentRegistryBuilder:
    def __init__(self, cm: ConfigManager): self._cm = cm

    def build(self) -> SubagentTypeRegistry:
        section = self._cm.load_section(SubagentsSection)
        # Bootstrap if empty
        if not section.items:
            section = SubagentsSection(items=list(DEFAULT_SUBAGENT_SEED))
            self._cm.save_section("subagents", section.model_dump())

        reg = SubagentTypeRegistry()
        for entry in section.items:
            desc = SubagentTypeDescriptor(
                agent_type=entry.agent_type,
                factory=make_subagent_factory(entry),
                description=entry.description,
                allowed_tools=tuple(entry.allowed_tools),
                provider=entry.provider,
                model_override=ModelConfig(model=entry.model) if entry.model else None,
                parallel=entry.parallel,
                max_concurrent=entry.max_concurrent,
                extras=entry.extras,
            )
            reg.register(desc)
        return reg
```

## 7. Health check

`backend/service/health/llm_backends.py` (NEW):

```python
class LLMBackendHealthReport(BaseModel):
    provider: str
    available: bool
    detail: Optional[str] = None
    binary_path: Optional[str] = None
    binary_version: Optional[str] = None
    auth_ok: Optional[bool] = None

async def check_anthropic(creds) -> LLMBackendHealthReport: ...
async def check_openai(creds)    -> LLMBackendHealthReport: ...
async def check_google(creds)    -> LLMBackendHealthReport: ...
async def check_vllm(creds)      -> LLMBackendHealthReport: ...   # base_url ping
async def check_claude_code_cli(creds) -> LLMBackendHealthReport:
    """detect_binary + `claude --version` + bare-mode probe."""
async def check_copilot_cli(creds) -> LLMBackendHealthReport:
    """detect_binary('gh') + `gh auth status` + `gh extension list | grep copilot`."""

async def check_all() -> List[LLMBackendHealthReport]: ...
```

라우트: `GET /api/health/llm_backends`.

## 8. API 라우트

### 8.1 CLI Backends 라우트 (`settings_cli_backends.py`)

- `GET  /api/settings/cli_backends`              → 두 섹션 합쳐 반환
- `PUT  /api/settings/cli_backends/claude_code`  → CLIBackendClaudeCodeSection patch
- `PUT  /api/settings/cli_backends/copilot`      → CLIBackendCopilotSection patch
- `POST /api/settings/cli_backends/claude_code/health`  → ad-hoc health check
- `POST /api/settings/cli_backends/copilot/health`      → ad-hoc health check

### 8.2 Subagents 라우트 (`settings_subagents.py`)

- `GET  /api/settings/subagents`         → SubagentsSection
- `POST /api/settings/subagents`         → 전체 replace
- `PUT  /api/settings/subagents/{type}`  → 단건 upsert
- `DELETE /api/settings/subagents/{type}`

## 9. Frontend

### 9.1 modelCatalog.ts

```typescript
export type ProviderKind = 'api' | 'cli';

export type ProviderId =
  | 'anthropic' | 'openai' | 'google' | 'vllm'
  | 'claude_code_cli' | 'copilot_cli';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  freeForm: boolean;
  requiresInstall?: boolean;
  installHelp?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic',       label: 'Anthropic API',        kind: 'api', freeForm: false },
  { id: 'openai',          label: 'OpenAI API',           kind: 'api', freeForm: false },
  { id: 'google',          label: 'Google Gemini',        kind: 'api', freeForm: false },
  { id: 'vllm',            label: 'vLLM (self-host)',     kind: 'api', freeForm: true },
  { id: 'claude_code_cli', label: 'Claude Code (CLI)',    kind: 'cli', freeForm: true,
    requiresInstall: true, installHelp: 'native installer or npm @anthropic-ai/claude-code' },
  { id: 'copilot_cli',     label: 'GitHub Copilot (CLI)', kind: 'cli', freeForm: true,
    requiresInstall: true, installHelp: 'gh extension install github/gh-copilot' },
];

export const MODEL_CATALOG: Record<ProviderId, ModelOption[]> = {
  anthropic: [/* claude-sonnet-4-6, claude-opus-4-7, ... */],
  openai:    [/* gpt-4o, gpt-4o-mini, o3, ... */],
  google:    [/* gemini-2.0-flash, gemini-1.5-pro, ... */],
  vllm:      [],
  claude_code_cli: [
    { id: 'sonnet', label: 'Claude Sonnet (alias)' },
    { id: 'opus',   label: 'Claude Opus (alias)' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (pinned)' },
    { id: 'claude-opus-4-7',   label: 'Opus 4.7 (pinned)' },
  ],
  copilot_cli: [
    { id: 'default', label: 'Copilot default (server-chosen)' },
  ],
};
```

### 9.2 GlobalSettingsView.tsx

- ProviderPicker (6 provider, kind 분기)
- ModelPicker (provider별 카탈로그 또는 free-form)
- CapabilityBadges 패널 (선택된 provider의 supports_* 시각화)
- (CLI provider일 때) Health check 결과 banner + "Open CLI backend settings" 링크

provider 변경 시 `manifest.stages[6].config["provider"]`만 patch. strategies는 안 건드림.

### 9.3 StageEditorView.tsx

각 stage row에 collapsible 패널:
- **Model override** — full ModelConfig 필드들 (model, max_tokens, temperature, top_p, top_k, stop_sequences, thinking_*).
- **Provider override** — 기본은 "use Stage 6 provider", 토글하면 ProviderPicker + ModelPicker.

Stage 6은 provider 필드가 mandatory, override 패널 없음 (자기 자신이 primary).

다른 LLM-호출 stage들 (2, 11, 14, 18, 19)은 provider_override 패널 권장 표시.

### 9.4 CLIBackendSettings.tsx (NEW)

Settings 페이지에 카드 2개:
- **Claude Code CLI** 카드: enabled / binary_path / workspace_root / bare_mode / permission_mode / max_budget_usd / api_key (override) / settings_path / mcp_config / allow_tools / disallow_tools / extra_args
- **GitHub Copilot CLI** 카드: enabled / gh_binary_path / allow_tools / cwd / extra_args

각 카드 하단에 **Run health check** 버튼 + 결과 표시 (binary path, version, auth status).

### 9.5 SubagentCatalogView.tsx (NEW)

Settings 페이지에 sub-agent 카탈로그:
- 표 형태: agent_type, description, provider, model, allowed_tools, parallel, max_concurrent.
- 각 row 인라인 편집.
- "Add sub-agent" 버튼 → 신규 row.
- "Reset to defaults" 버튼 → DEFAULT_SUBAGENT_SEED 재적용 (확인 모달).

### 9.6 api 클라이언트

```typescript
// frontend/src/lib/api/llmBackends.ts
export async function fetchBackendHealth(): Promise<LLMBackendHealthReport[]> { ... }
export async function updateCLIBackend(
  which: 'claude_code'|'copilot', patch: Partial<CLIBackendSettings>,
): Promise<void> { ... }
export async function runBackendHealthCheck(
  which: 'claude_code'|'copilot',
): Promise<LLMBackendHealthReport> { ... }

// frontend/src/lib/api/subagents.ts
export async function fetchSubagents(): Promise<SubagentEntry[]> { ... }
export async function upsertSubagent(entry: SubagentEntry): Promise<void> { ... }
export async function deleteSubagent(agentType: string): Promise<void> { ... }
```

## 10. 자격증명 누락 UX

`AgentSessionManager.create_agent_session`에서 자격증명 누락 시 한국어 메시지:

```
선택한 환경 'template-worker-env'의 Stage 6는
provider 'claude_code_cli'를 사용하도록 설정되어 있지만
Claude Code CLI binary를 찾을 수 없습니다.

다음 중 하나를 수행해 주세요:
1) Settings → 'CLI Backends → Claude Code'에서 enabled on + binary 경로 지정
2) 시스템에 claude CLI 설치 후 `which claude` 확인
3) 환경의 Stage 6 provider를 다른 provider로 변경

자세히: /settings/cli-backends
```

Sub-agent 자격증명 누락도 동일 메시지 패턴.

## 11. 메트릭 / 로깅

session.metadata에 기록:
- `llm_provider` (primary)
- `llm_provider_overrides` (per-stage overrides 목록)
- `subagent_types` (등록된 sub-agent 타입들)
- `subagent_runs` (sub-agent 실행 결과 — 사이클 내 누적)

Prometheus 메트릭 prefix:
- `geny.llm.calls{provider,stage,purpose}`
- `geny.llm.spawn_duration_ms{provider}` (CLI 한정)
- `geny.llm.cost_usd{provider}` (cost_usage 지원 시)
- `geny.subagent.runs{agent_type,provider,success}`
- `geny.subagent.duration_ms{agent_type,provider}`

## 12. Geny dependency

`Geny/requirements.txt` (또는 pyproject) — `geny-executor>=2.0.0,<2.1.0`. 본 사이클이 v2.0.0 릴리즈.

## 13. 영향 표면

| API | 변경 |
|---|---|
| `POST /api/sessions` body | 변경 없음 |
| `GET/PUT /api/settings/model` | provider 도메인 확장 (6개) |
| `GET/PUT /api/settings/cli_backends/*` | NEW |
| `GET/POST/PUT/DELETE /api/settings/subagents` | NEW |
| `GET /api/health/llm_backends` | NEW |
| `instantiate_pipeline(api_key=...)` | **삭제** |
| `instantiate_pipeline(credentials=, subagent_registry=)` | required |
| ProviderId enum | 4 → 6 (TS exhaustive switch 추적 필요) |
| Manifest `stages[N].strategies["provider"]` | 거부 (executor ConfigError) |
| Manifest `stages[N].config["provider"]` | single source |

## 14. 호환 검증 체크리스트

- [ ] 기본 환경 (worker, vtuber) 세션 생성 — anthropic provider 정상 동작
- [ ] settings → model.provider = "openai" + OPENAI_API_KEY → 정상 응답
- [ ] settings → model.provider = "claude_code_cli" + binary 있는 머신 → 정상 응답 + 스트리밍
- [ ] CLI binary 부재 머신에서 한국어 안내
- [ ] Stage 12 sub-agent 실행 — 4 default seed 등록 후 delegate 호출 정상 spawn
- [ ] researcher (parallel=True) + summarizer (parallel=True) 동시 호출 시 fan-out 확인
- [ ] researcher provider="anthropic" 사용 시 sub-pipeline state.llm_client.provider == "anthropic"
- [ ] Frontend e2e: 6 provider 모두 선택 가능, sub-agent UI 편집 가능
- [ ] `/api/health/llm_backends` 6 provider 보고
- [ ] Sub-agent에서 nested delegate 요청 시 no-op (차단 확인)
