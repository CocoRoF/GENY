# Cycle 20260430_1 — Progress / Cycle complete

> Goal recap: VTuber ↔ Sub-Worker DM dual-dispatch 회로 정리
> ([analysis/01_subworker_dm_dual_dispatch.md](../analysis/01_subworker_dm_dual_dispatch.md),
> [plan/cycle_plan.md](../plan/cycle_plan.md)).

## PR ladder

| Step | PR | What it changed | Tests |
|---|---|---|---|
| docs | [#586](https://github.com/CocoRoF/Geny/pull/586) | analysis + cycle plan | docs only |
| P0-1 | [#587](https://github.com/CocoRoF/Geny/pull/587) | `AgentSession._explicit_subworker_report_sent` flag → `_notify_linked_vtuber` early-return when worker already DM'd a structured payload | `test_notify_linked_vtuber_skips_when_explicit_report_sent` |
| P0-2 | [#588](https://github.com/CocoRoF/Geny/pull/588) | `ExecutionResult.tool_calls` 1급화 + `_compose_subworker_payload_from_tools` (yaml-ish status/summary/details/artifacts 합성) | 5 unit + 1 e2e |
| P0-3 | [#589](https://github.com/CocoRoF/Geny/pull/589) | "Task finished with no output." 평문 송출 제거 — 진짜 빈 turn 은 dispatch 없이 `delegation.suppressed_empty_turn` 만 로그 | `test_notify_linked_vtuber_skips_when_nothing_happened` |
| P1-1 | [#590](https://github.com/CocoRoF/Geny/pull/590) | `_maybe_save_paired_dm_reply` — paired sub→vtuber DM 응답을 chat room 에 한 번 노출 | 6 cases (paired / unpaired / 역방향 / peer / missing / swallow) |
| P1-2 | [#591](https://github.com/CocoRoF/Geny/pull/591) | `inbox.deliver(metadata=…)` + `_drain_inbox` per-pass `(sender, tag)` dedupe | 5 cases (round-trip / dedupe / 다른 sender / tag-less 무영향) |
| P1-3 | [#592](https://github.com/CocoRoF/Geny/pull/592) | `_strip_only_loop_signals` (`[TASK_COMPLETE]` 단독 출력 → 합성 경로) + worker.md/vtuber.md 계약 명시 | 4 unit + 1 e2e + 2 prompt regression |
| P1-4 | [#593](https://github.com/CocoRoF/Geny/pull/593) | `[THINKING_TRIGGER:sub_worker_working]` 에 90s cooldown — 긴 sub-worker 작업 중 "워커가 작업 중이야" 반복 차단 | 5 cases |

8 PR, 모두 merge 완료, branch 모두 정리됨.

## Behaviour matrix — before vs. after

| 시나리오 | Before | After |
|---|---|---|
| worker 가 도구 호출 + 평문 X + 명시 DM yaml O | 사용자 화면에 `[SUB_WORKER_RESULT] Task finished with no output.` 가 wrap 된 빈 발화 | 사용자 화면에 worker 의 yaml 페이로드를 풀어낸 VTuber 발화 1회 |
| worker 가 도구 호출 + 평문 X + 명시 DM 누락 | 같은 빈 발화 | `_compose_subworker_payload_from_tools` 가 합성한 yaml (Tools used / artifacts / status) 을 풀어낸 발화 1회 |
| worker 가 평문만 + 도구 0 (간단 답변) | wrap 후 발화 | 변동 없음 (예전 그대로) |
| worker 가 `[TASK_COMPLETE]` 단독 (도구 X) | "Task completed successfully.\n\n[TASK_COMPLETE]" 발화 — 의미 없음 | dispatch 없음, `delegation.suppressed_empty_turn` 만 로그 |
| worker 가 `[TASK_COMPLETE]` 단독 (도구 O) | 같은 무익 발화 | 도구 합성 yaml → 정상 발화 |
| worker 실패 (CancelledError) | "Task finished with no output." | "Task failed: …" 그대로 |
| VTuber busy → inbox fallback 두 번 | 같은 무내용 메시지 두 번 invoke | 두 번째부터 dedupe 스킵 |
| 긴 작업 중 idle tick 6회 | "워커가 작업 중이야" 6회 반복 | 1회 narrate, cooldown 후에만 다시 |
| VTuber 가 페이로드 평문/빈 받았을 때 | 종종 "출력이 없네요" 라고 사용자에게 narrate | 프롬프트가 silent close-of-loop 으로 명시 |

## 구조적 변화 요약

* `ExecutionResult` 에 `tool_calls: List[Dict]` 가 1급 시민이 되었다 — 다른 서브시스템 (timeline, admin, LTM) 도 추후 같은 데이터를 활용할 수 있는 토대.
* `inbox.deliver` 의 메시지 dict 에 `metadata` 키가 영구 추가됨. 향후 다른 종류의 dedupe / routing 에 재활용 가능.
* `_notify_linked_vtuber` 가 (1) explicit-report suppression → (2) 도구 합성 → (3) skip 의 깔끔한 ladder 로 단순화됨.
* prompt 두 파일 (worker.md, vtuber.md) 이 SUB_WORKER_RESULT 를 단일 채널로 명문화.

## 회귀 위험 / 다음 cycle 후보

* `service/prompt/protocols.py` 의 `[TASK_COMPLETE]` 가르침은 변동 없음. 페어 미해당 worker 모드는 그대로 동작.
* `_save_subworker_reply_to_chat_room` 호출 사이트가 두 곳 (Path A: P1-1, Path B: 기존 `_notify_linked_vtuber._trigger_vtuber`). 둘은 P0-1 의 explicit-report flag 로 mutual exclusion 됨 — 동시 dispatch 불가능.
* `_strip_only_loop_signals` 의 정규식은 단독 마커만 제거. 사람 narration 안에 마커가 섞여 있으면 보존 — `test_strip_signals_preserves_real_narration` 으로 잠금.

다음 cycle 후보 (cycle plan 의 P2 항목들):

* `delegation.py` 격상: 송신/수신 라우팅 책임을 한 모듈로 모으기.
* `ExecutionResult` 에 `files_written`, `files_read` 같은 *카테고리 별* 누적 도구 이력 (현재는 raw `tool_calls` list).
* timeline / admin 패널의 "최근 활동" 에 새 `tool_calls` 데이터를 직접 매핑.

## 운영 메모

* 실제 사용자 환경에서 검증 필요한 항목 (자동 회귀가 잡지 못하는 부분):
  * 한국어 vtuber.md 프롬프트가 silent close-of-loop 룰을 잘 따르는지 — 한국어 LLM 회귀 시 추적.
  * 도구 합성 yaml 의 `summary` 가 영문이라도 VTuber 가 자연스럽게 한국어로 paraphrase 하는지 — 화이트리스트 외 도구 (browser_*, web_*) 가 들어왔을 때 `Tools used: …` 라인 가독성.
* 배포 전 backend 컨테이너 재시작 필요 — singleton `InboxManager` 가 새 schema (metadata 키) 를 사용하도록.
