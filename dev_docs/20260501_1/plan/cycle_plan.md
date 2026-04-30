# Cycle 20260501_1 — Plan

> Goal: 사용자 철학 — *"산발적 메모리 로직이 아니라 geny-executor /
> Geny 를 아우르는 강력한 하나의 메모리 flow 가 존재해야 한다.
> 메모리는 geny-executor 기반 Environment (Pipeline) 의 Stage 18 로
> 정의되며, VTuber Environment 가 그것을 통해 작동해야 한다."*
>
> 분석 / audit:
> [`analysis/01_memory_circuit_audit.md`](../analysis/01_memory_circuit_audit.md).

본 cycle 의 *통합 invariants* (Stage 18 중심):

1. **Pipeline 의 모든 LLM 호출은 단일 `state.llm_client` 를 통해
   흐른다.** 외부 도구의 LLM 호출도 동일 client + s18 의 `model_cfg`
   를 재사용 — credential drift 0.
2. **STM 의 모든 raw write 는 한 자리에서만 일어난다** —
   `SessionMemoryManager.record_message`. Geny 측 hook 의 *외부
   기록* 과 s18 의 `_record_transcript` 가 *동일 entry 를 두 번 적지
   않는다*.
3. **stage 번호는 코드의 진실을 따른다** — `s18_memory.stage.order = 18`,
   `s15_hitl.stage.order = 15`. agent_session.py 가 그 숫자를 그대로
   wiring한다.
4. **InteractionEvent metadata 가 stream 의 1급 시민** — Geny
   hook 들이 채우는 metadata 가 그대로 STM jsonl 에 living, retrieval /
   transcripts API / Stream UI / search 가 동일 schema 를 본다.

---

## Stage A — stage 번호 wiring 정정

### A1 — `agent_session.set_stage_model(15, ...)` → `set_stage_model(18, ...)`

**무엇**

`backend/service/executor/agent_session.py` 두 자리:

* line ~1442: `mutator.set_stage_model(15, memory_cfg)` → `set_stage_model(18, memory_cfg)`
* line ~1498-1501: `s15_stage = next(... order == 15 ...)` → `s18_stage = ... order == 18`
* `s15_stage` 변수명 → `s18_stage`
* 인접 주석 `# s15 (memory)` → `# s18 (memory)` (모든 발생처)
* 옆의 옛 cycle 주석 (`cycle-4`) 가 가리키는 stage 라벨도 정정

**왜**

stage list 가 18 → 21 stages 로 확장되며 메모리 stage 가 order 15 → 18
로 이동했지만 wiring 미반영. 결과 — APIConfig.memory_model 이 진짜
메모리 stage 에 영영 안 들어가고 HITL stage 의 model_override 로 박힘.

**테스트**

* (신규) `test_memory_model_wired_to_s18` — `_build_pipeline` 후 s18
  stage 의 model_override 가 memory_cfg 임을 확인. s15_hitl 의
  model_override 는 None.
* (신규) `test_reflection_resolver_targets_s18` — resolver 의
  `has_override` / `resolve_cfg` 가 s18 stage 를 본다.

**Risk**: tests 인프라 (전체 pipeline build) 가 무거우면 minimal
mock 으로 stage 검색만 검증.

---

## Stage B — 단일 LLM client 통합

### B1 — `AgentSession` 가 공유 client + memory cfg 를 노출

**무엇**

`backend/service/executor/agent_session.py`:

```python
@property
def llm_client(self) -> Optional["BaseClient"]:
    """Shared LLM client (cycle 20260421_4) attached to this session.
    Used by every stage via state.llm_client; tools may reuse it for
    out-of-pipeline LLM calls (cycle 20260501_1 B)."""
    return self._llm_client_handle

@property
def memory_model_cfg(self) -> Optional["ModelConfig"]:
    """Live ModelConfig used by s18_memory's reflection LLM call."""
    return self._memory_cfg_handle
```

`_build_pipeline` 가 attach_runtime 직후 위 두 핸들을 self 에 보존.
나중에 도구가 caller agent 를 lookup 해 호출.

**왜**

`memory_distill` 같은 외부 도구가 *별 client* 를 만드는 게 아니라
agent 의 공유 client 를 *재사용* 하기 위한 surface.

**테스트**

