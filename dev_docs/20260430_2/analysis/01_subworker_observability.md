# VTuber 의 Sub-Worker 관찰 가능성 — 심층 분석

> **Cycle**: 20260430_2 · **Date**: 2026-04-30 · **Status**: 분석 only
>
> 직전 cycle 20260430_1 에서 dual-dispatch 결함을 정리해
> *"Task finished with no output."* 송출 경로를 봉쇄했다. 이 문서는 그
> 다음 단계의 질문을 다룬다 —
>
>   **VTuber 가 paired Sub-Worker 의 *실제 작업 진행* 을 얼마나 깊이까지
>   살펴볼 수 있는가? 현재 구조의 한계는 무엇이고, 어떻게 고도화해야
>   하는가?**
>
> 결론을 먼저 적자면 *현재 채널은 매우 얇다*. VTuber 가 worker 의
> 진행 상황을 알 수 있는 정보는 본질적으로 **DM 본문 한 줄** 뿐이고,
> tool call / 파일 변경 / 시간 / 비용 / 중간 결과 같은 운영 데이터는
> 거의 노출되지 않는다. 본 문서는 그 진단을 코드 단위로 짚고, 7개의
> 구체적 고도화 후보를 P0~P3 우선순위로 제안한다.

## 0. 검토 범위

* VTuber 가 호출 가능한 *도구* 의 인벤토리 — 어떤 게 worker 정보를 노출하는지
* VTuber 의 *메모리* (STM / LTM / vector / curated knowledge) 가 worker 를 어떻게 (혹은 안) 기록하는지
* VTuber turn 시작 시 system prompt 에 자동 주입되는 컨텍스트
* `session_logger` 가 cross-session 으로 보이는지
* shared folder / knowledge / opsidian 같은 side channel
* Cycle 20260430_1 P0-2 가 도입한 `ExecutionResult.tool_calls` 가 어디까지 활용되고 있는지

## 1. VTuber 의 도구 인벤토리

### 1.1 Built-in (executor framework) tools

