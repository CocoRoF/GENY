# 05 · Sub-Agent System (Stage 12 multi-agent)

> 본 문서는 Stage 12 "agent" stage에서 **multi-provider sub-agent**가 실제로 동작하는 메커니즘을 정의한다. 현재 코드(1.21.0)는 메커니즘이 부분적이고 Geny에서 wire가 빠져 있다 — [01 §1.7, §1.8](./01_current_state.md) 참조. 본 사이클이 청산한다.

## 1. 현 상태 한 번 더 (요약)

| 측면 | 현 상태 | 본 사이클 후 |
|---|---|---|
| Orchestrator 종류 | `single_agent`(no-op) / `DelegateOrchestrator`(legacy) / `SubagentTypeOrchestrator`(신형) | `SubagentTypeOrchestrator`만. legacy 제거. |
| Geny default stage 12 strategy | `single_agent` | `subagent_type` |
| `SubagentTypeDescriptor` | `model_override: str` 뿐, provider 없음 | `provider`, `provider_credentials_extras`, `parallel`, `max_concurrent` 추가, `model_override`는 `ModelConfig` |
| `PipelineFactory` | `Callable[[], Any]` (zero-arg) | `Callable[[SubAgentBuildContext], Awaitable[Pipeline]]` |
| Concurrency | sequential only | descriptor.parallel 기반 mixed (serial + bounded parallel) |
| Geny factory들 | `_placeholder_factory` (NotImplementedError) | 실구현 |
| Fork-mode skill | `ANTHROPIC_API_KEY` hardcoded | `CredentialBundle` 기반, skill에 provider 명시 가능 |

## 2. 메커니즘 정의

### 2.1 데이터 모델

```python
@dataclass
class SubagentTypeDescriptor:
    agent_type: str
    factory: PipelineFactory
    description: str = ""
    allowed_tools: tuple[str, ...] = ()
    provider: Optional[str] = None                     # sub-pipeline의 stage 6 provider
    provider_credentials_extras: Mapping[str, Any] = field(default_factory=dict)
    model_override: Optional[ModelConfig] = None       # sub-pipeline의 모든 stage가 상속
    parallel: bool = False                             # True면 다른 parallel 형제와 fan-out
    max_concurrent: int = 1                            # parallel=True인 형제 그룹의 동시 spawn 상한
    extras: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SubAgentBuildContext:
    parent_session_id: str
    sub_session_id: str
    credentials: CredentialBundle                      # parent로부터 전파
    descriptor: SubagentTypeDescriptor
    workspace_snapshot: Optional[Mapping[str, Any]] = None
    parent_state_shared: Mapping[str, Any] = field(default_factory=dict)


PipelineFactory = Callable[[SubAgentBuildContext], Awaitable[Pipeline]]


class SubagentTypeRegistry:
    def __init__(self) -> None:
        self._by_type: dict[str, SubagentTypeDescriptor] = {}
    def register(self, descriptor: SubagentTypeDescriptor) -> None: ...
    def get(self, agent_type: str) -> SubagentTypeDescriptor: ...
    def available(self) -> list[str]: ...
```

### 2.2 Orchestrator 동작

