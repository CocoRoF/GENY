# VTuber ↔ Sub-Worker DM 처리 구조 심층 분석

> **Cycle**: 20260430_1 · **Author**: investigation pass · **Date**: 2026-04-30
>
> 보고된 증상: VTuber 가 sub-worker 에게 DM 으로 작업을 위임했을 때
> sub-worker 는 실제로 도구를 호출해 작업을 수행하지만, VTuber 는
> "워커가 결과를 돌려줬는데 출력이 없네요" 라고 사용자에게 답하거나
> 같은 작업을 재요청한다. 스크린샷에는
> `[SUB_WORKER_RESULT] Task finished with no output.` 이벤트가
> 그대로 보였고 실제로는 `Write: self_introduction.md` 가 정상 실행된
> 상태였다.
>
> 이 문서는 (1) 현재 메시지 흐름이 어떻게 구성되어 있는지, (2) 어디에서
> 정보가 유실되는지, (3) 어떤 방향으로 고쳐야 하는지를 코드 단위로
> 정리한다.

## 1. 등장 인물

| 컴포넌트 | 위치 | 역할 |
|---|---|---|
| `AgentSession._invoke_pipeline` | [backend/service/executor/agent_session.py:1977](../../../backend/service/executor/agent_session.py#L1977) | geny-executor 파이프라인을 돌려 LLM/tool 이벤트를 누적, 최종 `output` 문자열을 만든다. |
| `execute_command` (+ `_execute_core`) | [backend/service/execution/agent_executor.py:759](../../../backend/service/execution/agent_executor.py#L759) | 모든 invoke 의 단일 엔트리. 끝나면 `_emit_avatar_state`, `_notify_linked_vtuber`, `_drain_inbox` 를 트리거한다. |
| `_notify_linked_vtuber` | [agent_executor.py:183-341](../../../backend/service/execution/agent_executor.py#L183-L341) | sub 세션이 끝나면 자동으로 `[SUB_WORKER_RESULT]` 메시지를 VTuber 로 fire-and-forget 한다. |
| `SendDirectMessageInternalTool` | [backend/tools/built_in/geny_tools.py:818](../../../backend/tools/built_in/geny_tools.py#L818) | sub-worker 가 호출할 수 있는 카운터파트-DM 도구. inbox 적재 + `_trigger_dm_response`. |
| `_trigger_dm_response` | [geny_tools.py:142](../../../backend/tools/built_in/geny_tools.py#L142) | 수신측 세션을 즉시 깨우기 위해 `execute_command(target, "[SYSTEM] You received a direct message ...")` 를 백그라운드로 실행. |
| `ThinkingTriggerService` | [backend/service/vtuber/thinking_trigger.py](../../../backend/service/vtuber/thinking_trigger.py) | VTuber idle 상태에서 `[THINKING_TRIGGER:sub_worker_working]` 등을 주입. unread inbox 가 있으면 idle trigger 대신 `_drain_inbox` 로 양보. |
| `delegation.py` | [backend/service/vtuber/delegation.py](../../../backend/service/vtuber/delegation.py) | `[DELEGATION_REQUEST]` / `[SUB_WORKER_RESULT]` 등의 태그 식별 헬퍼만 제공. 실제 라우팅 결정은 안 한다. |
| `sanitize_for_display` | [backend/service/utils/text_sanitizer.py:39](../../../backend/service/utils/text_sanitizer.py#L39) | 사용자 화면에 닿기 직전 `[SUB_WORKER_RESULT]` / 감정 태그 / `<think>` 를 모두 제거. |
| `prompts/worker.md` | [backend/prompts/worker.md](../../../backend/prompts/worker.md) | sub-worker 가 따라야 할 결과 페이로드 포맷 (`status / summary / details / artifacts`) 정의. |
| `prompts/vtuber.md` | [backend/prompts/vtuber.md](../../../backend/prompts/vtuber.md) | VTuber 가 위 페이로드를 어떻게 사용자 톤으로 풀어낼지 정의. |

## 2. "정상" 시나리오 — 설계 의도

```
USER  ──[chat]──>  VTuber.invoke
                    │ (LLM)
                    ├── 자연 응답 "워커에게 부탁할게요"
                    └── tool: send_direct_message_internal(content="…task…")
                          │
                          │ inbox.deliver(target=worker)
                          └── _trigger_dm_response(worker, "[SYSTEM] DM …")
                                  └── execute_command(worker, "[SYSTEM]…")
                                          │
                                          ▼
                                     Worker.invoke
                                          │ (LLM)
                                          ├── tool: Write(self_introduction.md)
                                          └── tool: send_direct_message_internal(
                                                       content="[SUB_WORKER_RESULT]\n
                                                                status: ok\n
                                                                summary: …")
                                                  │
                                                  └── inbox.deliver(target=VTuber)
                                                       └── _trigger_dm_response(VTuber, "[SYSTEM] DM …")
                                                              └── execute_command(VTuber, …)
                                                                      └── LLM paraphrases → user

                                          ◀── result.output = "" (텍스트 없이 tool-only)

           …그 동안 _execute_core(worker) 가 끝나면…
           ┌── _notify_linked_vtuber(worker, ExecutionResult(output=""))
           │      content = "[SUB_WORKER_RESULT] Task finished with no output."
           └── execute_command(VTuber, content)        # ← 두 번째 트리거
                       └── _save_subworker_reply_to_chat_room(VTuber, …)
                                  └── 사용자 채팅 룸에 노출
```

worker.md 에서 sub-worker 가 호출하도록 가르치고 있는 *명시적 채널*은
`send_direct_message_internal` 한 번이지만, 런타임은 `_notify_linked_vtuber`
라는 *암묵적 채널* 을 추가로 매 invoke 종료마다 발화한다.

## 3. 코드로 본 실제 흐름과 결함

### 3.1 sub-worker 의 `result.output` 은 "LLM 어시스턴트 텍스트" 만 담는다

`_invoke_pipeline` 의 누적 변수는 `accumulated_output` 인데, 여기에
적재되는 이벤트는 **`text.delta`** 와 (구버전 호환용)
**`pipeline.complete`** 의 `result` 필드 뿐이다.

```python
# backend/service/executor/agent_session.py
elif event_type == "text.delta":
    text = event_data.get("text", "")
    if text:
        accumulated_output += text   # ← 어시스턴트 평문만 누적
```

다음 이벤트는 **누적되지 않는다.** 별도 로그로만 흐른다.

* `tool.call_start` / `tool.call_complete`
* `tool.execute_start` / `tool.execute_complete`
* `stage.enter` / `stage.exit` / `stage.bypass`
* `loop.escalate` / `tool_review.flag` / `hitl.*`

즉 sub-worker 가
`Write(self_introduction.md)` 하나만 호출하고 LLM 텍스트는
`[TASK_COMPLETE]` 한 줄, 또는 빈 문자열만 남긴 경우 —
`result.output` 은 (sanitize 가 들어오는 곳에 따라)
사실상 빈 문자열이 된다.

### 3.2 `_notify_linked_vtuber` 는 빈 출력을 그대로 통보한다

문제 시나리오의 직접 원인. agent_executor.py:209-216 발췌:

```python
if result.success and result.output:
    summary = result.output[:2000]
    content = f"[SUB_WORKER_RESULT] Task completed successfully.\n\n{summary}"
elif result.error:
    content = f"[SUB_WORKER_RESULT] Task failed: {result.error[:500]}"
else:
    content = "[SUB_WORKER_RESULT] Task finished with no output."
```

* "성공했지만 LLM 텍스트가 빈 경우" 와 "취소되었지만 에러도 없는 경우" 가
  **같은 분기 (`else`)** 로 떨어진다.
* tool 호출 횟수, 도구 이름, 결과 요약, 작성한 파일 경로,
  스테이지 단계 정보가 **전혀 들어가지 않는다.**
* `result` 객체에는 `duration_ms` / `cost_usd` 만 있고 도구 이력이 없다.
  도구 이력은 session_logger 에만 남고 ExecutionResult 까지 올라오지
  않는다. ([ExecutionResult 정의](../../../backend/service/execution/agent_executor.py#L55))

VTuber 는 이 메시지를 받아 [vtuber.md](../../../backend/prompts/vtuber.md)
의 `## Triggers` 섹션에 따라 "구조화된 페이로드 (status/summary/...)"
를 기대하지만 들어온 본문은 평문 한 줄이라 적절히 파싱할 수 없다.
LLM 은 가장 안전한 해석으로 "출력이 없으니 다시 시도" 를 택한다.

### 3.3 *두 개의 `[SUB_WORKER_RESULT]` 가 동시에 발사된다 (Dual-Dispatch)*

worker.md 는 sub-worker 에게 명시적으로 다음 형식의 DM 을
`send_direct_message_internal` 로 한 번 보내라고 시킨다:

```
[SUB_WORKER_RESULT]
status: ok | partial | failed
summary: …
details: |
  …
artifacts:
  - …
```

이 호출은 `_trigger_dm_response` 를 통해 VTuber 의 `execute_command` 를
*즉시* 깨운다 ([geny_tools.py:142-233](../../../backend/tools/built_in/geny_tools.py#L142-L233)).
이 경로를 **Path A** 라고 하자.

같은 sub-worker 의 invoke 가 끝나면 `execute_command` 의 finally 직전에
`_notify_linked_vtuber` 가 자동 발화된다. 이 경로를 **Path B** 라고 하자
([agent_executor.py:868-869](../../../backend/service/execution/agent_executor.py#L868-L869)).

```
worker.invoke 종료
   ├── Path A: send_direct_message_internal 가 만든 inbox 메시지
   │           + _trigger_dm_response 가 깨운 VTuber.execute_command
   │   ───────────────────────────────────────────────
   │   payload: 구조화된 [SUB_WORKER_RESULT] yaml-ish
   │   trigger prompt: "[SYSTEM] You received a direct message …"
   │
   └── Path B: _notify_linked_vtuber 가 만든 새로운 메시지
              + 또 다른 VTuber.execute_command 또는 inbox.deliver
       ───────────────────────────────────────────────
       payload: "Task finished with no output." (또는 result.output 일부)
       trigger prompt: 그 평문 그대로
```

두 경로의 작용이 다르다는 점이 더 큰 문제다.

| 경로 | VTuber 응답이 사용자 채팅 룸에 노출되는가? | 페이로드 풍부도 |
|---|---|---|
| Path A (`send_direct_message_internal`) | **아니오.** `_trigger_dm_response._deliver_and_respond` 에는 `_save_*_to_chat_room` 호출이 없다. 그냥 로그만 남는다 ([geny_tools.py:189-200](../../../backend/tools/built_in/geny_tools.py#L189-L200)). | ✅ 구조화된 status/summary/details |
| Path B (`_notify_linked_vtuber`) | **예.** 끝나면 `_save_subworker_reply_to_chat_room` 으로 강제 노출 ([agent_executor.py:331](../../../backend/service/execution/agent_executor.py#L331), [agent_executor.py:1021-1092](../../../backend/service/execution/agent_executor.py#L1021-L1092)). | ❌ 평문 한 줄 또는 빈 메시지 |

즉:
* worker 가 worker.md 의 지시를 *충실히* 이행해 좋은 페이로드를
  Path A 로 보냈더라도 — VTuber 는 그 답변을 만들고도 사용자에게는
  보이지 않는다.
* 사용자 화면에 노출되는 것은 항상 Path B 의 **빈약한 메시지** 다.
* 사용자는 "워커가 뭔가 했는데 보고가 없네" 라는 톤만 듣게 된다.

### 3.4 inbox-기반 fallback 도 같은 빈 페이로드를 흘린다

VTuber 가 이미 다른 invoke 중이면 Path B 는 inbox 로 우회한다
([agent_executor.py:251-275](../../../backend/service/execution/agent_executor.py#L251-L275)):

```python
inbox.deliver(
    target_session_id=linked_id,
    content=content,                     # ← "Task finished with no output."
    sender_session_id=session_id,
    sender_name="Sub-Worker",
)
```

이후 VTuber 의 `_execute_core` finally 가
`_drain_inbox(vtuber)` 를 트리거하면 inbox 메시지가
`[INBOX from Sub-Worker]\n[SUB_WORKER_RESULT] Task finished with no output.`
prompt 로 다시 invoke 된다. VTuber 입장에서는 *동일한 무내용*
메시지가 다시 한 번 더 들어오는 셈이다.

### 3.5 ThinkingTrigger 의 `sub_worker_working` 와 충돌

VTuber 가 idle 상태에서 sub-worker 가 실행 중이면 thinking_trigger 는
`[THINKING_TRIGGER:sub_worker_working]` 을 발화한다
([thinking_trigger.py:889-897](../../../backend/service/vtuber/thinking_trigger.py#L889-L897)).
이때 VTuber 는 사용자에게 "워커가 작업하고 있어요" 식의 발화를 한다.

worker 가 끝나는 그 직후에 `_notify_linked_vtuber` 가
"Task finished with no output." 을 보내면, VTuber 는 직전 발화와
의미상 모순되는 신호를 받는다. 사용자 입장에서는 *흐름이 어색하다는
감각* 으로 누적된다 (예: 워커가 작업 중이라더니 결과가 없네 → 다시?).

### 3.6 `sanitize_for_display` 가 사용자 화면에서는 `[SUB_WORKER_RESULT]` 라벨조차 제거

스크린샷에서 사용자가 직접 그 라벨을 본 것은 채팅 룸이 아니라
**timeline / 이벤트 로그 패널** 일 가능성이 크다. `sanitize_for_display`
는 채팅 메시지 저장 전 (`_save_subworker_reply_to_chat_room`,
`_save_to_chat_room`, `_save_drain_to_chat_room`) 에만 적용된다.
VTuber 의 LLM 이 페이로드를 *그대로 출력해 버리는* 경우엔 소거되지만,
VTuber 가 빈 응답을 받아 "출력이 없네요" 라고 *말로* 답한 경우엔 그
문장 자체가 그대로 사용자에게 흘러간다 — 이번 사례가 이쪽에 가깝다.

### 3.7 worker.md 의 이중지시 문제

worker.md 는 ([worker.md:22-26](../../../backend/prompts/worker.md#L22-L26))
"성공시 `[TASK_COMPLETE]` 으로 끝내라" 와
"끝나면 `[SUB_WORKER_RESULT]` 페이로드 DM 한 번을 보내라"
([worker.md:57-72](../../../backend/prompts/worker.md#L57-L72)) 를 동시에
요구한다.

* `[TASK_COMPLETE]` 은 LLM 의 평문 마지막 줄 → `result.output` 에 들어감.
* `[SUB_WORKER_RESULT]` 페이로드는 send_direct_message_internal 의 인자 →
  `result.output` 에는 들어가지 않음.

따라서 worker 가 두 가지 다 하면 `result.output` 은 `[TASK_COMPLETE]`
한 줄이 되어 Path B 가 *비어 있지는 않은* "Task completed successfully."
+ `[TASK_COMPLETE]` 이라는 똑같이 무익한 메시지를 만든다. 이쪽도
사용자에게는 의미가 없다.

## 4. 근본 원인 정리

| # | 원인 | 위치 |
|---|---|---|
| **R1** | sub-worker 의 invoke 결과에 *도구 호출 내역* 이 보존되지 않는다. `ExecutionResult` 는 `success/output/error/duration_ms/cost_usd` 만 가진다. | `ExecutionResult` 정의 [agent_executor.py:55](../../../backend/service/execution/agent_executor.py#L55) |
| **R2** | `_notify_linked_vtuber` 가 단순 텍스트 누적값에만 의존해서 `[SUB_WORKER_RESULT]` 를 합성한다. 도구 이력 / 파일 / status 의 구조 인식이 없다. | [agent_executor.py:209-216](../../../backend/service/execution/agent_executor.py#L209-L216) |
| **R3** | `_notify_linked_vtuber` 가 *worker 가 이미 send_direct_message_internal 로 결과를 보냈는지 여부* 를 모른다 → 이중 발사. | [agent_executor.py:183-341](../../../backend/service/execution/agent_executor.py#L183-L341) |
| **R4** | `_trigger_dm_response` 가 만들어 낸 VTuber 응답은 `_save_*_to_chat_room` 으로 노출되지 않는다 → Path A 가 사용자에게 "투명". | [geny_tools.py:142-233](../../../backend/tools/built_in/geny_tools.py#L142-L233) |
| **R5** | "출력이 빈 성공" 과 "에러" 가 동일한 fallback 문장으로 합쳐진다 → VTuber 가 의미를 분리 못 함. | [agent_executor.py:215-216](../../../backend/service/execution/agent_executor.py#L215-L216) |
| **R6** | worker.md 가 *평문 시그널* (`[TASK_COMPLETE]`) 과 *DM 페이로드* (`[SUB_WORKER_RESULT] yaml`) 를 동시에 요구한다. 두 채널이 의미적으로 충돌. | [worker.md:22-26 vs 57-72](../../../backend/prompts/worker.md) |
| **R7** | inbox fallback 시 동일한 무내용 메시지가 한 번 더 invoke 된다. | [agent_executor.py:251-275](../../../backend/service/execution/agent_executor.py#L251-L275) |
| **R8** | thinking_trigger 의 `sub_worker_working` 발화와 직후 받는 빈 SUB_WORKER_RESULT 가 사용자에게는 모순처럼 들린다. | [thinking_trigger.py:889-897](../../../backend/service/vtuber/thinking_trigger.py#L889-L897) |

## 5. 개선 방향

> 우선순위: P0 = 사용자 체감 회귀 직접 차단 / P1 = 구조 정리 / P2 = 장기 정합성

### P0-1. `_notify_linked_vtuber` 의 dual-dispatch 제거

가장 즉각적인 수정. **worker 가 이미 `send_direct_message_internal`
로 `[SUB_WORKER_RESULT]` 페이로드를 보냈다면 Path B 를 발화하지 않는다.**

구현 안 (둘 중 하나):

1. **Sender 측 표지자**: `SendDirectMessageInternalTool.run` 이 본문이
   `[SUB_WORKER_RESULT]` 로 시작하면 worker 의 `AgentSession` 에
   `_explicit_subworker_report_sent = True` 를 표시한다. invoke 가
   끝나고 `_notify_linked_vtuber` 가 이 플래그를 보고 *해당 turn 동안
   이미 보고가 갔다면 자동 발사를 생략* 한다.
2. **Receiver 측 dedupe**: VTuber 의 inbox 가 동일 turn 동안 같은 sender
   의 `[SUB_WORKER_RESULT]` 를 두 개 이상 받으면 더 *얕은* 평문 한 줄
   메시지를 무시한다.

(1) 이 단순하고 의미가 명확하다. (2) 는 보조 안전망.

### P0-2. 빈 출력일 때 도구 이력으로 의미를 채워라

`ExecutionResult` 에 `tool_calls: list[ToolCallSummary]` 를 추가하고
`_notify_linked_vtuber` 가 `output` 비었을 때 그것을 활용해 다음과 같은
*구조화된* 메시지를 합성한다.

```
[SUB_WORKER_RESULT]
status: ok
summary: 파일 1개를 작성했어요. (도구 호출 1건, 실패 0건)
details: |
  Wrote: self_introduction.md
artifacts:
  - self_introduction.md
```

핵심은 worker 가 LLM 텍스트를 안 남겼더라도, **런타임이 도구 이력으로부터
worker.md 에서 정의한 그 페이로드 형식을 정확히 흉내** 낸다는 것.
이렇게 되면 VTuber.md 의 `## Triggers` 가 받기로 한 입력 계약이
어느 경로에서 오든 일관된다.

세부:
* `tool.call_complete` 이벤트의 `name` / 핵심 인자 / `is_error` 를 모아
  `_invoke_pipeline` 에서 `ExecutionResult` 에 attach.
* `Write` 의 인자 `path` 등 의미가 큰 도구는 화이트리스트로 artifact
  추출. 나머지는 도구 이름만.
* 모든 도구 호출이 실패했다면 `status: failed`. 일부 실패면 `partial`.

### P0-3. `else` 분기에서 "출력 없음" 문장을 쓰지 말 것

위 P0-2 가 들어가면 `else` 는 *진짜로* "도구도 안 부르고 텍스트도 없는"
이상 상태가 된다. 이때는 *VTuber 에게 메시지를 보내지 말고* 로그만
남기고 종료. 사용자에게 의미 없는 발화를 강제하지 않는다.

### P1-1. Path A 도 사용자 화면으로 노출되도록 통일

`_trigger_dm_response._deliver_and_respond` 에 `_save_*_to_chat_room`
호출을 추가한다. 그렇지 않으면 worker 가 보낸 *좋은* 페이로드를 풀어낸
VTuber 발화가 사라지는 손실이 영구적으로 남는다.

대안: Path A 자체를 폐지하고 sub-worker 의 모든 결과를
`_notify_linked_vtuber` 한 곳으로 강제. 이쪽은 worker.md 변경이 필요
(아래 P1-3).

권장은 *Path A 를 단일 진실 채널로 만들고 Path B 를 백업/보강 전용으로
바꾸는 것*. 이유: worker 가 직접 만든 구조 페이로드가 런타임 추론보다
정확하다. Path B 는 worker 가 페이로드를 빠뜨렸을 때만 보강하면 된다.

### P1-2. inbox 우회시 dedupe + 라우팅 메타

inbox.deliver 시 `metadata={"tag": "[SUB_WORKER_RESULT]", "task_id": …}`
를 같이 적재해 `_drain_inbox` 가 같은 task 의 두 번째 무내용 메시지를
스킵하게 한다. 현재 inbox 는 평문 content 만 들고 있어 dedupe 키가 없다
([agent_executor.py:255-274](../../../backend/service/execution/agent_executor.py#L255-L274)).

### P1-3. worker.md / vtuber.md 계약 단순화

* worker.md 에서 `[TASK_COMPLETE]` 평문 시그널을 **삭제** 또는 *내부
  loop 신호 전용* 으로 격하. 사용자/VTuber 에게 가는 채널은
  `send_direct_message_internal` 1개로 통일.
* vtuber.md 의 `## Triggers` 의 `[SUB_WORKER_RESULT]` 명세에
  "내용이 평문이거나 빈 경우엔 사용자에게 *기다리라고 말하지 말고*
  내부 reflection 으로만 처리" 규칙 추가. 모순된 발화 누수 방지.

### P1-4. ThinkingTrigger sub_worker_working 의 cool-down

worker invoke 가 끝나기 *직전 N초* 에 `sub_worker_working` 트리거를
발화하지 않도록 `is_executing(linked_id)` 외에 "마지막 trigger 발사
시각" 도 같이 본다. 마지막 발화 후 X 초 안에 worker 가 끝났다면
*완료 보고만* 보이도록 — 사용자 입장에서 의미 없는 "기다려" → "결과 무"
연쇄가 줄어든다.

### P2-1. ExecutionResult 의 1급 시민화

* `tool_calls`, `files_written`, `files_read`, `subagents_invoked`
  같은 필드를 추가하면 자동 보고 합성뿐 아니라 timeline/admin 패널,
  VTuber 의 thinking_trigger 사후 회상, LTM 저장에 모두 도움이 된다.
* `_invoke_pipeline` 에서 이미 모든 정보가 stream 으로 흐르고 있어
  *추출 비용은 작다* — 단지 누적 변수만 두면 된다.

### P2-2. delegation.py 의 격상

현재는 태그 식별 헬퍼만 들어 있다. 위 R1~R5 를 흡수해 *완전한 메시지
DTO* + *송신/수신 라우팅 책임* 을 옮기면 agent_executor.py 와
geny_tools.py 에 흩어진 페이로드 합성 로직이 한 군데로 모인다. 단위
테스트도 가능해진다.

### P2-3. 통합 회귀 테스트

| 케이스 | 기대 |
|---|---|
| worker 가 도구 호출 + 텍스트 없음 + send_direct_message_internal 으로 yaml 보고 | VTuber 화면에 yaml 의 summary 가 풀려서 단 한 번만 노출. dual notify 없음. |
| worker 가 도구 호출만 (yaml 보고 누락) | 런타임 합성 yaml 이 한 번 노출. status 가 도구 결과로부터 자동 도출. |
| worker 가 텍스트만 + 도구 0 (간단 답변) | "출력이 없네요" 같은 문구 없이 텍스트가 그대로 paraphrase. |
| worker 실패 (CancelledError) | "Task finished with no output" 가 아닌 *명확한 실패 사유* (preempted/timeout) 가 status: failed 로 매핑. |
| VTuber busy → inbox fallback | 같은 turn 의 두 번째 알림은 inbox 에서 dedupe 됨. |

## 6. 다음 단계 제안 (이 cycle 의 plan 단계로 옮길 항목)

1. **P0-1 (dual-dispatch suppression)** — 가장 작은 PR. AgentSession 에
   per-invoke flag, `_notify_linked_vtuber` 의 early-return.
2. **P0-2 (tool-call summary in result)** — `ExecutionResult` 확장 +
   합성 로직. P0-1 보다 약간 큰 PR.
3. **P0-3** 는 P0-2 가 들어간 다음 자연스러운 정리.
4. **P1-1 / P1-2** 는 위 둘 안정화 후.
5. **P1-3 / P1-4 / P2-***  는 다음 cycle 로 분리.

각 단계는 독립적으로 PR 가능하며, 이전 단계가 머지되어 있어도
사용자 체감은 단조 개선된다 (회귀 영향 없음).

## 7. 참고로 본 회로

* PR #549 부근에서 `_save_subworker_reply_to_chat_room` 가 "cycle
  20260420_8 Bug 2a" 로 추가된 흔적이 있다. Path B 만 사용자 화면에
  닿게 하기 위한 패치였는데, 본 분석에서 짚은 것처럼 그 결정이 Path A
  를 사실상 무시 가능 채널로 만들었다. 이번 개선은 그 균형을 다시
  맞추는 작업이라고 볼 수 있다.
* `test_notify_linked_vtuber.py`, `test_drain_after_trigger.py`,
  `test_agent_session_memory.py` 가 기존 회귀를 잡고 있어 위 P0 변경
  시 *깨질 가능성이 큰 테스트* 들이다 — PR 시 동시에 업데이트해야 한다.