`_VTUBER_BUILT_IN_TOOL_NAMES = []`
([service/environment/templates.py:104-105](../../../backend/service/environment/templates.py#L104-L105)).

VTuber 환경 매니페스트는 framework built-in 을 **하나도** 노출하지 않는다.
즉 `Write`, `Read`, `Edit`, `Bash`, `Glob`, `Grep`, `NotebookEdit`,
`MultiEdit`, `WebFetch`, `WebSearch`, `Task`, `TodoWrite` 등은 전혀
없다. Worker 와의 가장 큰 차이.

### 1.2 Platform tools (geny / memory / knowledge / opsidian)

VTuber 에게 *허용* 되는 platform 도구는 `_PLATFORM_TOOL_SOURCES`
중에서 `_VTUBER_PLATFORM_DENY` 를 뺀 것
([templates.py:127-132](../../../backend/service/environment/templates.py#L127-L132)).

```
DENY = {
    "session_create",       # 새 세션 생성 시도 차단
    "session_list",         # 다른 세션 디스커버리 차단
    "session_info",         # 다른 세션 디스커버리 차단
    "send_direct_message_external",  # 임의 세션 DM 차단
}
```

ALLOW 에 들어가는 것 (상위 3개 구간만 발췌):

| 도구군 | VTuber 사용 가능 | Sub-Worker 정보 노출? |
|---|---|---|
| `send_direct_message_internal` | ✅ paired sub-worker 에게 task 보내기 | 송신만; 결과는 DM 본문으로 받아옴 |
| `read_inbox` | ✅ 자기 inbox 읽기 | sub-worker 가 보낸 DM 본문 그대로 |
| `memory_*` (write/read/update/delete/search/list/link) | ✅ 자기 STM/LTM | 자기 데이터만 |
| `knowledge_*` (search/read/list/promote) | ✅ owner curated KB | 페어/세션 관계없이 owner 의 KB |
| `opsidian_*` (browse/read) | ✅ owner Opsidian 노트 | owner 데이터; sub-worker 가 거기 적었다면 가능 |
| 게임 도구 (`feed`, `gift`, `play`, `talk`) | ✅ | sub-worker 무관 |

### 1.3 Custom tools

`_VTUBER_CUSTOM_TOOL_WHITELIST = ["web_search", "news_search", "web_fetch"]`
([templates.py 부근](../../../backend/service/environment/templates.py)).

웹 검색 / 페이지 fetch 만 허용. browser 자동화는 차단.

### 1.4 비활성화된 도구군

`backend/tools/built_in/geny_tools.py:1144-1156` 의 export 리스트:

```python
TOOLS = [
    SessionListTool(),
    SessionInfoTool(),
    SessionCreateTool(),
    SendDirectMessageExternalTool(),
    SendDirectMessageInternalTool(),
    ReadInboxTool(),
    # RoomListTool(),
    # RoomCreateTool(),
    # RoomInfoTool(),
    # RoomAddMembersTool(),
    # SendRoomMessageTool(),
    # ReadRoomMessagesTool(),
]
```

`room_*` 도구군 자체가 export 에서 빠져 있다 — VTuber 든 worker 든
누구도 못 본다. 따라서 *"공개 채널" 을 통해 worker 의 작업 흐름을
관전* 하는 패턴은 현재 불가능. (cycle 20260420_8 analysis 의 결정.)

### 1.5 결론 — 도구 측면

**VTuber 가 paired sub-worker 의 작업을 *직접* 들여다 보게 해 주는
도구는 0개.** 모든 정보는 sub-worker 가 자발적으로 DM 본문에
적은 만큼만 들어온다.

## 2. DM 본문 — 유일한 *내용* 채널

### 2.1 들어오는 prompt 구조

`_trigger_dm_response._deliver_and_respond`
([tools/built_in/geny_tools.py:163-219](../../../backend/tools/built_in/geny_tools.py#L163-L219))
가 VTuber 의 `execute_command` 를 깨울 때 만드는 prompt:

```
[SYSTEM] You received a direct message from {sender_name}
(session: {sender_session_id}). Read the message below and take
appropriate action — respond to questions, perform requested tasks,
etc. Only reply via 'send_direct_message_internal' (to your
counterpart) or 'send_direct_message_external' (to another session)
if a response is explicitly needed or expected. Do NOT reply just
to acknowledge receipt — focus on completing the task if one was
requested.

[DM from {sender_name}]: {content}
```

여기서 `{content}` = sub-worker 가 보낸 페이로드. cycle 20260430_1
이후의 두 가지 형태:

**(a) Worker 가 worker.md 를 따른 경우**:
```
[SUB_WORKER_RESULT]
status: ok | partial | failed
summary: <≤120 chars 사람 말>
details: |
  <옵셔널 다중 줄, 사용자 follow-up 대비>
artifacts:
  - <옵셔널 path/URL/ID>
```

**(b) Worker 가 SUB_WORKER_RESULT 명시 DM 을 빼먹은 경우 (cycle 20260430_1 P0-2 의 자동 합성)**:
```
[SUB_WORKER_RESULT]
status: ok | partial | failed
summary: Completed using Write, Bash (3 tool calls).
details: |
  Tools used: Write, Bash
  Total calls: 3 (3 ok, 0 failed)
artifacts:
  - notes.md
  - report.md
```

### 2.2 본문 외 정보가 들어오는가?

**아니다.** prompt 는 위 두 줄짜리 시스템 헤더 + 본문이 전부.

```python
# tools/built_in/geny_tools.py:165-173
prompt = (
    f"[SYSTEM] You received a direct message from {sender_name} "
    f"(session: {sender_session_id}). "
    f"Read the message below and take appropriate action — ... "
    f"[DM from {sender_name}]: {content}"
)
```

worker 의 timeline / cost / duration / session_id (header 에만) /
도구 호출 list / 파일 변경 / Bash 출력 — 모두 *prompt 에 들어가지
않는다*.

### 2.3 본문이 다음 turn 에도 보이는가?

**부분적으로.** 다음 두 경로로 보존된다:

1. **VTuber STM 의 `assistant_dm`**:
   `_classify_input_role` ([executor/agent_session.py:56-104](../../../backend/service/executor/agent_session.py#L56-L104))
   가 `[SYSTEM] You received a direct message` prefix 를
   `assistant_dm` 으로 분류. 따라서 prompt 전체가 그 role 로 STM 에
   기록된다.
2. **GenyMemoryRetriever 의 `recent_turns`** (default 6, vtuber 는
   `_tuning["recent_turns"] = 6`,
   [agent_session.py:1366](../../../backend/service/executor/agent_session.py#L1366)):
   다음 turn 의 system prompt 빌드 시 *항상* 직전 6 메시지를
   `<recent-turns>` 블록으로 주입.

따라서 VTuber 가 직전 SUB_WORKER_RESULT 를 *3턴 후* 에도 자기
컨텍스트로 볼 수 있는 확률은 높다 (6턴 윈도우 안). 하지만 그
이상 멀어지면 vector / keyword search 에 query 가 잘 맞아야 다시
회수.

## 3. 메모리 시스템과 worker 의 관계

### 3.1 VTuber STM 에 들어가는 worker-관련 항목

| 항목 | 어떻게 들어가는가 | 분류 (role) |
|---|---|---|
| VTuber → worker 송신 DM | `_record_dm_on_sender_stm` ([geny_tools.py:97-139](../../../backend/tools/built_in/geny_tools.py#L97-L139)) — `[DM to {target} (internal)]: {body}` 한 줄 | `assistant_dm` |
| Worker → VTuber 수신 DM | `_trigger_dm_response` 가 만든 `[SYSTEM] You received...` prompt 가 `_classify_input_role` 통과 시 → STM 입력 | `assistant_dm` |
| Worker 의 *도구 호출 자체* | ❌ 들어가지 않음 | — |
| Worker 의 *파일 변경* | ❌ artifacts 라인이 본문에 있을 때만 (텍스트로) | — |
| Worker 의 *비용 / 소요시간* | ❌ | — |

### 3.2 VTuber LTM 에 들어가는 worker-관련 항목

`record_execution`
([memory/manager.py:500-602](../../../backend/service/memory/manager.py#L500-L602))
은 *VTuber 자기 세션의* execution 을 마크다운으로 기록. 다른 세션의
실행 정보는 결코 들어가지 않는다. `_build_execution_entry`
([manager.py:608-720](../../../backend/service/memory/manager.py#L608-L720))
의 출력 형식:

```
### [✅] Execution #N — easy path
> **Task:** <user input preview>
> **Duration:** 5.2s | **Iterations:** 1/30

**Result:** <output preview>
```

여기서 `result_state` 는 `accumulated_output` 기반 → VTuber 가 무슨
말을 했는지만 들어감. worker 의 도구 호출 내역은 안 들어감.

### 3.3 Cross-session memory peek 가능 여부

**아니다.** 모든 `memory_*` / `knowledge_*` 도구는 caller 의
`session_id` 로 자기 storage 만 lookup
([tools/built_in/memory_tools.py:39-44](../../../backend/tools/built_in/memory_tools.py#L39-L44),
[knowledge_tools.py:43-71](../../../backend/tools/built_in/knowledge_tools.py#L43-L71)).

* `memory_search("worker가 어제 만든 파일")` — VTuber 자기 STM/LTM 만 검색.
* `knowledge_search(...)` — owner-curated KB. owner 가 같으면 worker 가 작성한 항목을 *이론적으로* 볼 수 있지만, 그건 worker 가 명시적으로 `knowledge_promote` 해서 owner KB 에 적었을 때만.
* `opsidian_browse / opsidian_read` — owner Opsidian. 위와 같은 조건. Opsidian 은 사용자가 수동 운영하는 자료 저장소이므로 worker 자동 출력의 정상 채널 아님.

### 3.4 Vector / FAISS 도 같은 한계

`GenyMemoryRetriever`
([geny-executor/src/geny_executor/memory/retriever.py:38-143](../../../../geny-executor/src/geny_executor/memory/retriever.py))
는 `memory_manager` 를 duck-type 으로 받는다 — 실제 instance 는
*VTuber 자기 SessionMemoryManager*. paired session 의 vector index
는 검색 대상이 아니다.

## 4. Prompt 에 자동 주입되는 컨텍스트

`build_agent_prompt`
([prompt/sections.py:676-814](../../../backend/service/prompt/sections.py#L676-L814))
가 system prompt 를 조립할 때 들어가는 블록들:

1. **Identity** — agent_name / role / session_name / character_display_name
2. **User context** — 사용자 정보 (있으면)
3. **Geny platform awareness** — 플랫폼 안내
4. **Role protocol** — `prompts/{role}.md` (vtuber.md)
5. **Workspace** — `working_dir`
6. **DateTime** — 현재 시각
7. **Bootstrap context** — `AGENTS.md`, `CLAUDE.md`, `SOUL.md` 같은 파일
8. **Extra system prompt** — manifest 에 박힌 추가 prompt (예: VTuber 환경의 `_VTUBER_SUB_WORKER_NOTICE`)
9. **Shared folder** — 활성화 시 안내문

여기에 더해 `Pipeline.attach_runtime` 으로 들어가는 동적 블록들
([executor/agent_session.py:1519-1641](../../../backend/service/executor/agent_session.py#L1519-L1641)):

* **PersonaBlock** — system_prompt
* **DateTimeBlock**
* **MemoryContextBlock** — GenyMemoryRetriever 가 만든 chunks (recent_turns / session summary / MEMORY.md / FAISS / keyword / curated)

**결론**: 이 모든 블록 중 *worker 의 활동* 을 직접 표현하는 자리는
없다. recent_turns 안에 SUB_WORKER_RESULT DM 본문이 우연히 끼어
있을 수는 있지만, 명시적 서브 워커 활동 블록은 부재.

## 5. SessionLogger — 운영 데이터의 보고

### 5.1 무엇이 기록되는가

`SessionLogger`
([service/logging/session_logger.py:124](../../../backend/service/logging/session_logger.py#L124))
는 세션마다 file + in-memory cache 로 다음을 기록한다:

* `log_command` — 들어온 prompt
* `log_response` — 나간 출력
* `log_tool_use` — 도구 이름 + 입력 + tool_use_id
* `log_stage_*` — pipeline stage enter/exit/bypass/error
* `log_delegation_event` — `delegation.sent` / `delegation.received` / `delegation.suppressed_*`
* `LogLevel.STREAM_EVENT` — text.delta 토큰 스트리밍

이건 *사용자가 timeline UI 에서 보는 데이터의 원천* 이다 (controller
가 `get_cache_entries_since()` 로 polling).

### 5.2 LLM 도구로 노출되어 있는가

**아니다.** `get_session_logger(session_id)` 함수는 모듈 레벨이라
백엔드 코드 어디서든 임의 세션의 logger 를 잡을 수 있지만, 그 위에
*BaseTool 을 상속받은 LLM-facing 도구* 는 0개. timeline 은 사용자
관전용 admin UI 일 뿐 LLM 이 자기 추론에 쓸 수 없다.

### 5.3 Cycle 20260430_1 P0-2 가 만든 기회

`ExecutionResult.tool_calls`
([service/execution/agent_executor.py:55-95](../../../backend/service/execution/agent_executor.py#L55-L95))
가 새로 도입되어 *worker invoke 한 번* 의 도구 호출 list 가 1급
시민이 됐다. 현재 이 데이터는

* `_compose_subworker_payload_from_tools` 가 yaml 합성에 사용 (P0-2)

— 단 한 곳에서만 쓰인다. **이 데이터를 (a) 도구로 노출, (b) prompt
컨텍스트로 자동 주입, (c) STM 로그로 영구 보관 — 이 세 채널 중
*어떤 것도* 아직 활용되지 않았다.** 가장 큰 leverage point.

## 6. Side channel — 공유 폴더 / Opsidian / Knowledge

### 6.1 Shared folder

`SharedFolderManager`
([service/shared_folder/shared_folder_manager.py:46](../../../backend/service/shared_folder/shared_folder_manager.py#L46))
가 활성화되면 모든 세션의 `working_dir` 안에 `_shared/` symlink 가 생성된다.
worker 가 `Write(_shared/report.md)` 로 파일을 만들어 두면, 이론적으로
다른 세션도 자기 working_dir 의 `_shared/` 로 동일 파일을 본다.

**문제 1**: VTuber 는 `Write` / `Read` 같은 file 도구가 *없다*
(§1.1). 따라서 shared folder 에 무엇이 있어도 *못 읽는다*.

**문제 2**: VTuber 의 prompt 에는 shared folder 위치만 안내됨
([sections.py:805-812](../../../backend/service/prompt/sections.py#L805-L812)).
구체적으로 거기에 *지금 무엇이 있는지* 자동으로 보이지는 않는다.

따라서 VTuber 입장에서 shared folder 는 *없는 것과 같다*.

### 6.2 Opsidian

`opsidian_*` 는 *owner 의 Obsidian-style 노트 vault*. owner 가 같은
worker 와 VTuber 가 모두 접근 가능. worker 가 `opsidian_*` 로 노트를
만들어 두면 VTuber 가 `opsidian_browse` 로 발견 가능.

**그러나**: 현재 worker 가 자기 출력물을 Opsidian 에 자동 저장하지
않는다. 사용자가 의도해 prompt 로 시켜야 함. 자동 surface 채널 X.

### 6.3 Curated knowledge

`knowledge_*` 도 owner-scoped. worker 가 `knowledge_promote` 로 자기
LTM 의 항목을 owner KB 로 올리면 VTuber 가 `knowledge_search` 로
검색 가능. 단 worker 가 *명시적으로 promote* 해야 하므로 자동 채널
아님.

## 7. 종합 — 현재 가시성 매트릭스

| VTuber 가 알고 싶은 것 | 현재 채널 | 가시성 |
|---|---|---|
| Worker 가 어떤 task 를 받았는가 (직접 보낸 task) | 자기 STM 의 `assistant_dm` | ✅ 본문 보존 |
| Worker 가 어떤 *도구* 를 호출했는가 | DM 본문 details / 합성 yaml | △ Worker 가 적었거나 P0-2 가 합성한 만큼 (이름 정도) |
| Worker 가 *어떤 파일* 을 만들었는가 | DM 본문 artifacts | △ Write/Edit/MultiEdit/NotebookEdit 만 추출 |
| Worker 가 *Bash* 로 무엇을 실행했는가 | — | ❌ |
| Worker 의 *web_search 결과* / fetch 본문 | — | ❌ |
| Worker 의 작업 *소요 시간* | — | ❌ (`ExecutionResult.duration_ms` 는 있지만 prompt 에 안 들어감) |
| Worker 의 *토큰/비용* | — | ❌ |
| Worker 의 *Plan / TODO* 상태 | — | ❌ (worker LTM 의 todos 필드는 worker 만 봄) |
| Worker 가 마주친 *오류* | DM 본문 status: failed + summary | △ |
| Worker 의 *중간 결과 (intermediate output)* | — | ❌ |
| 페어 외 다른 worker 가 한 일 | — | ❌ |
| 작업 *이력* (지난 turns 의 worker 활동) | recent_turns 6턴 안에서만 | △ FIFO 윈도우 |
| 그 너머 *과거* 의 worker 활동 | vector/keyword search of own STM | △ 본문이 STM 에 있을 때만 |

총평: **얇다**. 한 번의 worker turn 에 대해 VTuber 가 가질 수 있는 정보는
"성공/실패 + 한 줄 요약 + 도구 이름들 + 일부 artifact 경로" 가 한계다.
Bash 결과, 웹 검색 본문, 파일 diff, plan 진행, 비용 — 어느 것도 보이지
않는다.

## 8. 고도화 후보

7개를 *우선순위별로* 정리. 각 후보는 (1) **무엇을** 바꾸는지,
(2) **왜** 그게 ROI 가 높은지, (3) **위험/트레이드오프**, (4) **테스트
체크리스트** 를 포함.

### P0-A. Per-turn `<sub-worker-last-run>` 자동 inject

**무엇**: VTuber 의 system prompt 빌드 시점에, paired sub-worker 의
*마지막 ExecutionResult* (cycle 20260430_1 P0-2 가 1급화한
`tool_calls` + `duration_ms` + `cost_usd`) 가 있다면 다음 형태의
블록을 한 자리 더 첨부.

```
<sub-worker-last-run turn_id="..." status="ok|partial|failed"
                     duration="3.4s" cost="$0.012">
Tools: Write, Bash, web_search
Files written: notes.md, summary.md
Bash commands: 1 (exit 0)
URLs fetched: 1
Errors: 0
</sub-worker-last-run>
```

**왜**: VTuber 에게 별도 도구 호출을 가르치지 않아도 매 turn 자동으로
직전 worker 활동의 *카테고리 별 카운트* 를 본다. 사용자가
"방금 워커가 뭐 했어?" 라고 물어도 정확히 답할 수 있다. P0-2 데이터의
*1급 활용* 자리.

**구현 위치**:
* `Pipeline.attach_runtime` 의 `blocks=[..., MemoryContextBlock(), ...]`
  옆에 새 `SubWorkerLastRunBlock(...)`. VTuber 만 활성화.
* 데이터 소스: paired sub-worker 의 마지막 invoke 결과를 어딘가에
  저장해야 함. 현재 `ExecutionResult` 는 휘발성. 후보:
  - `AgentSessionManager._last_subworker_result: Dict[vtuber_id, ExecutionResult]`
  - 또는 sub-worker session 자체에 `self._last_run_summary` 보관

**위험**:
* prompt 길이 증가. 합성된 yaml 보다 raw tool log 가 더 길 수 있음 → 카테고리 별 *카운트* 만 노출, 본문은 자르기.
* "최신 한 번" 만 자동 노출이라 그 이전은 여전히 안 보임 — 후보 P1-A 가 보강.

**테스트**:
* tool only worker run → 다음 vtuber turn prompt 에 `<sub-worker-last-run>` 등장
* sub-worker 가 fail → status="failed" 반영
* sub-worker 무관 시간 (linked_id=None) → 블록 부재

### P0-B. STM 에 worker tool log 영구 기록

**무엇**: `_classify_input_role` 이 `[SYSTEM] You received a direct
message ...` 를 `assistant_dm` 으로 분류해 전체 prompt 가 STM 에
들어가는 현재 흐름을 그대로 유지하되, **추가로** 별도 레코드로
`subworker_run` role (또는 `event`) 을 기록.

```
{
  "role": "subworker_run",
  "content": "tool_calls=[Write(notes.md, ok), Bash(ls, ok)]; duration=2.1s",
  "metadata": { "task_id": "...", "linked_session_id": "sub-1" }
}
```

이렇게 하면 다음 두 가지 효과:
1. recent_turns 윈도우가 *더 풍부한* 직전 컨텍스트를 본다.
2. vector / keyword search 가 worker 활동을 lookup 가능.

**구현 위치**:
* `_trigger_dm_response._deliver_and_respond` 가 VTuber invoke 직전,
  paired worker 의 ExecutionResult 가 있으면 `record_message` 한 번 더.
* 또는 P0-A 와 같은 데이터 소스 (last_subworker_result) 를 공유.

**위험**:
* `_classify_input_role` 이 새 role 을 인식하도록 화이트리스트 보강 필요.
* search 로 너무 많이 떠올라 비용 증가 → 짧게 (≤200 chars).

**테스트**:
* worker 가 file 작성 → 다음 turn 의 search("notes.md") 결과에 등장
* 화이트리스트 미인식 fallback 동작 확인

### P1-A. `worker_recent_activity(turn_id?)` 도구 추가

**무엇**: VTuber 가 *명시적으로* "최근 worker 가 한 일을 자세히 알고
싶어" 할 때 호출하는 도구. paired sub-worker 한정.

```python
class WorkerRecentActivityTool(BaseTool):
    name = "worker_recent_activity"
    description = (
        "Inspect what your paired Sub-Worker did in its most recent "
        "task turns. Returns tool calls (with args preview), files "
        "written/read, durations, and any errors. Read-only — does "
        "not interrupt the Worker."
    )
    def run(self, session_id: str, n: int = 1) -> str:
        # session_id = caller (VTuber)
        # paired sub-worker = caller._linked_session_id
        # 데이터 소스: AgentSessionManager._subworker_run_history (P0-A 와 공유)
        # n = 가져올 turn 수 (default 1, max 5)
        ...
```

**왜**: P0-A 는 *직전 한 번* 만 자동 노출. 사용자가 "어제 워커가
어떤 명령을 실행했었지?" 물으면 VTuber 가 *능동적으로* 더 깊이
들여다 볼 수 있어야 함.

**위험**: VTuber tool surface 가 커진다. 호출 비용. → `paired-only`
strict guard + max 5 turns 제한.

**구현 영향**:
* env_template `_VTUBER_PLATFORM_DENY` 에 *없으면* 자동 노출됨 (platform tool 이므로).
* `geny_tools.py` 의 TOOLS export 에 추가.

**테스트**:
* paired call → 결과
* unpaired (linked_session_id=None) → error
* 너무 큰 n → 5 로 cap

### P1-B. `worker_workspace_diff(since?)` 도구

**무엇**: paired sub-worker 의 working_dir 안에서 *최근 변경된 파일*
목록 + 짧은 diff 를 보여 주는 read-only 도구. shared folder 도 포함.

```python
class WorkerWorkspaceDiffTool(BaseTool):
    name = "worker_workspace_diff"
    description = (
        "List files your paired Sub-Worker recently created/modified "
        "in its workspace. Read-only — never mutates anything."
    )
    def run(self, session_id: str, since_turn: int = -1, max_files: int = 20) -> str:
        ...
```

**왜**: ExecutionResult.tool_calls 의 artifact 추출은 *Write/Edit/...*
4개 도구의 인자 화이트리스트뿐. Bash 가 만든 파일이나 worker 의
checkpoint 폴더 같은 건 안 보인다. 파일시스템을 직접 stat 하면 누락
없이 인지 가능.

**위험**:
* worker 의 working_dir 이 sandbox 일 때 read 권한 필요.
* 큰 폴더 walking 비용 → max_files cap, mtime 정렬, depth 제한.

**테스트**:
* paired write 여러 개 → 정렬된 path 목록
* working_dir 부재 / 권한 X → 명확 에러
* shared folder 활성화/비활성 케이스

### P1-C. Worker 의 *자발적* tool log 보고 강제 (worker.md 보강)

**무엇**: worker.md 의 `[SUB_WORKER_RESULT]` 양식의 `details:` 필드에
*도구 호출 이력을 한 줄씩 적도록* 명시.

```
details: |
  Wrote notes.md (12 lines)
  Ran `git status` — clean
  Searched web for "OAuth2 PKCE" — picked auth0.com/docs
```

**왜**: P0-2 자동 합성보다 *worker 가 직접 적은 narrative* 가 의미가
풍부. P0-2 는 도구 이름만. worker 가 자기 의도까지 담을 수 있다.

**위험**:
* prompt 만 늘리는 변경. LLM 이 양식을 어겨도 P0-2 fallback 이 있어
  안전하지만, paraphrase 품질이 떨어질 수 있음.

**테스트**:
* prompt regression 추가 — `details: |` 가 narrative 형식이라는 점 명시

### P2-A. `SubWorkerRun` DTO + 영구 저장

**무엇**: cycle 20260430_1 P0-2 가 만든 `tool_calls: list[dict]` 를
*카테고리 별* 정규화한 1급 DTO 로 격상.

```python
@dataclass
class SubWorkerRun:
    turn_id: str
    started_at: datetime
    duration_ms: int
    cost_usd: float
    status: Literal["ok", "partial", "failed"]
    summary: str
    files_written: list[str]
    files_read: list[str]
    bash_commands: list[BashCall]
    web_fetches: list[WebCall]
    errors: list[ToolError]
    raw_tool_calls: list[dict]
```

저장 위치:
* paired pair 의 *공유 ndjson* `<storage>/subworker_runs.jsonl`
* 또는 새 SQLite 테이블 (DB 가 이미 있음)

**왜**:
* P0-A / P0-B / P1-A / P1-B 모두 같은 데이터 소스를 쓰게 됨 — 분산된 임시 변수 대신 한 군데로 모임.
* timeline / admin 패널이 같은 DTO 를 시각화 가능.
* 미래 확장 (Replay, A/B comparison, retro analysis) 의 토대.

**위험**:
* migration 비용. 기존 ExecutionResult 호환을 깨지 않으려면 *추가만*.
* 카테고리화 규칙은 도구가 늘어날 때마다 업데이트 필요.

**테스트**:
* `tool.call_complete` → DTO 카테고리 매핑
* DTO → P0-A 블록 / P1-A 도구 / timeline 모두 동일 출처

### P2-B. EventBus 구독 — 진행 중 progress 노트

**무엇**: sub-worker 의 `tool.call_complete` 이벤트마다 *VTuber inbox
에 짧은 progress 메모* (선택적). 단, 발화는 cooldown (P1-4 패턴) 으로
제한.

```
[SUB_WORKER_PROGRESS] tool=Write file=notes.md ok in 0.5s
```

**왜**: 사용자가 "지금 워커가 뭐 하고 있어?" 라고 물었을 때 VTuber 가
실시간 답변 가능. 현재는 sub_worker_working trigger 가 *"작업 중"*
이라는 사실만 알릴 뿐.

**위험**:
* event spam → cooldown + verbose 옵션 (default off).
* persona 가 매 progress 마다 narrate 하면 산만 → "내부 인지만 하고
  필요할 때만 발화" 룰 필요 (vtuber.md 패치).

**테스트**:
* 빠른 도구 호출 N 번 → cooldown 안에서 1번만 narrate
* verbose=off (default) 에서는 SUB_WORKER_PROGRESS inbox 가 silent
  drain (P0-3 의 빈 turn 처리 패턴 재사용)

### P3-A. Curated knowledge 의 자동 promote

**무엇**: worker 가 `[SUB_WORKER_RESULT]` 의 `artifacts:` 에 적은
경로를 자동으로 owner KB 의 별도 카테고리 (`worker-outputs/`) 에
링크/스냅샷.

**왜**: 며칠 후 사용자가 "지난 주에 워커가 만들었던 분석 보고서가
어디 있더라?" 물을 때 VTuber 가 `knowledge_search("분석 보고서")`
한 번으로 찾을 수 있게.

**위험**:
* owner KB 가 noisy 해질 수 있음 → namespace 분리.

### P3-B. Vector index sharing (비추천)

페어 pair 의 vector index 를 한 segment 로 통합하는 안. 이론적으로
가장 강력한 cross-session recall 이지만:

* persona 오염 (worker 의 raw tool 로그가 vtuber 의 conversational
  retrieval 에 잡힘)
* index 비대화
* 권한/스코프 오염

→ 추천하지 않음. P0-A / P0-B / P2-A 가 더 현실적이고 controllability 높음.

## 9. 권장 진행 순서

1. **P2-A 부터** — DTO + 영구 저장. 다른 모든 후보의 토대.
2. **P0-A** (per-turn auto-inject) — 가장 큰 ROI, prompt-only 변경.
3. **P0-B** (STM 영구 기록) — search lookup 가능.
4. **P1-A** (worker_recent_activity 도구) — VTuber 능동 inspection.
5. **P1-B** (worker_workspace_diff) — 파일시스템 truth.
6. **P1-C** (worker.md narrative details) — 무료 prompt 변경, 효과 보강.
7. **P2-B** (EventBus progress) — 운영 중 fine-tuning.

P0-A 가 끝나면 사용자가 "방금 워커가 뭐 했어?" 라고 물었을 때 VTuber
의 답변 품질이 즉각 도약한다. 도구를 1개도 안 추가해도 prompt-only
주입만으로 가시성이 크게 좋아진다는 점이 이 단계의 매력.

## 10. 결론

* **현재 채널 = DM 본문 한 줄.** worker 가 worker.md 를 따른다 해도
  status / summary / details / artifacts 4 필드뿐. cycle 20260430_1
  P0-2 의 자동 합성은 그 부재를 메우는 안전망일 뿐, 능동적 관찰은 아님.
* **운영 데이터 (`tool_calls`, `duration_ms`, `cost_usd`) 는 이미 있다.**
  단지 `_compose_subworker_payload_from_tools` 한 곳에서만 쓰인다 —
  나머지 모든 곳에서 leverage 되어야 한다 (P0-A / P0-B / P1-A / P2-A).
* **VTuber 도구 인벤토리는 의도적으로 빈약.** file / shell / browser
  도구가 없는 건 페르소나 보호 정책. 그러나 "paired sub-worker 의
  *결과* 만 read-only 로 보는" 도구는 안전성을 해치지 않는다.
* **Memory subsystem 은 sandboxed.** cross-session memory peek 는
  설계 의도대로 차단. paired pair 만의 *narrow exception* 을 추가
  채널 (DTO 영구 저장 + paired-only 도구) 로 풀어 주는 게 옳은
  접근이다.

이 분석을 바탕으로 다음 cycle 의 plan 단계에서 위 후보들을 단계별
PR ladder 로 구체화할 예정.