```python
class SubagentTypeOrchestrator:
    def __init__(self, registry: SubagentTypeRegistry,
                 *, max_delegations: int = 4) -> None: ...

    async def orchestrate(self, state: PipelineState) -> AgentResult:
        if not state.delegate_requests:
            return AgentResult(delegated=False)

        requests = state.delegate_requests[: self._max_delegations]
        serial, parallel = [], []
        for raw in requests:
            desc = self._registry.get(raw["agent_type"])
            (parallel if desc.parallel else serial).append((raw, desc))

        results: list[Dict[str, Any]] = []

        # Serial first — strict input order preserved
        for raw, desc in serial:
            results.append(await self._dispatch_one(state, raw, desc))

        # Parallel fan-out — bounded by min of involved descriptors' max_concurrent
        if parallel:
            cap = min(d.max_concurrent for _, d in parallel)
            sem = asyncio.Semaphore(max(cap, 1))
            async def bounded(raw, desc):
                async with sem:
                    return await self._dispatch_one(state, raw, desc)
            parallel_results = await asyncio.gather(
                *[bounded(r, d) for r, d in parallel],
                return_exceptions=False,
            )
            results.extend(parallel_results)

        return AgentResult(delegated=True, results=results)

    async def _dispatch_one(
        self, parent_state: PipelineState,
        raw: Dict[str, Any], desc: SubagentTypeDescriptor,
    ) -> Dict[str, Any]:
        sub_session_id = f"{parent_state.session_id}-sub-{desc.agent_type}-{uuid4().hex[:8]}"
        ctx = SubAgentBuildContext(
            parent_session_id=parent_state.session_id,
            sub_session_id=sub_session_id,
            credentials=parent_state.runtime.credentials,
            descriptor=desc,
            workspace_snapshot=parent_state.shared.get("workspace_snapshot"),
            parent_state_shared=dict(parent_state.shared),
        )
        sub_pipeline = await desc.factory(ctx)
        sub_state = PipelineState(session_id=sub_session_id)
        if ctx.workspace_snapshot is not None:
            sub_state.shared["workspace_snapshot"] = ctx.workspace_snapshot
        sub_result = await sub_pipeline.run(raw.get("input",""), sub_state)
        return {
            "agent_type": desc.agent_type,
            "session_id": sub_session_id,
            "success": sub_result.success,
            "text": sub_result.text,
            "error": sub_result.error,
            "provider": desc.provider,
        }
```

핵심:
- Serial 그룹과 Parallel 그룹은 분리. Serial은 입력 순서 보존.
- Parallel 그룹은 동시 실행 (asyncio.gather), 동시성 상한은 그룹 내 min(max_concurrent).
- 한 요청의 실패는 형제 요청을 중단시키지 않음 — `return_exceptions=False`인데 try/except로 감싸 `dict(error=...)` 반환하도록 `_dispatch_one` 내부에서 처리.

### 2.3 Sub-pipeline 의 `state.llm_client` 결정 흐름

```
sub_pipeline = await factory(ctx)
    ↓
factory가 sub_manifest를 빌드:
    stages[6].config["provider"] = descriptor.provider  (or default)
    ↓
sub_pipeline = await Pipeline.from_manifest_async(
    sub_manifest,
    credentials=ctx.credentials,        # parent가 가진 CredentialBundle 전체를 sub도 공유
)
    ↓
await sub_pipeline.run(input, sub_state)
    ↓
첫 stage 실행 시 sub_state.llm_client = sub_pipeline._resolve_llm_client()
    → sub_manifest.stages[6].config["provider"] 로 client 빌드
    → credentials.require(provider)에서 자격증명 조회
```

→ **결과: descriptor.provider 가 sub-pipeline의 모든 stage 6 호출 + state.llm_client를 결정.** parent와 다른 provider 사용 가능.

### 2.4 Credential 전파

Parent의 `state.runtime.credentials` (= `Pipeline.from_manifest_async` 시 받은 `CredentialBundle`)을 `SubAgentBuildContext.credentials`에 그대로 전달.

→ Sub-pipeline은 자격증명을 "다시 만들지 않는다". Geny가 만든 단일 번들이 parent + 모든 sub-agent + 모든 fork-mode skill에 흐른다.

`require(provider)` 결과가 없으면 spawn 시점에 `ConfigError` raise — Geny에서 잡아 한국어로 사용자에게 표시.

### 2.5 Workspace context threading

기존 동작 유지: `parent_state.shared["workspace_snapshot"]`을 `sub_state.shared`에 복사. sub-pipeline의 도구들이 parent와 같은 cwd/branch를 본다.

## 3. Geny에서 sub-agent factory 만드는 패턴

`Geny/backend/service/agent_types/factories.py` (신규):

```python
async def make_default_subagent_pipeline(ctx: SubAgentBuildContext) -> Pipeline:
    """모든 Geny sub-agent의 base factory.

    descriptor의 provider/model을 stage 6에 반영하고
    parent와 동일한 21-stage manifest를 빌드한다."""

    desc = ctx.descriptor
    base_manifest = build_subagent_base_manifest(desc.allowed_tools)
    # base_manifest는 21-stage 그대로지만 stage 12 orchestrator는 single_agent
    # (nested sub-agent를 의도적으로 막음; 사용자 결정 시 변경)

    primary = desc.provider or "anthropic"
    base_manifest = patch_stage_provider(base_manifest, stage_order=6, provider=primary)
    if desc.model_override is not None:
        base_manifest = patch_global_model(base_manifest, desc.model_override)

    return await Pipeline.from_manifest_async(
        base_manifest,
        credentials=ctx.credentials,
        subagent_registry=None,           # nested sub-agent 차단
    )

def make_subagent_factory(entry: SubagentEntry) -> PipelineFactory:
    """settings.subagents 항목 하나에서 factory 생성."""
    async def factory(ctx: SubAgentBuildContext) -> Pipeline:
        return await make_default_subagent_pipeline(ctx)
    return factory
```

