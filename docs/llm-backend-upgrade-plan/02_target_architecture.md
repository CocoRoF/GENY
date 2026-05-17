# 02 · Target Architecture

> 사이클 종료 시점의 end state. 본 문서는 *최종 형태*만 기술하며, "어떻게 거기까지 가는가"는 [03_executor_changes.md](./03_executor_changes.md) / [04_geny_changes.md](./04_geny_changes.md) / [07_rollout_phases.md](./07_rollout_phases.md) 참조.

## 1. 30-second mental model

```
┌──────────────────────────────────────────────────────────────────┐
│ Geny                                                             │
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ settings.json / DB                                           ││
│ │   api.{anthropic,openai,google}_api_key                      ││
│ │   model.{provider, name, max_tokens, ...}                    ││
│ │   cli_backends.claude_code.{binary_path, ...}                ││
│ │   cli_backends.copilot.{...}                                 ││
│ │   subagents[].{agent_type, provider, model, ...}             ││
│ └──────────────────────────────────────────────────────────────┘│
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ Manifest (per env_id, 21 stages)                             ││
│ │   stages[6].config["provider"]   = "anthropic"               ││
│ │   stages[N].config["provider_override"] (optional)            ││
│ │   stages[N].model_override (optional)                         ││
│ │   stages[12].strategies["orchestrator"] = "subagent_type"    ││
│ └──────────────────────────────────────────────────────────────┘│
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ AgentSessionManager.create_agent_session                     ││
│ │   1) build CredentialBundle from settings                    ││
│ │   2) build SubagentTypeRegistry from settings.subagents      ││
│ │   3) instantiate_pipeline(env_id, credentials=, registry=)   ││
│ └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────┐
│ geny-executor                                                    │
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ Pipeline.from_manifest_async(manifest, *, credentials,       ││
│ │                              subagent_registry, ...)         ││
│ │   reads stages[N].config["provider"] (single location)       ││
│ │   ClientRegistry.get(provider)(**creds.get(provider))        ││
│ └──────────────────────────────────────────────────────────────┘│
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ ClientRegistry (6 builtin + open register)                   ││
│ │   anthropic / openai / google / vllm                         ││
│ │   claude_code_cli / copilot_cli                              ││
│ └──────────────────────────────────────────────────────────────┘│
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ BaseClient (unchanged surface, capabilities extended)        ││
│ └──────────────────────────────────────────────────────────────┘│
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ _cli_runtime.py                                              ││
│ │   CLIProcessRunner / stream-json parser / kill-tree / env    ││
│ └──────────────────────────────────────────────────────────────┘│
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ Stage 12 SubagentTypeOrchestrator                            ││
│ │   reads SubagentTypeDescriptor.{provider, parallel, ...}     ││
│ │   builds sub-pipeline via factory(SubAgentBuildContext)      ││
│ │   spawns sequential OR parallel (descriptor.parallel)        ││
│ └──────────────────────────────────────────────────────────────┘│
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ Fork-mode skill runner (uses CredentialBundle, not env)      ││
│ └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

## 2. `ClientCapabilities` (final)

```python
@dataclass(frozen=True)
class ClientCapabilities:
    supports_thinking:           bool = False
    supports_tools:              bool = False
    supports_streaming:          bool = True
    supports_tool_choice:        bool = False
    supports_stop_sequences:     bool = True
    supports_top_k:              bool = False
    supports_system_prompt:      bool = True
    supports_structured_output:  bool = False
    supports_session_continuity: bool = False
    supports_mcp_passthrough:    bool = False
    supports_budget_limit:       bool = False
    supports_token_usage:        bool = True
    supports_cost_usage:         bool = False
    is_subprocess:               bool = False
    requires_workspace:          bool = False
    streaming_granularity:       str  = "token"   # "token"|"message"|"none"
    drops:                       tuple[str, ...] = ()
```

## 3. `APIRequest` (final)

기존 필드 그대로 + 다음 두 옵션 필드 추가:

```python
response_format: Optional[Dict[str, Any]] = None
# canonical:
#   {"type": "text"}                          # default
#   {"type": "json_object"}
#   {"type": "json_schema", "json_schema": {...}}

session_hint: Optional[Dict[str, Any]] = None
# canonical:
#   {"session_id": "...", "resume": bool}
```

`metadata`는 그대로 (provider-specific escape hatch).

## 4. `TokenUsage` (final)

```python
@dataclass
class TokenUsage:
    input_tokens:  int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens:     int = 0
    cost_usd:    Optional[float] = None
    duration_ms: Optional[int]   = None
