# Cycle 20260501_1 — Progress / Cycle complete

> Goal recap: 사용자 철학 — *"산발적 메모리 로직이 아니라 geny-executor /
> Geny 를 아우르는 강력한 하나의 메모리 flow. Stage 18 의 메모리 로직이
> Environment (Pipeline) 의 정상 흐름으로 동작하고, VTuber Environment 가
> 그것을 통해 작동해야 한다."*
>
> 분석 / 철학:
> [`analysis/01_memory_circuit_audit.md`](../analysis/01_memory_circuit_audit.md)
> Plan: [`plan/cycle_plan.md`](../plan/cycle_plan.md)

## PR ladder

| Stage | PR | What it changed | Tests |
|---|---|---|---|
| audit | [#619](https://github.com/CocoRoF/Geny/pull/619) | 두 결함의 코드-line 수준 audit (522줄) | docs |
| plan | [#620](https://github.com/CocoRoF/Geny/pull/620) | 4-stage fix ladder + 4 cycle invariants | docs |
| A1 | [#621](https://github.com/CocoRoF/Geny/pull/621) | stage number 15 → 18 (memory_cfg + ReflectionResolver) | 5 cases (s18 receives memory_cfg, s15 unchanged, resolver targets s18) |
| B | [#622](https://github.com/CocoRoF/Geny/pull/622) | `AgentSession.llm_client` / `memory_model_cfg` property + memory_distill 가 사용 | 2 + 1 신규 (shared client thread-through) |
| C | [#623](https://github.com/CocoRoF/Geny/pull/623) | `GenyDedupeStrategy(GenyMemoryStrategy)` — STM 단일 write site = s18 | 8 + 8 재작성 cases |
| D | [#624](https://github.com/CocoRoF/Geny/pull/624) | `_record_subworker_run_on_vtuber` 제거 → source_metadata thread; inbox 가 interaction_event 보존; drain 이 re-thread | 4 + 1 신규 |

총 6 PR, 모두 main 머지, 모든 브랜치 정리됨.

## 완성된 메모리 flow — 한 그림

```
┌────────────────────────────────────────────────────────────────────────┐
│  Geny 측 hook (외부 record_message 직접 호출은 모두 제거됨)             │
│    cycle 20260501_1 C — invoke_pipeline 가 metadata 만 resolve 후       │
│    state.metadata['_pending_message_metadata'] 에 stamp                │
└──────────────────┬─────────────────────────────────────────────────────┘
                   │
                   │  Pipeline.run / run_stream
                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│  geny-executor 의 21-stage Pipeline                                    │
│   s01 → s02 (GenyMemoryRetriever)                                       │
│      → s03 → s04 → s05 → s06 (LLM via state.llm_client)                │
│      → s07 → s08 → s09 → s10 → s11 → s12 → s13 → s14                    │
│      → s15 (HITL) → s16 → s17                                           │
│      → s18_memory ← STM 의 *유일한 write site*                          │
│         GenyDedupeStrategy (cycle 20260501_1 C)                         │
│           _record_transcript: state.messages → record_message            │
│              metadata = state.metadata['_pending_message_metadata']     │
│           _reflect: state.llm_client.create_message                     │
│              cfg = s18_stage.resolve_model_config(state)                │
│              ← cycle 20260501_1 A1 가 *진짜 s18* 에 wiring             │
│      → s19 → s20 → s21                                                  │
└────────┬───────────────────────────────────────────────────────────────┘
         │  state.llm_client + s18.model_override (memory_cfg)
         ▼
┌────────────────────────────────────────────────────────────────────────┐
│  AgentSession.llm_client / memory_model_cfg property                    │
│    cycle 20260501_1 B — same handles exposed for out-of-pipeline       │
│    tool calls (memory_distill etc.). Single client / single cfg.       │
└────────────────────────────────────────────────────────────────────────┘
```

## 4 invariants — 모두 보존 / 회복

| # | Invariant | 검증 |
|---|---|---|
| 1 | Pipeline 의 모든 LLM 호출이 단일 `state.llm_client` | A1 + B 가 회복. memory_distill 도 같은 client 사용. |
| 2 | STM record_message 단일 호출 site | C 의 GenyDedupeStrategy + invoke_pipeline 의 record 호출 제거. D 의 source_metadata thread. |
| 3 | stage 번호는 코드의 진실 | A1 — `s18_memory.stage.order = 18` 과 wiring 일치. 회귀 테스트로 잠금. |
| 4 | InteractionEvent metadata 5 dimension 1급 시민 | C 의 pending_message_metadata + D 의 source_metadata 로 *모든 write 가 metadata 동행*. |

## Sub-Worker 결과의 통합 path

```
[Sub-Worker invoke 종료]
  ExecutionResult { tool_calls, duration_ms, cost_usd, ... }
                              │
                              ▼
  _build_subworker_run_event_metadata(...)   ← cycle 20260501_1 D
                              │
                              │  TASK_RESULT/in metadata + payload (categorised)
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
   VTuber idle           VTuber busy          (suppressed by P0-1)
   직접 invoke         inbox.deliver(            로그만, 다음 turn 의
   source_metadata=     metadata={               sub-worker 가 다시 보내면
   meta)                  interaction_event:     동일 path
                          meta, ...})
        │                     │
        │                     ▼
        │              _drain_inbox (다음 vtuber turn 종료 시)
        │                     │
        │                     │  inbox metadata.interaction_event
        │                     │  → execute_command(... source_metadata=meta)
        │                     │
        ▼                     ▼
   ┌─────────────────────────────────────────┐
   │ VTuber 의 invoke (cycle 20260501_1 C)    │
   │   pending_message_metadata = {           │
   │     "user": meta (TASK_RESULT/in)        │
   │   }                                      │
   │   pipeline.run                           │
   │     ...                                  │
   │   s18 / GenyDedupeStrategy               │
   │     _record_transcript                   │
   │       record_message("assistant_dm",     │
   │                      content,            │
   │                      metadata=meta)      │
   │     entity_bootstrap (cycle 20260430_3 B)│
   │     _reflect (memory_model 로 LLM)       │
   └─────────────────────────────────────────┘
```

세 path 모두 *동일한 InteractionEvent* 로 STM 에 기록. Stream UI / memory_event /
memory_distill / search 모두 같은 데이터를 본다.

## 사용자 질문에 대한 직접 답변 (cycle 끝)

> *"API key 가 있으면 memory_distill(narrative=true) 가 자동으로 LLM 호출. 없으면 silent. 이건 뭔소리야 우리 Environment의 18단계 메모리 로직을 사용하는 것 아니야?"*

이제 정확히 그렇다:
- `memory_distill` 은 caller AgentSession 의 **`llm_client`** (= s18 의 reflection 이 사용하는 client) 를 그대로 사용
- `memory_model_cfg` 도 caller 의 property 를 그대로 사용 — APIConfig.memory_model 변경이 즉각 반영
- 별 ClientRegistry 호출 / 별 ModelConfig 생성 없음

> *"산발적 메모리 로직이 아니라 geny-executor / Geny 를 아우르는 강력한 하나의 메모리 flow."*

이제 그렇다:
- 모든 STM write = s18 (`GenyDedupeStrategy._record_transcript`)
- 모든 LLM 호출 = `state.llm_client` (in-pipeline) 또는 `agent.llm_client` (out-of-pipeline tool, B)
- 모든 metadata = invoke 시작 시 resolve, state 에 동행, s18 가 record 시 적용
- VTuber Environment 의 *VTuber-paired Sub-Worker* run 도 *VTuber 자기 invoke 의 s18* 가 처리 — cross-session 직접 write 0

## 회귀 위험 / 다음 cycle 후보

* **MemoryProvider 정통 통합** — `s18_memory.execute` 의 `if self._provider is not None: await self._drive_provider(state)` path 활성화. 4-axis contract (`record_turn` / `record_execution` / `reflect` / `promote`) 위에서 SessionMemoryManager 를 wrap. 큰 작업 — 다음 cycle.
* **Outgoing DM 의 ToolContext 통합** — `send_direct_message_internal` 같은 도구가 *자기 invoke 의 state.metadata* 에 push 하고 s18 가 처리. 현재는 `_record_dm_on_sender_stm` 가 *invoke 외부에서* record_message 호출. 본 cycle 의 invariant 와 *부분적으로* 충돌하지 않는데 (invoke 진행 중 sender STM 에 직접 write — 같은 세션) 통합 일관성 위해 이전 가능.
* **Vector index 의 InteractionEvent metadata 인덱싱** — counterpart_id / kind 차원으로 vector search narrow.
* **DB schema 의 metadata 컬럼 인덱싱** — large deployment 대비.
* **자동 distillation cron** — `memory_distill(narrative=true, update_note=true)` 를 임계치 trigger 로 백그라운드 실행.
* **legacy STM jsonl 의 metadata 백필** — 옛 라인 (cycle 20260501_1 이전) 은 metadata 비어 있음 → Stream UI 에 안 보임. content prefix 분석으로 rough mapping.

## 운영 메모

* 본 cycle 의 변경은 모두 *patch-only* — 기존 데이터 무영향. 단지 *새 turn 의 STM 라인이 더 일관* 됨.
* 배포: backend container 재시작 (새 GenyDedupeStrategy / `_build_subworker_run_event_metadata` 가 import 되도록).
* 운영자 검증: 한 turn 후 `<storage>/transcripts/session.jsonl` 의 user/assistant 라인이 *각 1개씩 만* 있는지 + metadata.event_id / kind / counterpart_id 모두 채워졌는지 확인.

## 다음 cycle 준비

본 cycle 이 만든 *통합 메모리 flow* 위에서 다음 후보:

1. **MemoryProvider 통합** — s18 의 4-axis hook path 활성화. SessionMemoryManager 를 MemoryProvider 인터페이스로 wrap. 대규모.
2. **outgoing DM tool path 의 통합** — 마지막 직접 record_message 호출 site 제거.
3. **자동 distill cron** — counterpart 별 임계치 trigger.

세 후보 모두 본 cycle 의 4 invariant 를 깨지 않고 add-only / patch-only 로 들어올 수 있다.