* (신규) `test_agent_session_exposes_llm_client_after_build` —
  build 후 `agent.llm_client is not None` 확인.
* `test_agent_session_memory_cfg_matches_apiconfig` —
  `agent.memory_model_cfg.model == apiconfig.memory_model`.

### B2 — `memory_distill._run_distill_llm` 이 위 property 사용

**무엇**

`backend/tools/built_in/memory_inspect_tools.py:_run_distill_llm`:

```python
def _run_distill_llm(*, session_id, counterpart_id, counterpart_role, stats):
    caller = _get_caller(session_id)
    client = getattr(caller, "llm_client", None)
    cfg = getattr(caller, "memory_model_cfg", None)
    if client is None or cfg is None:
        return None
    user_prompt = _build_distill_user_prompt(...)
    response = _bridge_async(client.create_message(
        model_config=cfg,
        messages=[{"role": "user", "content": user_prompt}],
        system=_DISTILL_SYSTEM_PROMPT,
        purpose="memory.distill_narrative",
    ))
    return _extract_text_from_response(response)
```

`ClientRegistry.get(provider)(...)` 호출, `APIConfig` 직접 로드,
별 ModelConfig 빌드 — 모두 제거. caller 의 공유 핸들만 사용.

**왜**

cycle 20260421_4 의 single-client 약속을 *외부 도구 호출* 까지 확장.
distill 의 cfg 가 자동으로 s18 의 cfg 와 일치 — APIConfig.memory_model
변경이 즉각 반영.

**테스트**

* `test_distill_uses_caller_llm_client` — caller agent 에 fake client +
  fake cfg 를 박은 후 narrative=True 호출 시 *그 client 가* 호출됨.
* `test_distill_silent_when_caller_has_no_client` — client/cfg 없으면
  narrative=null silent.
* 기존 `test_distill_narrative_calls_llm_when_requested` 등은
  helper 모킹 path 를 통해 그대로 통과 (signature 만 바뀜).

---

## Stage C — STM 의 단일 write source

### C1 — `_invoke_pipeline` 의 record_message 호출이 state metadata 에 marker 박음

**무엇**

`backend/service/executor/agent_session.py:_invoke_pipeline` /
`_astream_pipeline`:

* `_PipelineState` 를 *record_message 호출 *전에* 생성*
* record_message 호출 후, state.metadata 의 marker 카운터 증가:
  ```python
  _state.metadata["_geny_external_record_count"] = (
      _state.metadata.get("_geny_external_record_count", 0) + 1
  )
  ```
* assistant record 도 마찬가지

**왜**

s18 의 `_record_transcript` 가 *Geny 가 이미 적은 entry 의 수만큼*
state.messages 의 head 부분을 skip 하도록 marker.

### C2 — `GenyMemoryStrategy._record_transcript` dedupe

**무엇**

`backend/service/memory_provider` 또는 신규 wrapper —
`GenyDedupeStrategy(GenyMemoryStrategy)` 가 `_record_transcript` 를
override:

```python
class GenyDedupeStrategy(GenyMemoryStrategy):
    """Cycle 20260501_1 C — when AgentSession._invoke_pipeline already
    recorded the canonical user/assistant entry into STM, s18's
    transcript writer must not re-record the same content from
    state.messages.

    state.metadata['_geny_external_record_count'] indicates how many
    head messages of state.messages were already recorded externally
    with full InteractionEvent metadata. _record_transcript skips
    that prefix.
    """
    def _record_transcript(self, state):
        external = state.metadata.get("_geny_external_record_count", 0)
        already = state.metadata.get("_stm_recorded_count", 0)
        # Effective "new" head pointer: max of two markers
        recorded_count = max(already, external)
        new_messages = state.messages[recorded_count:]
        ...
```

`agent_session._build_pipeline` 가 `attach_kwargs["memory_strategy"]
= GenyDedupeStrategy(...)` 사용.

**왜**

같은 user/assistant 메시지가 STM 에 두 번 적히는 회귀 (audit §6)
제거. *Geny hook 측의 풍부한 metadata 라인 한 번만* 살아 남음.

**테스트**

* `test_strategy_skips_externally_recorded_prefix` —
  `state.metadata['_geny_external_record_count'] = 2` 일 때 처음 2
  메시지를 skip.