```

## 5. `ErrorCategory` (final, 신규 5종)

```python
class ErrorCategory(StrEnum):
    # ... existing ...
    CLI_NOT_FOUND        = "cli_not_found"
    CLI_AUTH_FAILED      = "cli_auth_failed"
    CLI_TIMEOUT          = "cli_timeout"
    CLI_PROTOCOL_ERROR   = "cli_protocol_error"
    CLI_PERMISSION_DENIED = "cli_permission_denied"
```

Retry policy:
- backoff: `RATE_LIMITED, TIMEOUT, NETWORK, SERVER_ERROR, CLI_TIMEOUT, CLI_PROTOCOL_ERROR`
- fatal: `AUTH, BAD_REQUEST, CLI_NOT_FOUND, CLI_AUTH_FAILED, CLI_PERMISSION_DENIED`

## 6. `_cli_runtime.py` (final)

```python
class CLIProcessRunner:
    def __init__(
        self,
        binary: str,
        *,
        env_whitelist: frozenset[str] = frozenset({"HOME","PATH","USER","LANG","TERM"}),
        env_extras: Mapping[str, str] | None = None,
        cwd: str | None = None,
        timeout_s: float = 300.0,
        kill_grace_s: float = 2.0,
    ) -> None: ...

    async def run_oneshot(self, argv: Sequence[str], *,
                          stdin: bytes | None = None) -> CLIResult: ...

    async def stream(self, argv: Sequence[str], *,
                     stdin_iter: AsyncIterator[bytes] | None = None
                     ) -> AsyncIterator[bytes]: ...

    async def aclose(self) -> None: ...

class CLIResult(NamedTuple):
    returncode: int
    stdout:     bytes
    stderr:     bytes
    duration_ms: int

def scrub_env(parent: Mapping[str,str], allowed: frozenset[str],
              extras: Mapping[str,str]) -> dict[str,str]: ...
def detect_binary(name: str, override: str | None) -> str | None: ...
def parse_stream_json_line(line: bytes) -> dict | None: ...

class CLIBinaryNotFound(Exception): ...
class CLIAuthFailed(Exception): ...
class CLITimeout(Exception): ...
class CLIProtocolError(Exception): ...
```

핵심 디자인:
- `asyncio.create_subprocess_exec(shell=False)`
- `start_new_session=True` (POSIX) — kill-tree 안전
- bounded asyncio.Queue (16 KiB chunks) — backpressure
- env scrub: whitelist 외 누출 차단
- stream-json 라인 단위 파싱, malformed marker

## 7. CLI 클라이언트 (final)

### 7.1 `ClaudeCodeCLIClient`

```python
class ClaudeCodeCLIClient(BaseClient):
    provider = "claude_code_cli"
    capabilities = ClientCapabilities(
        supports_thinking=True,
        supports_tools=True,
        supports_streaming=True,
        supports_tool_choice=False,
        supports_stop_sequences=False,
        supports_top_k=False,
        supports_system_prompt=True,
        supports_structured_output=True,
        supports_session_continuity=True,
        supports_mcp_passthrough=True,
        supports_budget_limit=True,
        supports_token_usage=True,
        supports_cost_usage=True,
        is_subprocess=True,
        requires_workspace=True,
        streaming_granularity="token",
        drops=("tool_choice","stop_sequences","top_k"),
    )

    def __init__(
        self,
        *,
        binary_path: str | None = None,
        workspace_dir: str | None = None,
        api_key: str = "",
        settings_path: str | None = None,
        bare_mode: bool = True,
        max_budget_usd: float | None = None,
        default_permission_mode: str = "default",
        mcp_config: Any | None = None,
        allow_tools: Sequence[str] = (),
        disallow_tools: Sequence[str] = (),
        extra_args: Sequence[str] = (),
        timeout_s: float = 300.0,
        event_sink: Callable | None = None,
    ) -> None: ...
