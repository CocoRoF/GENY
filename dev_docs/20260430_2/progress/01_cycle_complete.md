# Cycle 20260430_2 — Progress / Cycle complete

> Goal recap: VTuber 의 *모든 상호작용을 단일 InteractionEvent
> stream 으로* 통합 관리. Sub-Worker DM, 사용자 chat, 자기 reflection
> 모두 같은 memory model 위에 산다.
>
> 분석 / 철학:
> [`analysis/03_memory_unification.md`](../analysis/03_memory_unification.md).
> Plan: [`plan/cycle_plan.md`](../plan/cycle_plan.md).

## PR ladder

| Step | PR | What it changed | Tests |
|---|---|---|---|
| docs | [#595](https://github.com/CocoRoF/Geny/pull/595) | analysis (01/02/03) + plan | docs only |
| A1 | [#596](https://github.com/CocoRoF/Geny/pull/596) | InteractionEvent schema + helper (`Kind`, `Direction`, `CounterpartRole`, `make_event_metadata`, `parse_event_metadata`, `canonical_user_id`, `new_event_id`) | 14 unit |
| A2 | [#597](https://github.com/CocoRoF/Geny/pull/597) | outgoing DM 어댑터 — `_record_dm_on_sender_stm` 가 `target_session_id` 받아 metadata 빌드. `record_message` 가 `metadata=` positional. `PAIRED_VTUBER` 추가 | 6 cases |
| A3 | [#598](https://github.com/CocoRoF/Geny/pull/598) | incoming DM via invoke `source_metadata` + `infer_input_metadata` parser fallback. `_trigger_dm_response` 가 explicit metadata 전달 | 5 + 5 cases |
| A4 | [#599](https://github.com/CocoRoF/Geny/pull/599) | `_categorize_tool_calls` + `_record_subworker_run_on_vtuber` — *dispatch 와 무관하게* tool_run_summary InteractionEvent 가 VTuber STM 에 영구 기록. linked_event_id 자동 매칭 | 9 cases |
| A5 | [#600](https://github.com/CocoRoF/Geny/pull/600) | `ThinkingTriggerService._build_reflection_metadata` — 자기 prompt 의 trigger 카테고리에서 reflection metadata 합성, `execute_command(... source_metadata=...)` 로 전달 | 5 cases |
| A6 | [#601](https://github.com/CocoRoF/Geny/pull/601) | user chat 두 방향 metadata — `infer_input_metadata` 가 role==user → USER_CHAT/IN, assistant 응답 record 에 USER_CHAT/OUT | 3 + 기존 무영향 |
| B1 | [#602](https://github.com/CocoRoF/Geny/pull/602) | `memory_status(counterpart?)` — L0 한 줄 snapshot. 공통 helpers (`_resolve_counterpart_id`, `_summarise_event` 등) 정착 | 12 cases |
| B2 | [#603](https://github.com/CocoRoF/Geny/pull/603) | `memory_with(counterpart, kinds?, limit, since?)` — L1 list, event_id 포함 | 9 cases |
| B3 | [#604](https://github.com/CocoRoF/Geny/pull/604) | `memory_event(event_id)` — L2 full payload + parent linked. cross-session lookup 차단 | 6 cases |
| B4 | [#605](https://github.com/CocoRoF/Geny/pull/605) | `memory_artifact(event_id, path)` — L3 파일 본문 read (4-fold guardrail: declared/absolute/traversal/workspace) | 9 cases |
| B5 | [#606](https://github.com/CocoRoF/Geny/pull/606) | 기존 `memory_search` 확장 — counterpart/kinds 필터 옵셔널, LTM 노트는 필터 영향 X | 8 cases |
| C | [#607](https://github.com/CocoRoF/Geny/pull/607) | `memory_distill(counterpart, max_events?, update_note?)` — counterpart 별 stats + 옵셔널 `entities/<id>.md` 갱신 | 8 cases |
| D | [#608](https://github.com/CocoRoF/Geny/pull/608) | vtuber.md "## Recalling Your Memory" 사다리 가이드 + `_PLATFORM_TOOL_SOURCES` 에 `memory_inspect_tools` 등록 + 회귀 테스트 | 2 cases |

총 14 PR (docs 1 + A 6 + B 5 + C 1 + D 1), 모두 main 머지, 모든 브랜치 정리됨.

## 4 invariants — 모두 보존

| # | Invariant | 검증 |
|---|---|---|
| 1 | InteractionEvent 는 STM metadata dict 안에 산다 — *별도 store 0* | A1~A6 모든 hook 이 `record_message(role, content, metadata=…)` 만 사용. 새 store / DB 테이블 추가 0. |
| 2 | 모든 hook 은 항상 metadata 를 채운다 | A2 production 호출 site (DM tools) 모두 `target_session_id=...` 전달; A4 는 dispatch 와 *무관* 하게 항상 record; A5 explicit; A6 explicit. legacy fallback 만 metadata=None. |
| 3 | 모든 도구는 caller 의 자기 memory 만 본다 | B1~C 의 모든 도구가 `_get_caller(session_id)` 의 `_memory_manager` 만 read. cross-session lookup 회귀 테스트 (B3 `test_event_caller_only_sees_own_stm`). |
| 4 | prompt-side 데이터 inject 0 byte | system prompt builder (`sections.py` / `attach_runtime`) 변동 0. D1 의 vtuber.md 단락은 *catalog 안내* 일 뿐 — 사용자/세션별 동적 데이터 미주입. |

## 새로 가능해진 일

VTuber 가 사용자 질문에 답하기 위해 *능동적으로* 자기 기억을 walk:

```
사용자: "어제 워커가 뭐 했어?"

VTuber 추론 →
  memory_status(counterpart="paired_subworker")
    ↳ { paired:true, last_event:{event_id:"E5", kind:"tool_run_summary", summary:"…", status:"ok", files_written_count:2} }
  memory_with(counterpart="paired_subworker",
              kinds=["tool_run_summary"], limit=5)
    ↳ { events:[E5, E3, …] }
  memory_event(event_id="E5")
    ↳ { payload:{ files_written:["self_intro.md"], bash_commands:[...], duration_ms:1240 }, linked:{ parent:E4 task_request } }
  memory_artifact(event_id="E5", path="self_intro.md")
    ↳ { content:"안녕…", size_bytes:412 }

VTuber → 사용자에게 paraphrase
```

같은 ladder 가 *사용자 회상*, *peer agent 회상*, *자기 reflection 회상* 도 처리.

```
"내가 어제 무슨 말 했지?"  →  memory_status(counterpart="user") → memory_with → ...
"오늘 내가 뭐 생각했지?"   →  memory_status(counterpart="self")  → memory_with → ...
```

`memory_distill(counterpart, update_note=true)` 로 *오래된 관계* 를 `memory/entities/<id>.md` 로 응축 — 다음 turn 부터 vector / keyword 로 떠오름.

## Stream 이 받는 새 데이터

| Kind | Direction | 언제 기록되는가 |
|---|---|---|
| `user_chat` | in / out | 사용자 chat input + assistant 응답 (A6) |
| `task_request` | out | VTuber → bound sub 의 task DM (A2) |
| `task_result` | in | sub → bound vtuber 의 `[SUB_WORKER_RESULT]` (A2 + A3) |
| `task_request` | in | sub 가 받은 VTuber 의 task DM (A3) |
| `tool_run_summary` | in | 매 sub-worker invoke 종료 시 (A4) — *dispatch 무관* |
| `dm` | in / out | paired-pair 외 DM, peer chatter (A2 + A3) |
| `reflection` | internal | THINKING_TRIGGER / ACTIVITY_TRIGGER (A5) |

모든 line 이 `event_id` + `counterpart_id` + `counterpart_role` 5 차원 dimension 보유 → memory tools 의 filter 가 정확히 동작.

## 미래 확장성 — 이 통합의 *진짜 가치*

새 채널이 들어오면:

| 새 기능 | 추가되는 것 | 도구 표면 변동 |
|---|---|---|
| Peer agent DM | counterpart_role=peer 가 stream 에 등장 (이미 PEER 등록됨) | **0** |
| Multi-VTuber 끼리 DM | counterpart_role=peer | **0** |
| Group chat (room) 부활 | counterpart_id="room:<id>", PEER role | **0** |
| External API caller | enum 1줄 추가 (EXTERNAL) | 도구 인자 하나도 안 바뀜 |

본 cycle 의 design choice 가 미래 비용을 *방어* 한다 — 매 새 기능마다 별 도구를 만들지 않는다.

## 회귀 위험 / 다음 cycle 후보

* **`recent_turns` retriever 의 카운터파트별 균형** — 현재 시간순 N. sub-worker turn 폭증 시 사용자 발화가 밀려나는 부작용 가능. retriever 옵션 추가가 자연스러운 다음 단계.
* **`memory_distill` 의 LLM-driven 풍성한 요약** — 현재 stats only. memory_model 호출은 별 cycle.
* **자동 distillation cron** — counterpart 의 누적 event 가 N개 이상이면 백그라운드에서 distill. 임계치 / 빈도 정책 필요.
* **legacy STM jsonl 의 백필** — 옛 라인은 metadata 없음. retrieval 에서 자동 안 보임. 백필 cron 으로 rough mapping 가능 (content prefix 분석).
* **Group / room 차원** — counterpart_id 의 namespace 확장 (예: `room:<id>`).
* **chat panel UI 의 InteractionEvent stream 시각화** — admin observability.
* **DB 스키마의 metadata 인덱싱** — 큰 deployment 에서 lookup 가속. 현재는 jsonl 의 metadata dict 만 활용.

## 운영 메모

* 본 cycle 의 어떤 변경도 기존 retrieval 를 손상시키지 않는다 — recent_turns / vector / keyword / curated 는 모두 STM/LTM 위에서 *그대로* 동작. metadata 만 풍부해진다.
* 새 도구 5개 (memory_status / _with / _event / _artifact / _distill) 는 `_PLATFORM_TOOL_SOURCES` 에 stem 등록만으로 VTuber 환경에 자동 노출 — 별 manifest 변경 불요.
* legacy DM 호출 site 가 metadata 없이 record_message 하면 전과 같이 동작 (backwards-compat). 단지 새 도구의 결과에 안 잡힘.
* 배포 전 backend 컨테이너 재시작 — InteractionEvent enum / helper 가 import 되도록.

## 다음 cycle 준비

* 본 cycle 이 만든 *환경 (= memory)* 위에서 다음 단계는 *retrieval 정밀도* (counterpart-aware recent_turns) 와 *distillation 의 LLM 통합*. 두 가지 모두 본 cycle 의 invariants 를 깨지 않고 add-only 로 들어올 수 있다.
* 또는 *다른 채널의 InteractionEvent 통합* — peer agent DM / room chat — 도 좋은 다음 후보. 도구 표면 0 변동 약속을 검증할 자리.