규칙:
- Sub-pipeline은 21-stage 동일. 다만 stage 12는 `single_agent`로 강제 (nested 차단).
- descriptor.provider가 stage 6에 직접 패치.
- descriptor.model_override는 sub-pipeline의 글로벌 ModelConfig에 패치.
- descriptor.allowed_tools가 tool stage 바인딩에 반영.

특수 sub-agent가 다른 manifest 형태가 필요하면 (예: "research" agent는 stage 16 (loop) 비활성 등) 별도 factory 작성.

## 4. Fork-mode skill의 multi-provider 화

### 4.1 새 skill 스키마

```python
@dataclass
class ForkSkill:
    name: str
    body: str
    system_prompt: str = ""
    provider: Optional[str] = None              # NEW: 명시 시 그 provider 사용
    model_override: Optional[str] = None
    extras: Mapping[str, Any] = field(default_factory=dict)
```

### 4.2 새 runner

```python
async def run_fork_skill(
    *,
    skill: ForkSkill,
    parent_state: PipelineState,
    credentials: CredentialBundle,
    purpose: str = "",
) -> str:
    provider = skill.provider or _infer_from_state(parent_state)
    creds = credentials.require(provider)
    client_cls = ClientRegistry.get(provider)
    client = client_cls(**_creds_to_kwargs(provider, creds))
    model_cfg = ModelConfig(
        model=skill.model_override or _default_model_for(provider),
    )
    user_msg = compose_user_message(skill, parent_state)
    response = await client.create_message(
        model_config=model_cfg,
        messages=[{"role": "user", "content": user_msg}],
        system=skill.system_prompt,
        purpose=purpose or f"fork.{skill.name}",
    )
    return response.text
```

`_infer_from_state(parent_state)`: parent의 `state.llm_client.provider`. 즉 skill에 provider 명시 안 하면 parent와 같은 provider 사용.

## 5. Geny에서의 sub-agent UI

`SubagentCatalogView.tsx` (신규):
- `GET /api/settings/subagents` → 목록
- 각 row: `agent_type`, description, **provider picker**, model picker, allowed_tools, parallel toggle, max_concurrent.
- `POST /api/settings/subagents` (단건 또는 전체 일괄 save).
- `DELETE` 가능.

Default seed (Geny가 첫 부트 시 자동 등록):
- `worker` — provider=null (parent와 동일), parallel=False
- `researcher` — provider="anthropic", model="claude-opus-4-7", parallel=True, max_concurrent=2
- `summarizer` — provider="openai", model="gpt-4o-mini", parallel=True, max_concurrent=4
- `critic` — provider="claude_code_cli", parallel=False

이건 default일 뿐, 사용자가 자유롭게 편집.

## 6. Stage 6 시점에서 sub-agent 트리거

기존 메커니즘 그대로:
- LLM 응답에 `tool_use` 블록이 있고 그 tool이 `delegate(agent_type, input)` 형식이면 stage 9 (parse)가 `state.delegate_requests`에 push.
- Stage 12가 받아서 orchestrate.
- 결과를 stage 12가 `state.messages`에 user message로 주입 → loop 재개.

본 사이클은 메커니즘은 안 바꾼다. 다만 descriptor의 풍부해진 메타정보를 응답 메시지에 포함:

```
Sub-agent results:
- researcher (anthropic/claude-opus-4-7) ✓: <text>
- summarizer (openai/gpt-4o-mini) ✓: <text>
- critic (claude_code_cli/sonnet) ✗: <error>
```

## 7. Concurrency 안전성

### 7.1 자격증명 race condition 없음

`CredentialBundle`은 frozen dataclass. 여러 sub-agent가 동시에 `credentials.require(provider)` 호출해도 안전.

