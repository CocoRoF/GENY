# 03 · `geny-executor` Changes

> back-compat 없음. 옛 호출자가 깨지면 호출자 측 (Geny)에서 수정. 본 문서는 framework가 어떻게 *재구성*되는지를 모듈별로 펼친다.

## 1. 최종 모듈 트리

```
src/geny_executor/
├── llm_client/
│   ├── __init__.py                       # re-export
│   ├── base.py                           # ClientCapabilities 16 필드 + drops
│   ├── types.py                          # APIRequest.{response_format,session_hint}
│   │                                     # TokenUsage.{cost_usd,duration_ms}
│   ├── credentials.py                    # NEW: ProviderCredentials, CredentialBundle
│   ├── registry.py                       # 6 builtin 등록
│   ├── _cli_runtime.py                   # NEW: subprocess primitives
│   ├── anthropic.py                      # 변경 없음
│   ├── openai.py / google.py / vllm.py   # 변경 없음
│   ├── claude_code.py                    # NEW
│   ├── copilot.py                        # NEW
│   ├── bridge.py                         # DELETED (ProviderBackedClient 제거)
│   └── translators/
│       ├── __init__.py                   # 신규 CLI 헬퍼 re-export
│       ├── _canonical.py                 # 변경 없음
│       └── _cli.py                       # NEW
├── core/
│   ├── config.py                         # 변경 없음
│   ├── environment.py                    # StageManifestEntry 검증 추가
│   ├── errors.py                         # ErrorCategory 5 추가
│   ├── mutation.py                       # restore에서 strategies['provider'] 제거
│   ├── pipeline.py                       # from_manifest_async credentials only
│   └── stage.py                          # resolve_local_client helper
├── stages/
│   ├── _base.py                          # resolve_local_client 노출
│   ├── s06_api/artifact/default/stage.py # config['provider'] 단일 소스
│   ├── s12_agent/
│   │   ├── artifact/default/
│   │   │   ├── stage.py                  # orchestrator 결정 단순화
│   │   │   └── orchestrators.py          # DelegateOrchestrator 제거
│   │   └── subagent_type.py              # Descriptor + Factory + Orchestrator 재설계
│   ├── s02_context/.../llm_summary.py    # resolve_local_client 사용
│   └── s15_memory/.../reflection.py      # resolve_local_client 사용
├── skills/
│   └── fork.py                           # CredentialBundle 기반 재배선
└── tests/
    ├── unit/
    │   ├── test_llm_client_capabilities.py    # NEW
    │   ├── test_llm_client_credentials.py     # NEW
    │   ├── test_errors_categories.py          # 변경
    │   └── test_subagent_descriptor.py        # NEW
    ├── llm_client/
    │   ├── conformance/
    │   │   ├── harness.py                     # NEW
    │   │   ├── test_anthropic.py / test_openai.py / test_google.py / test_vllm.py  # NEW
    │   │   ├── test_claude_code_cli.py        # NEW
    │   │   └── test_copilot_cli.py            # NEW
    │   └── unit/
    │       ├── test_cli_runtime.py
    │       ├── test_translators_cli.py
    │       ├── test_claude_code.py
    │       └── test_copilot.py
    └── subagent/
        ├── test_subagent_type_orchestrator.py # NEW
        ├── test_subagent_parallel.py          # NEW
        └── test_fork_multi_provider.py        # NEW
```

## 2. `base.py` 변경

### 2.1 `ClientCapabilities` (final 16 필드 + drops)