```

- `bare_mode=True` default — deterministic.
- binary 해석: 인자 → `CLAUDE_CODE_BINARY` env → `shutil.which("claude")`.
- workspace_dir 필수 (Geny session workspace).
- MCP config는 dict 또는 path 둘 다 인정.

### 7.2 `CopilotCLIClient`

```python
class CopilotCLIClient(BaseClient):
    provider = "copilot_cli"
    capabilities = ClientCapabilities(
        supports_thinking=False, supports_tools=False, supports_streaming=False,
        supports_tool_choice=False, supports_stop_sequences=False, supports_top_k=False,
        supports_system_prompt=True,        # via prompt prepend
        supports_structured_output=False, supports_session_continuity=False,
        supports_mcp_passthrough=False, supports_budget_limit=False,
        supports_token_usage=False, supports_cost_usage=False,
        is_subprocess=True, requires_workspace=False, streaming_granularity="none",
        drops=("tools","tool_choice","thinking_enabled","stop_sequences","top_k"),
    )

    def __init__(
        self, *,
        gh_binary_path: str | None = None,
        allow_tools: Sequence[str] = (),
        cwd: str | None = None,
        extra_args: Sequence[str] = (),
        timeout_s: float = 180.0,
        event_sink: Callable | None = None,
    ) -> None: ...
```

- streaming 없음 → BaseClient default fallback 사용.
- 인증은 `gh auth status` 사전 점검 (lazy).

## 8. Registry (final)

```python
ClientRegistry.register("anthropic",        _anthropic_factory)
ClientRegistry.register("openai",           _openai_factory)
ClientRegistry.register("google",           _google_factory)
ClientRegistry.register("vllm",             _vllm_factory)
ClientRegistry.register("claude_code_cli",  _claude_code_cli_factory)
ClientRegistry.register("copilot_cli",      _copilot_cli_factory)
```

CLI factories는 stdlib만 사용 → lazy import 불필요. OpenAI/Google는 그대로 lazy.

## 9. Credentials (final)

```python
@dataclass(frozen=True)
class ProviderCredentials:
    api_key: str = ""
    base_url: Optional[str] = None
    default_headers: Optional[Mapping[str, str]] = None
    binary_path: Optional[str] = None
    extras: Mapping[str, Any] = field(default_factory=dict)

    def __repr__(self) -> str:
        # api_key redacted in repr
        return f"ProviderCredentials(api_key=<redacted>, base_url={self.base_url!r}, binary_path={self.binary_path!r})"

@dataclass(frozen=True)
class CredentialBundle:
    by_provider: Mapping[str, ProviderCredentials]

    def get(self, provider: str) -> ProviderCredentials: ...
    def require(self, provider: str) -> ProviderCredentials:
        """missing → ConfigError with provider name."""
```

**`from_legacy_api_key` 같은 헬퍼는 두지 않는다.** 사용자가 명시적으로 만든다.

## 10. Pipeline API (final)

```python
class Pipeline:
    @classmethod
    async def from_manifest_async(
        cls,
        manifest: PipelineManifest,
        *,
        credentials: CredentialBundle,                    # required
        subagent_registry: SubagentTypeRegistry | None = None,
        strict: bool = True,
        adhoc_providers: Sequence[Any] = (),
    ) -> "Pipeline": ...
```

- `api_key: str` 인자 **없음**.
- `subagent_registry` 옵션 — Stage 12에서 사용. None이면 Stage 12 orchestrator 활성화 안 됨.
- `strict=True` 시 manifest가 참조하는 모든 provider가 registry에 있고 credentials도 require 통과해야 함.

### `_resolve_llm_client` (final)

```python
def _resolve_llm_client(self) -> BaseClient | None:
    # 1) attach_runtime(llm_client=...)
    if self._attached_llm_client is not None:
        return self._attached_llm_client
    # 2) Stage 6 config["provider"] (single source of truth)
    api_stage = next((s for s in self._stages if s.name == "api"), None)
    if api_stage is None:
        return None
    provider_name = (api_stage.config or {}).get("provider")
    if not provider_name:
        raise ConfigError("Stage 6 must define config['provider']")
    client_cls = ClientRegistry.get(provider_name)
    creds = self._credentials.require(provider_name)
    return client_cls(**_creds_to_kwargs(provider_name, creds))
