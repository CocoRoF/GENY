# Cycle 20260501_2 — Progress / Cycle complete

> Goal recap: cycle 20260501_1 정착시킨 *통합 메모리 flow* 위에서, 사용자가
> 운영 중 발견한 *세 핀포인트 결함* 을 — scope 를 늘리지 않고 — 마무리.
>
> 사용자 지시: *"이제 남은 것들을 정말 완벽하게 만들어 놔. 지금 entities가
> memory에 기록되는데 memory_distill에 대해서 계속 나오고 있어. … 내가
> 지시하지 않은 범위를 검토하라는 건 아니야."*
>
> Plan: [`plan/cycle_plan.md`](../plan/cycle_plan.md)

## PR ladder

| Stage | PR | What it changed | Tests |
|---|---|---|---|
| plan | [#626](https://github.com/CocoRoF/Geny/pull/626) | F1 / F2 / F3 ladder + Non-goals | docs |
| F1 | [#627](https://github.com/CocoRoF/Geny/pull/627) | `GenyDedupeStrategy` — 같은 role 후속 메시지에 fresh event_id thread | 2 신규 + baseline 보존 |
| F2 | [#628](https://github.com/CocoRoF/Geny/pull/628) | VTuber session 의 assistant 기본값 USER_CHAT/OUT (stm_role 무관) | 4 신규 (invoke + stream) |
| F3 | [#629](https://github.com/CocoRoF/Geny/pull/629) | `entity_bootstrap` — 기존 파일 stats refresh, stub 영구화 차단 | 3 신규 + skip rule 보존 |

총 4 PR (plan + F1/F2/F3), 모두 main 머지, 모든 브랜치 정리.

## 세 결함이 닫힌 path

```
사용자가 본 데이터:
  session.jsonl line 4 → assistant, metadata=None
  session.jsonl line 6 → assistant, metadata=None
  entities/<id>.md     → "_(아직 distillation 이 진행되지 않았어요…)_"

cycle 20260501_2 후:
  ┌──────────────────────────────────────────────────────────────┐
  │ F1 — GenyDedupeStrategy._record_transcript                    │
  │   같은 turn 의 두 번째 assistant 도 hint 를 template 으로     │
  │   make_event_metadata(...) 새 event_id 발급                   │
  │   ↳ line 4 의 None 닫힘                                       │
  ├──────────────────────────────────────────────────────────────┤
  │ F2 — _invoke_pipeline / _astream_pipeline                     │
  │   stm_role == "user" 또는 self._role == VTUBER 일 때          │
  │   pending_metadata["assistant"] = USER_CHAT/OUT to owner      │
  │   ↳ line 6 (SUB_WORKER_RESULT 입력 → assistant_dm) 도         │
  │     VTuber 는 USER_CHAT/OUT 으로 기록                          │
  ├──────────────────────────────────────────────────────────────┤
  │ F3 — maybe_bootstrap_entity                                   │
  │   파일 존재 시 _refresh_entity_stats 분기:                    │
  │     - STM tail (cap=256) walk, counterpart 매칭 집계          │
  │     - _render_entity_stats_body markdown 생성                 │
  │     - writer.update_note(rel_path, content=body)              │
  │   LLM 호출 없음 (auto distill 은 별 cycle)                    │
  │   ↳ stub 영구화 차단; 매 record_message 가 entity 본문 갱신   │
  └──────────────────────────────────────────────────────────────┘
```

## 4 invariant — 모두 보존

cycle 20260501_1 의 4 invariant 위에서 작업하며 단 한 줄도 회귀시키지 않음.

| # | Invariant | 본 cycle 의 영향 |
|---|---|---|
| 1 | 단일 `state.llm_client` | F1/F2/F3 LLM 호출 없음 — 무관 |
| 2 | STM record_message 단일 호출 site (s18) | F1/F2 가 site 의 *완성도* 를 끌어올림. F3 는 record_message hook (entity_bootstrap) 의 동작 보강 — 별 호출 site 추가 없음 |
| 3 | stage 번호는 코드의 진실 | 무관 |
| 4 | InteractionEvent metadata 5 dimension 1급 시민 | F1/F2 가 dimension 결손을 메움 — 본 cycle 의 *직접 효과* |

## 명시적 Non-goals (건드리지 않음)

사용자가 강조한 *"내가 지시하지 않은 범위를 검토하라는 건 아니야"* 를 반영,
다음은 본 cycle 에서 손대지 않았다.

1. **Outgoing DM ToolContext 통합** — `_record_dm_on_sender_stm` /
   `send_direct_message_internal` 의 외부 record_message 잔존 path.
2. **MemoryProvider 4-axis 활성화** — `s18_memory.execute` 의 Provider
   path. `record_turn` / `record_execution` / `reflect` / `promote`
   contract 를 SessionMemoryManager wrap 으로.
3. **자동 distillation cron** — `narrative=true` 의 임계치 trigger.
4. **Vector index / DB schema 의 InteractionEvent metadata 인덱싱**.
5. **Legacy STM jsonl 백필** — 옛 라인 metadata 비어 있는 건 그대로.

## 운영 메모

* 본 cycle 의 변경은 모두 *patch-only* — 기존 데이터 무영향. 새 turn 부터
  적용.
* 배포: backend container 재시작.
* 운영자 검증:
  - 한 turn 후 `<storage>/transcripts/session.jsonl` 의 *모든* user /
    assistant 라인에 metadata.event_id 가 채워졌는지.
  - SUB_WORKER_RESULT 가 도착한 turn 의 assistant 라인이 USER_CHAT/OUT
    metadata 를 갖는지.
  - `entities/<sanitized>.md` 본문이 stub 이 아닌 stats 로 채워졌는지
    (Events observed: **N** 등).

## 다음 cycle 후보 (변경 없음)

cycle 20260501_1 progress note 의 후보 그대로:

1. **MemoryProvider 4-axis 통합** — s18 의 hook path 활성화.
2. **outgoing DM tool path 통합** — 마지막 직접 record_message 호출
   site 제거.
3. **자동 distill cron** — counterpart 별 임계치 trigger.

세 후보 모두 본 cycle 의 invariant 를 깨지 않고 add-only / patch-only 로
들어올 수 있다.