* end-to-end (smoke): 한 invoke 종료 후 STM 에 user 1 + assistant 1
  만 들어감. 둘 다 metadata 채워짐.

---

## Stage D — `_record_subworker_run_on_vtuber` 의 통합 (옵션)

### D1 — `_trigger_dm_response` 가 source_metadata 에 SubWorkerRun payload 포함

**무엇**

cycle 20260430_1 P0-2 의 `_compose_subworker_payload_from_tools` 가
만든 `_categorize_tool_calls` 결과를 `_trigger_dm_response` 의
`source_metadata` 의 payload 에 동행. VTuber 의 invoke 가 시작될 때
record_message 가 그 metadata 를 그대로 STM 에 적는다.

이로 인해 `_record_subworker_run_on_vtuber` 가 *redundant* — Geny 의
record_message 한 번이 SUB_WORKER_RESULT 본문 + payload 양쪽 다 적음.

### D2 — `_record_subworker_run_on_vtuber` 제거

**무엇**

`_notify_linked_vtuber` 의 `_record_subworker_run_on_vtuber(...)`
호출 제거. VTuber 의 STM 에 *직접* write 하는 자리가 없어짐 — 모든
write 는 VTuber 자기 invoke 의 s18 가 처리.

**왜**

audit §6 의 *cross-session direct write* 는 architectural 위반. D1
이 source_metadata 에 payload 를 동행 시키면 정상 path 로 흐르며
같은 효과.

**테스트**

* `test_notify_propagates_payload_via_source_metadata` — D1 호출이
  payload 동행하는지.
* `test_no_direct_vtuber_stm_write_after_cycle_20260501_1` — sub-worker
  invoke 종료 시 vtuber memory 에 *추가* record_message 호출 안 함
  (call site 검색).
* 기존 `test_record_subworker_run_writes_tool_run_summary_metadata`,
  `test_record_subworker_run_links_back_to_recent_task_request` 등은
  *D2 의 path 변경 후* 새 path 의 동등성 (VTuber 자기 invoke 가
  같은 metadata 의 entry 를 STM 에 적는다) 으로 갱신.

---

## Stage E — Documentation + final progress

* `progress/01_cycle_complete.md` — PR ladder + invariants 검증 +
  통합된 회로 그림 + 다음 cycle 후보 (Stage 18 의 MemoryProvider 정통
  통합 / outgoing DM 의 ToolContext-state push 등)

---

## 의존성 / PR 순서

```
A1 (stage 번호 정정)
   │
   ▼
B1 (AgentSession.llm_client / memory_model_cfg)
   │
   ▼
B2 (memory_distill 통합)
   │
   ▼
C1 (invoke_pipeline marker)
   │
   ▼
C2 (GenyDedupeStrategy)
   │
   ▼
D1 (source_metadata payload)
   │
   ▼
D2 (_record_subworker_run_on_vtuber 제거)
   │
   ▼
E (progress)
```

각 단계 독립 PR. A1 만 머지해도 즉시 효과 (memory_model 환경변수가
*드디어 진짜 stage 에 wiring* 됨).

---

## 매 PR 의 *공통 첫 테스트* (4 invariants 검증)

각 PR 의 PR body 에 다음 명시:

* [ ] stage 번호는 코드의 진실 (`s18_memory.stage.order = 18`) 을 따른다
* [ ] 모든 LLM 호출은 `state.llm_client` 또는 `agent.llm_client` 를 사용
* [ ] STM record_message 는 *한 자리에서만 동일 turn 의 동일 메시지를 적는다*
* [ ] InteractionEvent metadata 5 dimension 이 채워진다 (cycle 20260430_2 invariant 그대로)

---

## Non-goals (이 cycle 에서 안 한다)

* MemoryProvider 인터페이스 정통 통합 — `s18_memory.execute` 의
  `if self._provider is not None: await self._drive_provider(state)` path
  활성. 별 cycle 후보 — 큰 변경.
* Outgoing DM 도구의 *ToolContext → state metadata push* — Geny tool
  이 자기 invoke 의 state 에 직접 push 하는 patten. 별 cycle.
* Vector index 의 InteractionEvent metadata 인덱싱 — 검색 정확도 ↑
  지만 별 cycle.
* DB schema 의 metadata 컬럼 인덱싱.