```

**`strategies["provider"]` 조회 없음.** ProviderBackedClient fallback도 없음.

## 11. Manifest schema (final)

```python
@dataclass
class StageManifestEntry:
    order: int
    name: str
    active: bool = True
    artifact: str = "default"
    strategies: Dict[str, str] = field(default_factory=dict)         # retry/router/orchestrator slots만 — provider 키 없음
    strategy_configs: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    config: Dict[str, Any] = field(default_factory=dict)
    # config["provider"]            (stage 6에서만; 단일 위치)
    # config["provider_override"]   (stage 6 외 stage에서)
    tool_binding: Optional[Dict[str, Any]] = None
    model_override: Optional[Dict[str, Any]] = None
    chain_order: Dict[str, List[str]] = field(default_factory=dict)
```

규칙:
- `strategies["provider"]`는 어디에서도 쓰지 않는다. 코드에서 그 키를 읽으면 안 된다.
- Stage 6: `config["provider"]` 필수.
- 다른 stage가 다른 provider를 쓰려면 `config["provider_override"]`.

## 12. Stage helper (final)

```python
class Stage:
    def resolve_local_client(self, state) -> BaseClient:
        override = (self.config or {}).get("provider_override")
        if not override:
            return state.llm_client
        cached = self._cache.get("local_client")
        if cached: return cached
        creds = state.runtime.credentials.require(override)
        client_cls = ClientRegistry.get(override)
        client = client_cls(**_creds_to_kwargs(override, creds))
        self._cache["local_client"] = client
        return client

    def resolve_model_config(self, state) -> ModelConfig:
        # already exists; unchanged
        ...
```

Stage 2 / 6 / 11 / 14 / 18 / 19 모두 `resolve_local_client(state)`로 통일.

## 13. Sub-agent system (final)

자세한 deep-dive는 [05_sub_agent_system.md](./05_sub_agent_system.md).

### 13.1 `SubagentTypeDescriptor` (final)

```python
@dataclass
class SubagentTypeDescriptor:
    agent_type: str
    factory: PipelineFactory                          # 새 시그니처 (아래)
    description: str = ""
    allowed_tools: tuple[str, ...] = ()

    provider: Optional[str] = None                    # NEW: sub-pipeline stage 6 provider
    provider_credentials_extras: Mapping[str, Any] = field(default_factory=dict)
    model_override: Optional[ModelConfig] = None      # NEW: ModelConfig (was str)
    parallel: bool = False                            # NEW: orchestrator concurrency hint
    max_concurrent: int = 1                           # NEW: parallel=True일 때 동시 spawn 상한

    extras: Mapping[str, Any] = field(default_factory=dict)
```

### 13.2 `PipelineFactory` (final)

```python
@dataclass(frozen=True)
class SubAgentBuildContext:
    parent_session_id: str
    sub_session_id: str
    credentials: CredentialBundle
    descriptor: SubagentTypeDescriptor
    workspace_snapshot: Optional[Mapping[str, Any]] = None
    parent_state_shared: Mapping[str, Any] = field(default_factory=dict)

PipelineFactory = Callable[[SubAgentBuildContext], Awaitable[Pipeline]]
```

zero-arg legacy 시그니처는 **인정 안 함**. 모든 factory가 새 시그니처 사용.

### 13.3 `SubagentTypeOrchestrator` (final)

```python
async def orchestrate(self, state: PipelineState) -> AgentResult:
    if not state.delegate_requests:
        return AgentResult(delegated=False)

    # Group by descriptor.parallel
    serial, parallel = [], []
    for raw in state.delegate_requests:
        desc = self._registry.get(raw["agent_type"])
        (parallel if desc.parallel else serial).append((raw, desc))

    results = []
    # Serial first (deterministic)
    for raw, desc in serial:
        results.append(await self._dispatch_one(state, raw, desc))
    # Then parallel fan-out (bounded by max_concurrent)
    if parallel:
        sem = asyncio.Semaphore(max(d.max_concurrent for _, d in parallel))
        async def bounded(raw, desc):
            async with sem:
                return await self._dispatch_one(state, raw, desc)
        results.extend(await asyncio.gather(*[bounded(r, d) for r, d in parallel]))

    return AgentResult(delegated=True, results=results)
```

`_dispatch_one`이 `SubAgentBuildContext`를 빌드해서 `await desc.factory(ctx)` 호출.

### 13.4 Fork-mode skill (final)

`skills/fork.py`:

```python
async def run_fork_skill(
    *,
    skill: ForkSkill,
    parent_state: PipelineState,
    credentials: CredentialBundle,
) -> str:
    provider = skill.provider or _infer_from_parent(parent_state)
    creds = credentials.require(provider)
    client_cls = ClientRegistry.get(provider)
    client = client_cls(**_creds_to_kwargs(provider, creds))
    model_cfg = ModelConfig(model=skill.model_override or ...)
    response = await client.create_message(
        model_config=model_cfg,
        messages=[{"role":"user","content":skill.user_message}],
        system=skill.system_prompt,
        purpose=f"fork.{skill.name}",
    )
    return response.text