[02 §2](./02_target_architecture.md#2-clientcapabilities-final) 그대로.

### 2.2 `BaseClient._build_request` 확장

신규 capability 체크 추가:
```python
if request.response_format and not self.capabilities.supports_structured_output:
    self._emit_unsupported("response_format")
    request.response_format = None

if request.session_hint and not self.capabilities.supports_session_continuity:
    self._emit_unsupported("session_hint")
    request.session_hint = None
```

### 2.3 새 helper

```python
def supports(self, feature: str) -> bool:
    return bool(getattr(self.capabilities, f"supports_{feature}", False))
```

## 3. `types.py` 변경

`APIRequest`에 `response_format`, `session_hint` 추가. `TokenUsage`에 `cost_usd`, `duration_ms` 추가. `APIResponse.cost_usd` 프로퍼티.

## 4. `core/errors.py` 변경

5 신규 카테고리 추가. retry 분류 dict 갱신.

## 5. `credentials.py` (NEW)

[02 §9](./02_target_architecture.md#9-credentials-final) 그대로. `__repr__`에서 api_key redact. `from_legacy_api_key` 등 편의 메서드 **없음**.

## 6. `_cli_runtime.py` (NEW)

[02 §6](./02_target_architecture.md#6-_cli_runtimepy-final) 그대로. 핵심:
- `asyncio.create_subprocess_exec(shell=False, start_new_session=True)`
- env scrub: whitelist 외 누출 차단
- bounded asyncio.Queue로 backpressure
- stream-json 라인 파서
- `os.killpg`로 kill-tree
- timeout 강제 + grace SIGTERM → SIGKILL
- 보안: `cwd` 검증 (resolve + relative_to workspace_root, 옵션)

## 7. `translators/_cli.py` (NEW)

### 7.1 Claude Code

```python
def claude_code_argv(request: APIRequest, *,
                     binary: str,
                     workspace_dir: str,
                     bare_mode: bool,
                     permission_mode: str,
                     max_budget_usd: float | None,
                     settings_path: str | None,
                     mcp_config: Any | None,
                     allow_tools: Sequence[str],
                     disallow_tools: Sequence[str],
                     extra_args: Sequence[str]) -> list[str]: ...

async def assemble_response_from_stream_json(
    stream: AsyncIterator[bytes], *, model: str,
) -> APIResponse: ...

def thinking_to_effort(thinking: dict) -> str:
    """budget_tokens → low/medium/high/xhigh/max"""

def build_stream_json_stdin(messages: list[dict]) -> bytes: ...
```

매핑:
| Canonical | CLI flag |
|---|---|
| `model` | `--model` |
| `system` | `--system-prompt` |
| `thinking` | `--effort` |
| `tools` (allowlist names) | `--allowedTools` |
| `response_format.json_schema` | `--json-schema` |
| `session_hint.session_id` | `--session-id` |
| `session_hint.resume=true` | `--resume <id>` |
| `metadata.bare_mode` | `--bare` |
| `metadata.mcp_config` | `--mcp-config` |
| `max_tokens` | (drop — no flag) |
| `temperature/top_p/top_k` | (drop) |
| `stop_sequences` | (drop) |
| `tool_choice` | (drop) |

stream-json 라인 종류 매핑 ([01 §1.7 + 02 §6](.) 참조):
| line type | canonical event |
|---|---|
| `system` | populate `model`, `message_id` |
| `assistant` text_delta | `{"type":"text_delta","text":...}` |
| `assistant` thinking_delta | `{"type":"thinking_delta","text":...}` |
| `assistant` tool_use start | `{"type":"tool_use","id":...,"name":...,"input":{}}` |
| `assistant` input_json_delta | `{"type":"input_json_delta","delta":...}` |
| `assistant` block_stop | content block 마무리 |
| `result` | usage, stop_reason, cost_usd, duration_ms |
| `error` | `APIError(category=...)` raise |

### 7.2 Copilot

```python
def copilot_argv(request: APIRequest, *,
                 binary: str,
                 allow_tools: Sequence[str],
                 cwd: str | None,
                 extra_args: Sequence[str]) -> list[str]: ...

def compose_copilot_prompt(system: Any, messages: list[dict]) -> str:
    """system + 최근 user message → 단일 -p 인자."""

def parse_plain_text_to_response(text: str, *, model: str) -> APIResponse: ...
```

## 8. `claude_code.py` (NEW)

[02 §7.1](./02_target_architecture.md#71-claudecodeclient) 시그니처. `_send` 구현 골격:

```python
async def _send(self, request: APIRequest, *, purpose: str = "") -> APIResponse:
    runner = CLIProcessRunner(
        binary=self._binary,
        cwd=self._workspace_dir,
        env_extras=self._env_extras(),
        timeout_s=self._timeout_s,
    )
    argv = claude_code_argv(
        request,
        binary=self._binary,
        workspace_dir=self._workspace_dir,
        bare_mode=self._bare_mode,
        permission_mode=self._default_permission_mode,
        max_budget_usd=self._max_budget_usd,
        settings_path=self._settings_path,
        mcp_config=self._mcp_config,
        allow_tools=self._allow_tools,
        disallow_tools=self._disallow_tools,
        extra_args=self._extra_args,
    )
    stdin = build_stream_json_stdin(request.messages) if request.stream else None
    try:
        if request.stream:
            stream = runner.stream(argv, stdin_iter=_aiter_bytes(stdin))
            return await assemble_response_from_stream_json(stream, model=request.model)
        result = await runner.run_oneshot(argv, stdin=stdin)
        if result.returncode != 0:
            raise classify_cli_failure(result, hint="claude")
        return parse_json_output_to_response(result.stdout, model=request.model)
    except CLIBinaryNotFound as e:
        raise APIError(category=ErrorCategory.CLI_NOT_FOUND, message=str(e)) from e
    except CLITimeout as e:
        raise APIError(category=ErrorCategory.CLI_TIMEOUT, message=str(e)) from e
    except CLIAuthFailed as e:
        raise APIError(category=ErrorCategory.CLI_AUTH_FAILED, message=str(e)) from e
    except CLIProtocolError as e:
        raise APIError(category=ErrorCategory.CLI_PROTOCOL_ERROR, message=str(e)) from e
```

`_env_extras`: `{"ANTHROPIC_API_KEY": self._api_key}` if set.

`create_message_stream` override:
```python
async def create_message_stream(self, *, model_config, messages, system="", tools=None,
                                tool_choice=None, purpose=""):
    request = self._build_request(model_config=model_config, messages=messages,
                                  system=system, tools=tools, tool_choice=tool_choice,
                                  stream=True)
    runner = CLIProcessRunner(...)
    argv = claude_code_argv(request, ...)
    stdin = build_stream_json_stdin(request.messages)
    async for line in runner.stream(argv, stdin_iter=_aiter_bytes(stdin)):
        event = parse_stream_json_line(line)
        if event is None: continue
        canonical = stream_json_line_to_canonical_event(event)
        if canonical: yield canonical
```

## 9. `copilot.py` (NEW)

[02 §7.2](./02_target_architecture.md#72-copilotcliclient) 시그니처. `_send`:

```python
async def _send(self, request: APIRequest, *, purpose: str = "") -> APIResponse:
    runner = CLIProcessRunner(binary=self._gh, cwd=self._cwd, timeout_s=self._timeout_s)
    prompt = compose_copilot_prompt(request.system, request.messages)
    argv = copilot_argv(request, binary=self._gh, allow_tools=self._allow_tools,
                        cwd=self._cwd, extra_args=self._extra_args)
    argv.extend(["-p", prompt])
    try:
        result = await runner.run_oneshot(argv)
        if result.returncode != 0:
            raise classify_cli_failure(result, hint="gh_copilot")
        return parse_plain_text_to_response(
            result.stdout.decode("utf-8"), model=request.model,
        )
    except CLIBinaryNotFound as e:
        raise APIError(category=ErrorCategory.CLI_NOT_FOUND, message=str(e)) from e
    # ... 동일 패턴
```

streaming은 BaseClient default fallback 사용 (capabilities.supports_streaming=False이므로 자동).

## 10. `registry.py` 변경

[02 §8](./02_target_architecture.md#8-registry-final) 그대로. `bridge.py` import 없음.

## 11. `bridge.py` 삭제

`ProviderBackedClient` 클래스를 사용하는 코드는 없어진다. 파일 자체 삭제.

## 12. `core/pipeline.py` 변경

### 12.1 `from_manifest_async` (final signature)

[02 §10](./02_target_architecture.md#10-pipeline-api-final) 그대로. `api_key: str` 인자 **없음**. `credentials: CredentialBundle` required.

### 12.2 `_resolve_llm_client` 단순화

```python
def _resolve_llm_client(self) -> BaseClient | None:
    if self._attached_llm_client is not None:
        return self._attached_llm_client
    api_stage = next((s for s in self._stages if s.name == "api"), None)
    if api_stage is None:
        return None
    provider = (api_stage.config or {}).get("provider")
    if not provider:
        raise ConfigError("Stage 6 must define config['provider']")
    creds = self._credentials.require(provider)
    client_cls = ClientRegistry.get(provider)
    return client_cls(**_creds_to_kwargs(provider, creds))
```

### 12.3 `_creds_to_kwargs(provider, creds)` helper

```python
def _creds_to_kwargs(provider: str, creds: ProviderCredentials) -> dict:
    base = {"api_key": creds.api_key}
    if creds.base_url is not None: base["base_url"] = creds.base_url
    if creds.default_headers is not None: base["default_headers"] = creds.default_headers
    # CLI client별 mapping
    if provider == "claude_code_cli":
        return {
            "binary_path": creds.binary_path,
            "api_key": creds.api_key,
            **creds.extras,
        }
    if provider == "copilot_cli":
        return {
            "gh_binary_path": creds.binary_path,
            **creds.extras,
        }
    return base
```

### 12.4 `subagent_registry` slot

`Pipeline.__init__`이 `subagent_registry`를 저장. `_init_state`가 `state.runtime.subagent_registry`에 expose. `_init_state`가 `state.runtime.credentials = self._credentials`도 expose.

### 12.5 Strict validation

```python
def _validate_manifest(manifest, credentials, registry):
    referenced_providers = set()
    for s in manifest.stages:
        p = s.config.get("provider") or s.config.get("provider_override")
        if p: referenced_providers.add(p)
    for p in referenced_providers:
        if p not in ClientRegistry.available():
            raise ConfigError(f"manifest references unknown provider {p!r}")
        credentials.require(p)
    if any(s.name == "agent" and s.strategies.get("orchestrator") == "subagent_type"
           for s in manifest.stages):
        if registry is None:
            raise ConfigError("manifest enables subagent_type orchestrator but no SubagentTypeRegistry provided")
        # 등록된 sub-agent들의 provider도 검증
        for desc in registry.descriptors:
            if desc.provider:
                credentials.require(desc.provider)
```

## 13. `core/mutation.py` 변경

`PipelineMutator.restore`에서 `stage_snap.strategies["provider"]` 처리 코드 제거. 오로지 `stage_snap.config["provider"]` 만 인정.

## 14. `core/environment.py` 변경

`StageManifestEntry` validation:
- Stage 6 (`name == "api"`): `config["provider"]` 필수.
- 다른 stage: `strategies["provider"]` 키 발견 시 `ConfigError` raise.
- Stage 12 (`name == "agent"`): `strategies["orchestrator"]`가 `subagent_type` 또는 `single_agent`. 다른 값 거부.

→ legacy manifest가 들어와도 *명시적 실패*. 잠긴 silence 없음.

## 15. `stages/_base.py` (Stage)

`resolve_local_client(state) -> BaseClient` 메서드 노출 ([02 §12](./02_target_architecture.md#12-stage-helper-final)).

## 16. `stages/s06_api/artifact/default/stage.py` 변경

- 생성자 시그니처에서 `provider: Union[str, APIProvider, None]` 제거. `provider: str = ""` 단일 인자.
- `_provider_name` 결정: `config["provider"]`에서만.
- `_resolve_client`: `state.llm_client`만 인정. local fallback 제거 (Pipeline이 책임).

## 17. `stages/s12_agent/` 재설계

### 17.1 `artifact/default/stage.py`

```python
class AgentStage(Stage):
    name = "agent"

    def __init__(self, *, orchestrator: str = "single_agent", max_delegations: int = 4):
        self._orchestrator_name = orchestrator
        self._max_delegations = max_delegations
        self._orchestrator_obj: Any = None

    def attach_runtime(self, *, subagent_registry: SubagentTypeRegistry | None = None, **kw):
        if self._orchestrator_name == "subagent_type":
            if subagent_registry is None:
                raise ConfigError("subagent_type orchestrator requires registry")
            self._orchestrator_obj = SubagentTypeOrchestrator(
                subagent_registry, max_delegations=self._max_delegations,
            )
        else:
            self._orchestrator_obj = SingleAgentOrchestrator()

    async def execute(self, state: PipelineState) -> PipelineState:
        result = await self._orchestrator_obj.orchestrate(state)
        if result.delegated:
            state.agent_results.extend(result.results)
            state.messages.append(compose_subagent_message(result.results))
            state.loop_decision = "continue"
        return state
```

### 17.2 `orchestrators.py`

`DelegateOrchestrator` (legacy) **삭제**. `SingleAgentOrchestrator` (no-op) 만 유지.

### 17.3 `subagent_type.py` 재설계

[02 §13](./02_target_architecture.md#13-sub-agent-system-final) + [05 §2](./05_sub_agent_system.md#2-메커니즘-정의) 그대로 구현.

핵심:
- `SubagentTypeDescriptor`: provider/parallel/max_concurrent 등 신규 필드.
- `PipelineFactory = Callable[[SubAgentBuildContext], Awaitable[Pipeline]]`.
- `SubAgentBuildContext` dataclass.
- `SubagentTypeOrchestrator`: serial/parallel 그룹 분리, asyncio.Semaphore bounded.
- `_dispatch_one` 내부 try/except로 실패 격리.

## 18. `stages/s02_context/.../llm_summary.py` 변경

```python
class LLMSummaryCompactor:
    async def compact(self, state, ...):
        client = self.stage.resolve_local_client(state)
        response = await client.create_message(
            model_config=self.stage.resolve_model_config(state),
            messages=[{"role":"user","content": ...}],
            purpose="s02.summarize",
        )
        ...
```

## 19. `stages/s15_memory/.../reflection.py` 변경

`ReflectionResolver`도 동일 패턴으로 `resolve_local_client(state)` 사용.

## 20. `skills/fork.py` 재배선

[05 §4](./05_sub_agent_system.md#4-fork-mode-skill의-multi-provider-화) 그대로. `ANTHROPIC_API_KEY` 직접 참조 코드 모두 제거. `CredentialBundle` 인자 추가.

## 21. `llm_client/__init__.py` re-export

```python
from .base       import BaseClient, ClientCapabilities
from .types      import APIRequest, APIResponse, ContentBlock, TokenUsage
from .registry   import ClientRegistry
from .credentials import ProviderCredentials, CredentialBundle
from .anthropic  import AnthropicClient
from .openai     import OpenAIClient
from .google     import GoogleClient
from .vllm       import VLLMClient
from .claude_code import ClaudeCodeCLIClient
from .copilot    import CopilotCLIClient
```

OpenAI/Google lazy import는 모듈 import 시점에서가 아니라 사용 시점에서. `__init__`에서 try/except로 lazy alias.

## 22. CHANGELOG / 버전

- 변경 크기 (back-compat 깨짐, API 시그니처 변경) → **`v2.0.0`** (semver major).
- CHANGELOG에 모든 변경 + migration notes 작성 (Geny 측이 어떻게 적응해야 하는지).

## 23. 영향 표면 (clean break)

| API | 변경 |
|---|---|
| `Pipeline.from_manifest_async(api_key=str)` | **삭제**. `credentials=CredentialBundle` required. |
| `APIStage(provider=APIProvider)` | **삭제**. `provider: str` only. |
| `manifest.stages[N].strategies["provider"]` | **거부** (ConfigError). |
| `SubagentTypeDescriptor(model_override: str)` | **변경**. `model_override: ModelConfig`. |
| `PipelineFactory = Callable[[], Any]` | **변경**. `Callable[[SubAgentBuildContext], Awaitable[Pipeline]]`. |
| `ProviderBackedClient` | **삭제**. |
| `bridge.py` | **삭제**. |
| `ClientCapabilities` 7 필드 | **확장**: 16 필드. |
| `APIRequest` 12 필드 | **확장**: 14 필드. |
| `TokenUsage` 4 필드 | **확장**: 6 필드. |
| `ErrorCategory` 8 | **확장**: 13. |
| `ClientRegistry.available()` 길이 4 | **5→6** (extends, no removal). |

## 24. 호환 검증 체크리스트

- [ ] `pytest tests/` 전체 통과
- [ ] `pytest tests/llm_client/conformance/` 6 backend 통과
- [ ] `pytest tests/subagent/` sub-agent suite 통과
- [ ] `mypy src/geny_executor` strict 통과
- [ ] `ruff check src/geny_executor` 통과
- [ ] CHANGELOG v2.0.0 항목
