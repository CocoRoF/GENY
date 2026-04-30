# Cycle 20260430_1 — Plan

> Goal: VTuber ↔ Sub-Worker DM 전달 회로의 dual-dispatch 결함을 정리한다.
> 분석은 [analysis/01_subworker_dm_dual_dispatch.md](../analysis/01_subworker_dm_dual_dispatch.md).

각 단계는 독립 PR. 이전 PR 머지 → 다음 PR. 테스트도 같이 추가/갱신.

## P0-1 — dual-dispatch suppression
* `AgentSession` 에 turn-scoped flag `_explicit_subworker_report_sent` 추가.
* `SendDirectMessageInternalTool.run` 가 본문이 `[SUB_WORKER_RESULT]` 로 시작하고
  caller 가 paired sub-worker 일 때 flag 를 set.
* `_notify_linked_vtuber` 가 flag set 이면 자동 발사를 건너뛰고
  `delegation.suppressed_explicit_report` 를 session_logger 에 남김.
* invoke 시작에 flag 리셋.
* 신규 테스트: explicit DM 후 자동 알림이 가지 않음을 확인.

## P0-2 — ExecutionResult 의 tool 이력 1급화
* `ExecutionResult.tool_calls: list[ToolCallSummary]` 추가
  (`name`, `arguments_preview`, `is_error`, `duration_ms`).
* `_invoke_pipeline` 의 `tool.call_complete` 핸들러에서 누적, 마지막에
  `ExecutionResult` 에 부착.
* `_notify_linked_vtuber` 가 `result.output` 이 비었어도 `tool_calls`
  로부터 yaml-ish 페이로드를 합성:
  ```
  [SUB_WORKER_RESULT]
  status: ok|partial|failed
  summary: ...
  details: |
    ...
  artifacts: []
  ```
* 신규 테스트: tool only worker → 의미 있는 페이로드.

## P0-3 — "no output" fallback 정리
* P0-1/P0-2 가 들어가면 잔여 케이스는 *진짜로 아무 일도 없는* 경우
  뿐. 이때 VTuber 알림을 *보내지 않음* (조용히 로그만).
* 신규 테스트: 도구 0 + 텍스트 0 + 명시 보고 0 → 알림 발사 없음.

## P1-1 — Path A 응답 channel 노출
* `_trigger_dm_response._deliver_and_respond` 가 VTuber 응답을
  `_save_subworker_reply_to_chat_room` 로 노출. (sub→vtuber 케이스 한정)
* 단, P0-1 로 Path B 가 발화되지 않으므로 중복 발화는 없음.
* 신규 테스트: explicit DM → VTuber 응답이 chat_room 에 1회 등장.

## P1-2 — inbox dedupe + tag metadata
* `inbox.deliver` 에 `metadata: dict | None` 추가.
* `_notify_linked_vtuber` 가 inbox fallback 시 `metadata={"tag": ...,
  "task_id": ...}` 를 같이 적재.
* `_drain_inbox` 가 동일 turn 동안 같은 tag+task 의 두 번째 무내용
  메시지를 스킵.

## P1-3 — prompt 계약 단순화
* `prompts/worker.md` 의 "끝에 [TASK_COMPLETE] 를 붙여라" 를 *내부 신호
  전용* 으로 격하. SUB_WORKER_RESULT 는 명시 DM 단일 경로로 통일.
* `prompts/vtuber.md` 의 `## Triggers` SUB_WORKER_RESULT 항목에
  "본문이 평문이거나 비어 있으면 사용자에게 발화하지 말 것" 규칙 추가.

## P1-4 — sub_worker_working cool-down
* `ThinkingTriggerService` 에 `_subworker_working_cooldown` 도입.
* 마지막으로 sub_worker_working 트리거를 발화한 시각 + 마지막으로
  worker 가 끝난 시각을 기록. 직후 N 초 안에 worker 가 끝났다면 trigger
  를 발화하지 않음.

## 진행 규칙
* 각 단계 PR 본문에 본 plan 문서 + analysis 문서 링크.
* 테스트가 깨지면 즉시 갱신해서 같은 PR 에 포함.
* 머지 후 `progress/0X_<step>.md` 에 결과/회귀 메모 한 줄 남김.