```

`ANTHROPIC_API_KEY` 직접 참조 코드 **없음**.

## 14. Geny settings (final)

```python
# settings/sections.py

class APIConfig(BaseModel):
    anthropic_api_key: Optional[str] = None
    openai_api_key:    Optional[str] = None
    google_api_key:    Optional[str] = None

class ModelConfigSection(BaseModel):
    provider: Optional[str] = None
    name:     Optional[str] = None
    max_tokens:  Optional[int]   = Field(None, ge=1)
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)
    top_p:       Optional[float] = Field(None, ge=0.0, le=1.0)
    base_url:    Optional[str] = None

class CLIBackendClaudeCodeSection(BaseModel):
    enabled: bool = False
    binary_path: Optional[str] = None
    workspace_root: Optional[str] = None
    bare_mode: bool = True
    default_permission_mode: Literal[...] = "default"
    max_budget_usd: Optional[float] = Field(None, ge=0.0)
    api_key: Optional[str] = None
    settings_path: Optional[str] = None
    mcp_config_inline: Optional[Dict[str, Any]] = None
    mcp_config_path: Optional[str] = None
    extra_args: List[str] = []
    timeout_s: float = Field(300.0, ge=10.0, le=3600.0)
    allow_tools: List[str] = []
    disallow_tools: List[str] = []

class CLIBackendCopilotSection(BaseModel):
    enabled: bool = False
    gh_binary_path: Optional[str] = None
    allow_tools: List[str] = []
    cwd: Optional[str] = None
    extra_args: List[str] = []
    timeout_s: float = Field(180.0, ge=10.0, le=600.0)

class SubagentEntry(BaseModel):
    agent_type: str
    description: str = ""
    provider: Optional[str] = None         # subagent별 provider
    model: Optional[str] = None
    allowed_tools: List[str] = []
    parallel: bool = False
    max_concurrent: int = Field(1, ge=1, le=16)
    extras: Dict[str, Any] = {}

class SubagentsSection(BaseModel):
    items: List[SubagentEntry] = []
```

## 15. Geny `CredentialBundleBuilder` (final)

```python
# backend/service/settings/credentials.py

