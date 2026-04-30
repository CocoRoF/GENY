# 메모리 회로 전체 audit — geny-executor s18 ↔ Geny 의 InteractionEvent

> **Cycle**: 20260501_1 · **Date**: 2026-05-01
>
> 사용자 질문: *"우리 Environment 의 18단계 메모리 로직을 사용하는 것
> 아니야? 지금 어떻게 사용되는건지 아주 심층적으로 분석해서 알려줘.
> 특히 geny-executor 의 메모리 로직과 지금 상호작용 메모리 로직 전체를
> 모두 파악해서 알려줘."*
>
> 결론: **두 가지 심각한 결함이 있다**. 이전 cycle 들에서는 짚지 못한
> *원래 의도된 메모리 회로* 와 *우리 InteractionEvent 회로* 의
> 분리 / 잘못된 wiring 이 그것이다.
>
>   1. **agent_session 의 stage-번호 wiring 이 옛 번호 (15)** 에 그대로
>      박혀 있어, *memory_model 이 진짜 메모리 stage (s18) 가 아닌
>      HITL stage (s15) 의 model_override 로 들어감*. ReflectionResolver 도
>      마찬가지 — HITL stage 의 override 를 본다.
>   2. **cycle 20260430_3 F 의 `_run_distill_llm`** 이 *공유
>      LLM client 와 메모리 stage 회로를 우회* 하고, `ClientRegistry`
>      에서 *별도 client* 를 매 호출마다 새로 생성한다. 사용자가 말한
>      "18단계 메모리 로직 안 씀" 의 정확한 정체.
>
> 이 문서는 (a) 전체 회로의 *완전한 그림*, (b) 두 결함의 정확한 원인,
> (c) 통합된 fix 방향을 코드 라인 단위로 정리한다.

## 0. 한 페이지 mental model

```
┌──────────────────────────────────────────────────────────────────────┐
│ Geny 측: SessionMemoryManager  (per-session)                         │
│   ┌────────────────────────────┬─────────────────────────────────┐  │
│   │ ShortTermMemory (jsonl/DB) │ LongTermMemory + StructuredWriter │  │
│   │  transcripts/session.jsonl │  memory/{daily,topics,entities,...}│  │
│   └────────────────────────────┴─────────────────────────────────┘  │
│       ▲   metadata = InteractionEvent (cycle 20260430_2)             │
│       │                                                              │
│       │ record_message ── entity_bootstrap (cycle 20260430_3 B)      │
│       │                                                              │
│       │  매 turn 의 모든 hook (A2/A3/A4/A5/A6) 가 단일 진입처        │
│       │                                                              │
└───────┼──────────────────────────────────────────────────────────────┘
        │
        │  attach_runtime() 으로 wiring (executor 측 stage 가 매 turn
        │  자동으로 호출)
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ geny-executor 측: 21 stages                                           │
│   s01_input → s02_context → s03_system → s04_guard → s05_cache       │
│   → s06_api ── (LLM 메인 호출) ── s07_token → s08_think               │
│   → s09_parse → s10_tool → s11_tool_review → s12_agent                │
│   → s13_task_registry → s14_evaluate → s15_hitl                       │
│   → s16_loop → s17_emit → s18_memory ← (LLM 메모리 reflection)        │
│   → s19_summarize → s20_persist → s21_yield                           │
│                                                                      │
│   s02_context  GenyMemoryRetriever (5-layer recall)                  │
│   s18_memory   GenyMemoryStrategy + GenyPersistence                  │
│                  ├── _record_transcript → mgr.record_message         │
│                  ├── _record_execution_result → mgr.remember_dated   │
│                  └── _reflect → state.llm_client.create_message      │
│                                  (cfg = stage.resolve_model_config)  │
│                                                                      │
│   s06_api / s08_think / etc. — state.llm_client (공유)               │
└──────────────────────────────────────────────────────────────────────┘
```

핵심 invariant: **Pipeline 안의 *모든* LLM 호출은 `state.llm_client`
(attach_runtime 으로 주입된 단일 client) 와 stage 별 ModelConfig
override 를 통해 흐른다**. 이 단일성은 cycle 20260421_4 의 명시적
설계 — `[agent_session.py:1452](../../../backend/service/executor/agent_session.py#L1452)` 의
주석 *"main-stage and memory-stage LLM calls both run through the
same instance — no credential drift by construction."*