### 7.2 Workspace race

`workspace_snapshot`은 한 시점의 immutable 복사본. parallel sub-agent 들이 같은 snapshot을 보지만 서로의 cwd를 침범하지 않는다 (각자의 도구가 알아서 isolation).

### 7.3 CLI 백엔드 subprocess 동시성

`max_concurrent=4`로 4개의 sub-agent가 `claude_code_cli`로 동시 spawn해도 안전 (각자 별도 process, 별도 stdin/stdout/stderr 파이프). 다만 사용자 머신의 CPU/메모리 부담 큼. 안전 default는 `max_concurrent=1` (즉 사실상 serial), 사용자가 명시적으로 올림.

### 7.4 Sub-agent 안에서 sub-agent (nested)

본 사이클: **차단**. `make_default_subagent_pipeline`이 sub-pipeline의 stage 12 orchestrator를 `single_agent`로 강제 + `subagent_registry=None` 전달. nested spawn 요청 시 stage 12가 no-op으로 처리.

차단 이유:
1. 비용 폭증 위험 (재귀적 fan-out).
2. circular delegate 가능성.
3. 디버깅 복잡도.

사용자가 명시적으로 원하면 별도 factory를 만들어 `subagent_registry`를 전달하면 됨 — out-of-scope this cycle.

## 8. 에러 처리

### 8.1 Sub-agent 실패가 parent를 죽이지 않음

`_dispatch_one` 내부 try/except → 실패 시 `{"success": False, "error": str(e)}` 반환. parent의 stage 12는 모든 sub-agent 결과를 모아 user message로 주입한 뒤 정상적으로 다음 iteration.

### 8.2 자격증명 누락

```python
try:
    creds = ctx.credentials.require(desc.provider)
except ConfigError as e:
    return {
        "agent_type": desc.agent_type,
        "success": False,
        "error": f"Provider {desc.provider!r}의 자격증명이 누락되었습니다. settings에서 확인해 주세요. ({e})",
        "provider": desc.provider,
    }
```

### 8.3 CLI 백엔드 binary 부재

CLI client 인스턴스 생성 시 `CLIBinaryNotFound` raise → 같은 try/except 안에서 잡혀 `CLI_NOT_FOUND` 카테고리로 dispatch 결과 반환. parent loop가 메시지로 보고 사용자에게 안내 가능.

## 9. Sub-agent 메트릭

session.metadata에 기록:

```python
session.metadata["subagent_runs"] = [
    {
        "agent_type": "researcher",
        "provider": "anthropic",
        "model": "claude-opus-4-7",
        "duration_ms": ...,
        "tokens_in": ..., "tokens_out": ...,
        "cost_usd": ...,
        "success": True,
    },
    ...
]
```

CLI 백엔드의 cost_usd가 채워지면 그것도 합산 가능.

## 10. 본 사이클이 만지지 않는 영역 (다음 사이클 후보)

- Nested sub-agent (sub-agent 안에서 또 sub-agent).
- Sub-agent의 자체 fork-mode skill (sub-pipeline 안에서 fork skill 실행 시 사용 가능하나 본 사이클이 그것의 e2e 통합 테스트는 없음).
- Sub-agent 결과 streaming (현재는 sub-pipeline 끝나야 결과 반환).
- Sub-agent별 budget 분리.

## 11. 검증 시나리오 (본 사이클 종료 시)

1. ✅ Geny에서 `subagents=[{agent_type:"researcher", provider:"openai"}]` 설정.
2. ✅ 환경 worker의 stage 6은 anthropic.
3. ✅ 세션 생성 후 LLM에게 "researcher로 X를 조사해줘" 지시 → tool_use(delegate, "researcher") → stage 12가 spawn → sub-pipeline의 stage 6은 OpenAI client → 응답이 parent로 돌아옴.
4. ✅ session.metadata.subagent_runs[0].provider == "openai".
5. ✅ Parallel 시연: parallel=True인 sub-agent 3개 동시 등록, 동시 호출 시 spawn 시간이 sequential 대비 ≤ 1.5x.
6. ✅ Fork-mode skill `code-review` with provider="claude_code_cli" → 실제 CLI subprocess로 호출 검증.
7. ✅ Sub-agent 안에서 다시 delegate 요청 → no-op (nested 차단 확인).