class CredentialBundleBuilder:
    def __init__(self, cm: ConfigManager): self._cm = cm

    def build(self) -> CredentialBundle:
        api = self._cm.load_config(APIConfig)
        model = self._cm.load_section(ModelConfigSection)
        claude = self._cm.load_section(CLIBackendClaudeCodeSection)
        copilot = self._cm.load_section(CLIBackendCopilotSection)

        bp: dict[str, ProviderCredentials] = {
            "anthropic": ProviderCredentials(
                api_key=api.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")),
            "openai": ProviderCredentials(
                api_key=api.openai_api_key or os.environ.get("OPENAI_API_KEY", "")),
            "google": ProviderCredentials(
                api_key=api.google_api_key or os.environ.get("GOOGLE_API_KEY", "")),
            "vllm": ProviderCredentials(base_url=model.base_url),
        }
        if claude.enabled:
            bp["claude_code_cli"] = ProviderCredentials(
                binary_path=claude.binary_path or shutil.which("claude"),
                api_key=claude.api_key or os.environ.get("ANTHROPIC_API_KEY", ""),
                extras={
                    "workspace_root":          claude.workspace_root,
                    "bare_mode":               claude.bare_mode,
                    "default_permission_mode": claude.default_permission_mode,
                    "max_budget_usd":          claude.max_budget_usd,
                    "settings_path":           claude.settings_path,
                    "mcp_config":              claude.mcp_config_inline or claude.mcp_config_path,
                    "extra_args":              tuple(claude.extra_args),
                    "timeout_s":               claude.timeout_s,
                    "allow_tools":             tuple(claude.allow_tools),
                    "disallow_tools":          tuple(claude.disallow_tools),
                },
            )
        if copilot.enabled:
            bp["copilot_cli"] = ProviderCredentials(
                binary_path=copilot.gh_binary_path or shutil.which("gh"),
                extras={
                    "allow_tools": tuple(copilot.allow_tools),
                    "cwd":         copilot.cwd,
                    "extra_args":  tuple(copilot.extra_args),
                    "timeout_s":   copilot.timeout_s,
                },
            )
        return CredentialBundle(by_provider=bp)
```

## 16. Geny `SubagentRegistryBuilder` (final)

```python
class SubagentRegistryBuilder:
    def __init__(self, cm: ConfigManager): self._cm = cm

    def build(self) -> SubagentTypeRegistry:
        section = self._cm.load_section(SubagentsSection)
        reg = SubagentTypeRegistry()
        for entry in section.items:
            reg.register(SubagentTypeDescriptor(
                agent_type=entry.agent_type,
                factory=make_subagent_factory(entry),    # 04 §6
                description=entry.description,
                allowed_tools=tuple(entry.allowed_tools),
                provider=entry.provider,
                model_override=ModelConfig(model=entry.model) if entry.model else None,
                parallel=entry.parallel,
                max_concurrent=entry.max_concurrent,
                extras=entry.extras,
            ))
        return reg
```

`make_subagent_factory(entry)`는 [04 §6](./04_geny_changes.md#6-sub-agent-factory-실구현)에서 정의 — `SubAgentBuildContext`를 받아 sub-pipeline을 빌드.

## 17. Geny default manifest (final, re-written)

```python
def _stage_entries() -> List[StageManifestEntry]:
    return [
        StageManifestEntry(order=1,  name="input"),
        StageManifestEntry(order=2,  name="context"),
        StageManifestEntry(order=3,  name="system"),
        StageManifestEntry(order=4,  name="guard"),
        StageManifestEntry(order=5,  name="cache"),
        StageManifestEntry(
            order=6, name="api",
            config={"provider": "anthropic"},                       # 통일된 위치
            strategies={"retry": "exponential_backoff", "router": "adaptive"},
        ),
        StageManifestEntry(order=7,  name="token"),
        StageManifestEntry(order=8,  name="think"),
        StageManifestEntry(order=9,  name="parse"),
        StageManifestEntry(order=10, name="tool"),
        StageManifestEntry(order=11, name="tool_review", active=False),
        StageManifestEntry(
            order=12, name="agent",
            strategies={"orchestrator": "subagent_type"},           # default 활성화
            config={"max_delegations": 4},
        ),
        StageManifestEntry(order=13, name="task_registry", active=False),
        StageManifestEntry(order=14, name="evaluate"),
        StageManifestEntry(order=15, name="hitl",         active=False),
        StageManifestEntry(order=16, name="loop"),
        StageManifestEntry(order=17, name="emit"),
        StageManifestEntry(order=18, name="memory"),
        StageManifestEntry(order=19, name="summarize",    active=False),
        StageManifestEntry(order=20, name="persist",      active=False),
        StageManifestEntry(order=21, name="yield"),
    ]
```

## 18. Frontend (final shape)

- `modelCatalog.ts` — 6 provider 카탈로그 + kind=api|cli + 설치 안내.
- `GlobalSettingsView.tsx` — provider/model picker + capability badges + (CLI 시) health 결과.
- `CLIBackendSettings.tsx` (NEW) — settings 페이지의 CLI 카드 2개.
- `StageEditorView.tsx` — 모든 stage에 model_override + provider_override 패널 (default collapsed).
- `SubagentCatalogView.tsx` (NEW) — settings.subagents 편집 UI.
- `useBackendHealth.ts` (NEW) — `/api/health/llm_backends` 폴링.

## 19. Health endpoint

`GET /api/health/llm_backends` → 6 backend의 health (binary 있음/없음, version, auth ok/fail).

## 20. 보장 (이 사이클이 만든 invariants)

1. `manifest.stages[N].config["provider"]`는 단일 위치. 다른 어디에서도 provider를 안 읽는다.
2. `CredentialBundle`은 단일 진입점. 다른 어떤 자격증명 경로도 없다.
3. `SubagentTypeRegistry`는 단일 등록. `_placeholder_factory`는 코드베이스에서 사라진다.
4. `PipelineFactory`는 `SubAgentBuildContext`만 받는다.
5. CLI 백엔드는 `BaseClient` 시민. provider 이름으로 분기하는 stage 코드 없음.
6. Fork-mode skill은 `ANTHROPIC_API_KEY`를 직접 안 본다.