## 1. 21-stage 의 메모리 관련 위치

`STAGE_MODULES` ([geny-executor/src/geny_executor/core/artifact.py:53-75](../../../../geny-executor/src/geny_executor/core/artifact.py#L53-L75)):

| order | module       | role |
|---|---|---|
| 1  | s01_input | 입력 정규화 |
| 2  | s02_context | **MemoryRetriever — 5 layer recall (recent_turns / vector / keyword / curated / backlinks)** |
| 3  | s03_system | system prompt 조립 |
| 4  | s04_guard | 도구 권한 |
| 5  | s05_cache | API 캐시 |
| 6  | s06_api | LLM 본 호출 |
| 7  | s07_token | 사용량 회계 |
| 8  | s08_think | 추가 LLM (think) |
| 9–13 | parse / tool / review / agent / task_registry | 도구 실행 회로 |
| 14 | s14_evaluate | difficulty 분류기 |
| 15 | s15_hitl | **HITL (Human-in-the-loop)** — 위험 결정 시 사용자 승인 |
| 16 | s16_loop | 루프 결정 |
| 17 | s17_emit | 사용자 메시지 emit |
| 18 | s18_memory | **MemoryUpdateStrategy + ConversationPersistence + provider hooks** |
| 19 | s19_summarize | 세션 요약 |
| 20 | s20_persist | 종단 저장 |
| 21 | s21_yield | 결과 반환 |

**s02 와 s18** 가 *매 invoke 자동* 으로 동작하는 메모리 stage. s15 는
HITL — 메모리와 *완전히 다른 책임*.

s18 의 `order` 가 **18** 인 것을 코드로 직접 확인:
[stages/s18_memory/artifact/default/stage.py:124-125](../../../../geny-executor/src/geny_executor/stages/s18_memory/artifact/default/stage.py#L124-L125):
```python
@property
def order(self) -> int:
    return 18
```

s15_hitl 의 `order` 는 **15**:
[stages/s15_hitl/artifact/default/stage.py:111-112](../../../../geny-executor/src/geny_executor/stages/s15_hitl/artifact/default/stage.py#L111-L112).

## 2. attach_runtime 의 메모리 wiring (Geny 측)

`AgentSession._build_pipeline` 의 핵심 부분
([backend/service/executor/agent_session.py:1621-1641](../../../backend/service/executor/agent_session.py#L1621-L1641)):

```python
if self._memory_manager is not None:
    attach_kwargs["memory_retriever"] = GenyMemoryRetriever(...)   # → s02
    attach_kwargs["memory_strategy"] = GenyMemoryStrategy(...)     # → s18
    attach_kwargs["memory_persistence"] = GenyPersistence(...)     # → s18
self._pipeline.attach_runtime(**attach_kwargs)
```

이 세 어댑터가 *Geny 의 SessionMemoryManager* 를 *executor 의 stage
slot* 으로 변환하는 자리. `SessionMemoryManager` 는 STM(jsonl) +
LTM(markdown notes) + Vector index + StructuredWriter 의 결합
facade — duck-typed 인터페이스로 어댑터들이 사용한다.

### 2.1 s02 — `GenyMemoryRetriever`
([geny-executor/src/geny_executor/memory/retriever.py:38-143](../../../../geny-executor/src/geny_executor/memory/retriever.py#L38-L143))

매 invoke 의 *시작* 에서 호출.
1. recent_turns (STM tail)
2. session_summary
3. MEMORY.md
4. FAISS vector
5. keyword
6. backlinks
7. curated_knowledge

→ `MemoryContextBlock` 이 system prompt 에 inject. **Cycle 20260430_2
의 InteractionEvent 표준 metadata 가 STM 에 추가된 *그 라인들 그대로*
recent_turns 에 들어간다.** 회로는 변동 없이 동작 — 단지 metadata 가
풍부해졌을 뿐.

### 2.2 s18 — `GenyMemoryStrategy`
([geny-executor/src/geny_executor/memory/strategy.py:57-345](../../../../geny-executor/src/geny_executor/memory/strategy.py))

매 invoke 의 *종료* 에서 호출 (`s18_memory.execute` 가 자동).

```python
async def update(self, state: PipelineState) -> None:
    if not self._mgr: return
    self._record_transcript(state)         # 1) state.messages → STM record_message
    self._record_execution_result(state)   # 2) final_text → LTM remember_dated
    if self._enable_reflection:
        await self._reflect(state)         # 3) LLM 호출로 insights 추출
```

### 2.3 s18 — `GenyPersistence`
([backend/service/memory/persistence.py 또는 geny_executor/memory/persistence.py:17](../../../../geny-executor/src/geny_executor/memory/persistence.py#L17))

`ConversationPersistence` 인터페이스 구현. messages 를 dehydrate 후
디스크 저장. STM 의 transcripts/session.jsonl 와 *별개* — Pipeline 의
state.messages 자체를 통째로 저장하는 second copy.

## 3. s18 의 reflection LLM 호출 — 의도된 정상 회로

`GenyMemoryStrategy._reflect`
([memory/strategy.py:180-264](../../../../geny-executor/src/geny_executor/memory/strategy.py#L180-L264))
의 3단계 fall-through:

1. **Legacy callback** (`llm_reflect`) — `agent_session._make_llm_reflect_callback(api_key)`
   가 만든 콜백. `APIConfig.use_legacy_reflect=True` 일 때만 — 거의
   안 쓰임.
2. **Native path via `ReflectionResolver`** — *우선 사용* :
   ```python
   client = self._resolver.client_getter(state)  # state.llm_client
   cfg = self._resolver.resolve_cfg(state)       # stage.resolve_model_config(state)
   resp = await client.create_message(
       model_config=cfg,
       messages=[{"role": "user", "content": prompt}],
       purpose="s15.reflect",
   )
   ```
3. **Deferred** — 위 두 가지 다 안 되면 `state.metadata['needs_reflection']
   = True` 만 set 하고 종료.

`ReflectionResolver` 는 어댑터 — 두 callable 을 stage 에 본드:
([memory/strategy.py:32-54](../../../../geny-executor/src/geny_executor/memory/strategy.py#L32-L54))

```python
@dataclass
class ReflectionResolver:
    resolve_cfg: Callable[[PipelineState], ModelConfig]
    has_override: Callable[[], bool]
    client_getter: Callable[[PipelineState], BaseClient]
```

`agent_session.py:1493-1509` 가 이 resolver 를 만들 때:

```python
s15_stage = next(  # ← BUG: should be 18
    (st for st in self._prebuilt_pipeline.stages
     if getattr(st, "order", None) == 15),
    None,
)
if s15_stage is not None:
    reflection_resolver = ReflectionResolver(
        resolve_cfg=lambda state, _stage=s15_stage: _stage.resolve_model_config(state),
        has_override=lambda _stage=s15_stage: getattr(_stage, "_model_override", None) is not None,
        client_getter=lambda state: getattr(state, "llm_client", None),
    )
```

**이게 결함 #1 의 정확한 위치**.

## 4. **결함 #1** — `agent_session.py` 가 옛 stage 번호 (15) 를 그대로 사용

Stage list 가 *18 → 21 entries* 로 확장된 시점에 메모리 stage 가
**order 15 → order 18** 로 이동했지만, agent_session.py 의 wiring 은
*아직도* 15 번을 가리킴. 두 자리에서 동시에 발생:

### 4.1 PipelineMutator.set_stage_model 에서

[agent_session.py:1414-1447](../../../backend/service/executor/agent_session.py#L1414-L1447):

```python
# 주석은 옛 번호 — 수정되지 않음
# Push APIConfig.memory_model down onto s02 (context) and s15
# (memory) so executor-native paths honour the per-stage override.
mutator.set_stage_model(2, memory_cfg)    # s02_context — OK
mutator.set_stage_model(15, memory_cfg)   # ← s15_hitl 에 박힘. 의도는 s18.
```

`PipelineMutator.set_stage_model(stage_order, model)`
([geny-executor/.../core/mutation.py:508-522](../../../../geny-executor/src/geny_executor/core/mutation.py#L508-L522))
는 `_get_stage(stage_order).model_override = model` 을 그대로 적용.
즉 **HITL stage 의 model_override 가 memory_model 로 잘못 박힘**.

영향:
- HITL 이 LLM 호출을 할 때 (위험 결정 검토 등) memory_model 사용 — 의도와 다름.
- s18_memory stage 는 *override 없음* → main 모델 사용 (anthropic_model). memory_model 의 의미 무시.

### 4.2 ReflectionResolver 의 stage handle 검색에서

[agent_session.py:1498-1501](../../../backend/service/executor/agent_session.py#L1498-L1501):

```python
s15_stage = next(
    (st for st in self._prebuilt_pipeline.stages
     if getattr(st, "order", None) == 15),
    None,
)
```

→ HITL stage 객체 반환. 이후:

```python
reflection_resolver = ReflectionResolver(
    resolve_cfg=lambda state, _stage=s15_stage: _stage.resolve_model_config(state),
    has_override=lambda _stage=s15_stage: getattr(_stage, "_model_override", None) is not None,
    ...
)
```

→ `has_override()` 가 **HITL stage** 의 model_override 를 체크. 4.1
때문에 *HITL 이 memory_model 을 갖고 있음* → True 가 됨 → `_reflect`
의 native path 가 *trigger* 되긴 함, 그러나 **`resolve_cfg(state)` 가
HITL stage 의 cfg 를 반환** 한다. 의도된 cfg 와 같다 (memory_cfg) — 하지만
이건 4.1 의 잘못된 wiring 이 *우연히* 같은 cfg 를 두 자리에 박은
결과. 만약 HITL 이 다른 model 을 가졌다면 memory reflection 이
HITL model 을 사용하게 된다.

### 4.3 정상이라면

```python
mutator.set_stage_model(18, memory_cfg)    # s18_memory
s18_stage = next((st for st in pipeline.stages if st.order == 18), None)
reflection_resolver = ReflectionResolver(
    resolve_cfg=lambda s, _stage=s18_stage: _stage.resolve_model_config(s),
    has_override=lambda _stage=s18_stage: _stage._model_override is not None,
    client_getter=lambda s: getattr(s, "llm_client", None),
)
```

위 두 자리만 `15` → `18` 로 정정하면 회로가 의도대로 동작.

### 4.4 docstring 도 옛 번호

증거로 한 가지 더 — s18_memory stage 의 docstring 까지 *"Stage 15: Memory"*
라고 적혀 있음
([s18_memory/stage.py:1](../../../../geny-executor/src/geny_executor/stages/s18_memory/stage.py#L1) +
[s18_memory/artifact/default/stage.py:47](../../../../geny-executor/src/geny_executor/stages/s18_memory/artifact/default/stage.py#L47)).
geny-executor 본체도 옛 번호의 흔적이 남아 있음 — *코드 (`return 18`)
는 정확히 18* 인데 *주석은 15* 로 갱신 안 됨. agent_session.py 의 옛
번호 wiring 은 그 흔적과 같이 cycle 21-stage 확장 때 누락됐다.

### 4.5 정확한 영향

* **`memory_model` 환경변수의 효과 X** — APIConfig.memory_model 로
  설정한 모델이 실제 메모리 stage 에는 들어가지 않는다. `s18_memory`
  의 reflection 은 s18 의 model_override 가 None 이라 *main 모델
  (anthropic_model)* 로 호출됨.
* **HITL stage 가 의도치 않게 memory_model 사용** — HITL 의 LLM 호출
  (보통 위험 결정 검토용 — 별도 cycle 에서 추가될 수도) 가 memory_model
  로 동작. 현재는 HITL 이 LLM 호출을 안 한다면 silent harm; 만들면
  이상한 동작을 할 것.
* **ReflectionResolver native path 의 stage 정합성 X** — has_override
  와 resolve_cfg 가 모두 HITL stage 를 본다. 4.1 의 우연 때문에 cfg 는
  맞지만, 실수의 자국 (debugging 시 stage 번호 mismatch 가 우연히
  안 보일 수 있음).

## 5. **결함 #2** — cycle 20260430_3 F 의 `_run_distill_llm` 분리

[backend/tools/built_in/memory_inspect_tools.py 의 `_run_distill_llm`](../../../backend/tools/built_in/memory_inspect_tools.py)
는 *전혀 다른 path* 로 LLM 을 호출:

```python
api_cfg = get_config_manager().load_config(APIConfig)
client_cls = ClientRegistry.get(provider)
client = client_cls(api_key=api_key, base_url=base_url)   # ← 새 client

response = await client.create_message(
    model_config=ModelConfig(model=memory_model, ...),
    messages=[...],
    system=...,
)
```

문제점:

1. **공유 `state.llm_client` 무시** — agent_session 의 `attach_runtime`
   가 만든 단일 client 가 있는데 (`[agent_session.py:1462](../../../backend/service/executor/agent_session.py#L1462)`),
   tool 이 *별개의* client 를 매 호출마다 생성. credential / base_url
   drift 위험.
2. **stage 회로와 분리** — s18_memory 의 ReflectionResolver native
   path 가 *동일한 작업* (state.llm_client + memory_cfg) 을 이미
   할 수 있음. 단지 매 invoke 종료 자동 호출 (turn 단위) 이지,
   *카운터파트별 누적* 요약은 아님.
3. **APIConfig.memory_model 의 의미 사라짐** — s18 가 결함 #1 때문에
   주 모델로 reflect 한다면, distill 도 동일 패턴이어야 일관됨. 그러나
   `_run_distill_llm` 은 직접 `api_cfg.memory_model` 사용.

사용자가 정확히 짚은 분리. **메모리 LLM 호출은 *모두 한 자리* 에서
나가야 한다 — `state.llm_client` (또는 동일한 공유 client) 를 통해.**

## 6. cycle 20260430_2 의 InteractionEvent 와 s18 의 관계

cycle 20260430_2 가 `record_message(role, content, metadata=...)` 의
metadata 자리에 InteractionEvent 5 dimension 을 표준화한 것은 *옳다*:

* **s18_memory.GenyMemoryStrategy._record_transcript** 가
  ([memory/strategy.py:113-142](../../../../geny-executor/src/geny_executor/memory/strategy.py#L113-L142))
  state.messages 의 *user / assistant* 메시지를 `mgr.record_message` 로
  기록. 본 cycle 에서 우리가 추가한 메타데이터 path 는 *별개* — Geny
  쪽 hook (geny_tools.py 의 `_record_dm_on_sender_stm` /
  `_trigger_dm_response` / `_notify_linked_vtuber` 등) 이
  `record_message(metadata=…)` 로 직접 호출.
* s18 의 `_record_transcript` 는 *현재 invoke 의 messages* 를 STM 에
  넣는 추가 기록. metadata 인자를 *전달하지 않는다*
  ([line 137](../../../../geny-executor/src/geny_executor/memory/strategy.py#L137)):
  ```python
  record(role, content[:5000])   # metadata 없음
  ```
  결과: state.messages 가 STM 에 들어갈 때는 *legacy 라인* 이 됨
  (event_id 없음). 그러나 cycle 20260430_3 의 transcripts API 는
  legacy 라인 자동 skip 이라 *Stream 에 보이지 않음*. *Geny 쪽 hook 으로
  들어간 라인만* InteractionEvent 로 보인다.

이건 *분리* 인데 — 의도된 분리인가? 정확히는:

* **Geny hook 들** (DM, reflection trigger, user chat 입력) 이 *해당
  세션의 외부에서* `record_message(metadata=…)` 를 호출 → 메타가 채워짐.
* **s18 의 `_record_transcript`** 는 *invoke 내부의 state.messages* 를
  추가 기록 → 메타 없이.

같은 STM 에 *두 종류 라인* 이 공존:
* 메타 풍부 (Geny hook 측) — Stream / progressive memory 도구에 잡힘
* 메타 없는 라인 (s18 측) — recent_turns / vector / keyword 의 retrieval
  에는 잡히지만 dimension 검색은 안 됨

사실상 *중복 기록* 일 가능성도 있다 — Geny hook 이 user chat 을
이미 metadata 와 함께 기록했는데, s18 의 _record_transcript 가 *같은
content 를 한 번 더* (이번엔 metadata 없이) 기록할 수 있다.

검증:
* `agent_session._invoke_pipeline` 의 시작에서 user input 을
  `record_message("user", input_text, metadata=…)` 호출
  ([agent_session.py:2007-2030](../../../backend/service/executor/agent_session.py#L2007-L2030)).
* 같은 input 이 state.messages 에 들어가 s18 의 `_record_transcript`
  도 기록.
* `_stm_recorded_count` 는 state.metadata 안의 카운터 (s18 가 관리) —
  *Geny hook 의 record_message 호출은 카운터에 잡히지 않으므로 중복
  발생 가능*.

→ STM 에 user 메시지가 *두 번* 들어간다. 한 번은 메타 풍부, 한 번은
메타 없음. retrieval 에서 같은 내용이 *두 번 lift up* 될 수 있음.

이것도 cycle 20260430_2 가 hook path 를 추가하면서 짚지 못한 *부수
회귀* 다. 영향:
- recent_turns 가 같은 user 메시지를 두 번 inject
- vector / keyword search 결과 중복 가능
- LTM 에는 영향 없음 (record_message 만 STM)

## 7. 정확한 fix 방향 (다음 cycle 의 후보)

### F1. stage 번호 정정 (가장 중요, 간단)

`agent_session.py` 의 두 자리:
* line 1442: `mutator.set_stage_model(15, memory_cfg)` → `set_stage_model(18, memory_cfg)`
* line 1499: `if getattr(st, "order", None) == 15` → `== 18`
* 인접 변수명 `s15_stage` → `s18_stage`
* 옆 주석 `# s15 (memory)` → `# s18 (memory)`

추가로 docstring 정정 (executor 측):
* `geny-executor/.../s18_memory/stage.py:1` "Stage 15: Memory" → "Stage 18: Memory"
* `geny-executor/.../s18_memory/artifact/default/stage.py:1, 47` 마찬가지

검증:
* memory_model env 가 진짜 메모리 stage 에 wiring
* HITL 이 의도치 않게 memory_model 을 받지 않음
* ReflectionResolver native path 가 s18_memory 의 cfg 를 본다

### F2. memory_distill 의 LLM 호출을 *s18 회로 / 공유 client* 로 통합

선택지:

**옵션 A — `state.llm_client` 를 노출**
* AgentSession 에 `llm_client` getter 추가 (`@property def llm_client`)
* `MemoryDistillTool._run_distill_llm` 가:
  ```python
  caller = _get_caller(session_id)
  client = caller.llm_client          # 공유 client
  cfg = caller.memory_model_cfg       # s18 와 같은 cfg
  resp = await client.create_message(...)
  ```
* 장점: 단일 client. credential drift 0. memory_cfg 자동 일치.
* 단점: AgentSession 의 surface 가 약간 커짐. 도구 hot path 에서 client 직접 접근 — 단순.

**옵션 B — `Pipeline.run_isolated_call(prompt, model_cfg)` helper**
* Pipeline 에 *stage 외부에서* LLM 한 번 호출하는 helper.
* 장점: stage 회로의 일부로 인지될 수 있음.
* 단점: API 추가 부담, executor 측 변경 필요. cycle 1 안에 끝내기 큼.

**옵션 C — distill 을 *defer* 해서 s18 의 reflect 계열 hook 으로**
* `memory_distill` tool 이 즉시 LLM 호출하지 않고, state.metadata 의
  flag 에 적기. 다음 turn 의 s18 가 처리.
* 장점: stage 회로 안.
* 단점: 사용자 명시 호출 흐름과 잘 안 맞음 (즉답 안 됨).

**권장**: 옵션 A. AgentSession 에 1 줄 property + memory_distill 의
`_run_distill_llm` 8 줄 정도 변경. 가장 작은 surface 변경으로 *두
회로의 LLM 가 같은 client* 로 통합됨.

### F3. Geny hook ↔ s18 _record_transcript 의 *중복 기록* 제거

현재 user input 은:
1. `_invoke_pipeline` 시작 (Geny hook): `record_message("user", input, metadata=event_meta)`
2. s18 의 `_record_transcript`: `record_message("user", content)` (state.messages
   에서 같은 input 이 다시)

해결책:
* (a) Geny hook 측이 *Pipeline 안의 자기 record* 를 *생략* 시키는 marker
  를 state.metadata 에 박기 — `state.metadata["_stm_recorded_externally"]
  = True`. s18 의 `_record_transcript` 가 이 마커를 보면 skip.
* (b) GenyMemoryStrategy 의 `_record_transcript` 가 metadata 인자를
  *건너 받기* — Pipeline state 에 cycle 20260430_2 metadata 를 동행
  시키는 path 신설. 큰 변경.
* (c) s18 의 `_record_transcript` 를 *aware* 하게 — STM 의 *최근 N
  라인* 의 content 와 hash 비교 후 dedupe. 보수적.

권장: (a). Geny hook 이 record_message 를 호출한 turn 동안 s18 의
record_transcript 가 같은 메시지를 다시 적지 않도록. 작은 변경.

### F4. s19 / s20 의 추가 검토 (옵션)

* s19_summarize — 세션 요약. memory_model 과 같은 cfg 를 쓰는 게
  자연스러울 수 있음. 현재 wiring 안 됨 → 별 cycle 후보.
* s20_persist — 종단 저장. memory persistence 와 별개. 검토만.

## 8. 회로 정합성 체크리스트 (다음 cycle 의 시작점)

1. [ ] `agent_session.set_stage_model(18, memory_cfg)` — stage 번호 정정
2. [ ] `agent_session` 의 `s15_stage = ... order == 15` → `s18_stage = ... order == 18`
3. [ ] geny-executor s18_memory 의 docstring "Stage 15" → "Stage 18"
4. [ ] AgentSession.llm_client property 추가 + memory_model_cfg getter
5. [ ] memory_inspect_tools._run_distill_llm 가 위 property 사용
6. [ ] cycle 20260430_2 의 InteractionEvent metadata 가 *Pipeline state* 까지
   동행하도록 path — 또는 state.metadata 의 dedupe marker (F3)
7. [ ] _record_transcript 의 dedupe — Geny hook 외부 기록과 충돌 X

## 9. 본 audit 의 invariant 들

* **Pipeline 안의 모든 LLM 호출은 단일 `state.llm_client` 를 사용** —
  cycle 20260421_4 의 명시적 약속. 본 cycle 의 fix 가 그 약속을 *외부
  도구 호출* 까지 확장한다.
* **stage 번호는 코드의 진실** (`stage.order = 18`) 을 따른다 —
  주석 / 변수명 / mutator 호출이 *모두* 일치해야 한다.
* **메모리 hook 은 한 자리에서만 STM 에 쓴다** — Geny hook 또는 s18
  중 *하나만*. 같은 메시지의 두 record 는 회귀.

## 10. 사용자 질문에 대한 직접 답변

> **Q.** "API key 가 있으면 memory_distill(narrative=true) 가 자동으로
> LLM 호출. 없으면 narrative=null 으로 silent — 기존 동작과 동일."
> 이건 뭔소리야 우리 Environment의 18단계 메모리 로직을 사용하는 것
> 아니야?

**A.** 사용자 지적이 옳다. cycle 20260430_3 F 의 distill 은
*별개의 client* 를 만들어 호출 — s18_memory 회로와 분리. **동시에**,
agent_session 의 stage 번호 wiring 자체도 옛 번호 (15) 에 머물러 있어
*정상 흐름의 메모리 reflection 도 의도된 stage 가 아닌 HITL stage 의
override 를 보고* 있다. 즉 두 레이어 모두에 분리/wiring 오류가
있었다. 본 audit 이 두 결함을 명시했고, F1~F3 단계로 정정 가능.

## 11. 다음 단계

[`plan/cycle_plan.md`](../plan/cycle_plan.md) 에서 위 F1~F3 의 PR
ladder 를 구체화한다 — *stage 번호 정정 → AgentSession.llm_client
property → distill 통합 → 중복 기록 제거* 의 4 PR. 각 단계는 독립적
이고 add-only / patch-only 형태로 머지 가능.
