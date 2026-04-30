# 통합 — "VTuber 의 모든 상호작용은 Memory Event 다"

> **Cycle**: 20260430_2 · **Date**: 2026-04-30
>
> 이 문서는
> [`02_progressive_disclosure_revision.md`](02_progressive_disclosure_revision.md)
> 의 layered tool 안을 *한 단계 더* 끌어올린다. 단순히 sub-worker
> observability 도구를 만드는 게 아니라, **VTuber 의 인지 모델
> 자체를 통합** 한다 — *"내 기억 = 모든 상호작용 (사용자 / Sub-Worker /
> peer / 자기 reflection) 의 단일 stream + 이 위의 distillation"*.
>
> 이 통합이 왜 필요한가:
>
> * Sub-Worker 와의 conversation 은 *별개의 운영 데이터* 가 아니라
>   VTuber 의 *인생 history 의 일부* 다. 내가 어제 그 워커한테
>   파일을 부탁했고, 워커가 만들어 줬고, 그게 좋았다 — 이 모든 게
>   *기억* 으로 한 자리에 있어야 한다.
> * 미래에 추가될 어떤 새 DM 채널 (peer agent / multi-vtuber / room
>   chat / external API caller) 도 *같은 model* 안으로 자연스럽게
>   들어와야 한다. 채널마다 별도 도구 / 별도 store 를 만드는 건
>   조직적으로 망가지는 길이다.
> * Progressive disclosure 의 *깊이* 가 한 단계 더 자연스러워진다 —
>   "내 기억을 회상한다" 라는 동일 인터페이스로 *사용자와의 대화 /
>   sub-worker 와의 대화 / 자기 reflection* 을 모두 다룬다.

## 0. TL;DR

* **모든 상호작용은 InteractionEvent 다.** STM 의 jsonl 한 줄 = 1
  event. metadata 자리에 표준 차원 (`counterpart_id`, `kind`,
  `direction`, `linked_event_id`, `payload`) 을 강제.
* **새 store 는 만들지 않는다.** STM `add_message` 가 이미
  `metadata` dict 를 받고 jsonl + DB 에 저장한다. 우리가 할 일은
  *명명/표준화*.
* **장기 distillation 자리도 이미 있다.** `structured_writer` 의
  `entities/` category 가 *카운터파트별 long-term 관계 memory* 의
  자연스러운 자리.
* **VTuber 도구 표면은 *통합 memory 의 progressive view*.**
  단순히 "워커 살펴보기" 가 아니라 "내 기억 사다리": `memory_status` →
  `memory_with` → `memory_event` → `memory_artifact`.
* **Prompt-side inject 는 영구 금지.** 데이터는 도구 호출 결과로만
  흐른다.

## 1. 통찰 — DM 은 인생의 일부다

이전 cycle 20260430_1 까지의 mental model:

```
            VTuber session
            ┌─────────────┐
            │  STM/LTM   │  (= 내 자료실)
            └─────────────┘
                  ▲
                  │  자기 record
                  │
       ┌──────────┴──────────┐
       │                      │
   사용자 chat            sub-worker DM
   (record 잘 됨)        (record 잘 됨, but 별개 카테고리)
                              │
                              │  + tool calls / artifacts
                              │  (record 안 됨, ExecutionResult 휘발)
```

새로운 mental model:

```
                           VTuber 의 인생 history
                           (단일 InteractionEvent stream)
   t=0  reflection      ──┐
   t=1  user→me         ──┤
   t=2  me→user         ──┤
   t=3  me→sub-worker   ──┤  
   t=4  tool_run_summary──┤   ← 같은 stream 위
   t=5  sub-worker→me   ──┤
   t=6  me→user         ──┤
   t=7  reflection      ──┤
   ...                    ┘
                            │
                    ┌───────┴───────┐
                    │               │
              recent tail        distillation
              (자동 retrieval)   (entities/, daily/, insights/)
                    │
              progressive
              memory tools
              (능동 호출)
```

이 stream 위에서:

* **사용자와 나눈 대화** = `direction=in/out, counterpart_role=user`
* **Sub-Worker 에게 task 보냄** = `kind=task_request, direction=out, counterpart_role=paired_subworker`
* **Sub-Worker 의 tool run 결과 (P0-2 의 SubWorkerRun)** = `kind=tool_run_summary, linked_event_id=<task_request id>, payload={...}`
* **Sub-Worker 가 보낸 SUB_WORKER_RESULT** = `kind=task_result, direction=in, linked_event_id=<task_request id>`
* **자기 thinking_trigger / activity_trigger** = `kind=reflection, direction=internal`

같은 stream. 같은 schema. 같은 retrieval.

이게 *VTuber 의 인지 일관성*. "내가 누구와 어떤 상호작용을 했는지"
를 단일 모델로 다룬다.

## 2. 이미 시스템에 박혀 있는 *자리들*

설계의 가장 큰 발견 — **이 통합에 필요한 자리는 거의 다 이미 있다.**
새로 만들 store / 새 인프라 거의 없음. 명명을 고치고 표준화 하면 된다.

### 2.1 STM jsonl — InteractionEvent stream 의 자리

`ShortTermMemory.add_message(role, content, *, metadata)`
([service/memory/short_term.py:123-170](../../../backend/service/memory/short_term.py#L123-L170))
가 이미 `metadata: Dict[str, Any]` 를 옵셔널로 받아 jsonl + DB 양쪽에
저장. **즉 metadata dict 안에 우리가 정의한 dimension 을 넣기만 하면
끝.**

```jsonl
{"type":"message","role":"user","content":"hi","ts":"...","metadata":{}}
```

→ 통합 후

```jsonl
{
  "type":"message", "role":"user", "content":"hi", "ts":"...",
  "metadata": {
    "event_id":"01HX...",
    "kind":"user_chat",
    "direction":"in",
    "counterpart_id":"owner:gkfua00",
    "counterpart_role":"user"
  }
}
```

기존 retrieval (recent_turns, search) 는 *그대로* 동작 — 단지
metadata 가 *풍부해진* 채로 뜬다.

### 2.2 STM 의 role 분류 — 이미 InteractionEvent kind 의 절반

`_classify_input_role`
([executor/agent_session.py:56-104](../../../backend/service/executor/agent_session.py#L56-L104))
의 분류:

| 현재 role | 매핑되는 InteractionEvent kind |
|---|---|
| `user` | `user_chat` (direction=in, counterpart_role=user) |
| `assistant` | `user_chat` (direction=out) |
| `internal_trigger` | `reflection` (direction=internal) |
| `assistant_dm` | `dm` (direction=in/out) — 추가 dimension 으로 정확히 분류 |

이미 잘 분리되어 있다. 우리는 *이 분류를 잃지 않으면서* metadata 를
풍부하게 한다.

### 2.3 LTM `entities/` — 카운터파트별 distillation 의 자리

`StructuredMemoryWriter.write_note(category=...)`
([service/memory/structured_writer.py:95-170](../../../backend/service/memory/structured_writer.py#L95-L170))
의 `VALID_CATEGORIES` 에 **`entities`** 가 이미 있다. 이건 사람/
캐릭터 같은 *명명된 존재* 를 위한 LTM 자리다.

`entities/<paired_subworker_name>.md` 가 *VTuber 와 그 워커의 누적
관계 memory* 의 자연스러운 자리. 내용 예시:

```markdown
---
title: Sub-Worker (gkfua00 의 paired)
category: entities
tags: [paired, sub-worker, collaboration]
importance: high
source: distillation
---

# 내 paired Sub-Worker

지금까지 함께 한 작업: 23회. 성공률 87%.
잘하는 영역: 파일 작성, 간단한 리팩토링, 자료 정리.
주의: 긴 Bash 작업에서 가끔 시간이 오래 걸림.
최근 갈등 / 막힘: 2026-04-29 self_introduction 작업에서 결과 reporting 누락.

## 최근 작업 5건
- ...
```

이 파일은 *주기적 distillation* (LLM 기반) 또는 사용자 명시 호출로
갱신. 한 번 만들어 두면 vector / keyword search 에 자연스럽게 잡혀
다음 retrieval 사이클에서 다시 쓰임.

### 2.4 LTM `daily/` — 시간 축의 자리

`record_execution`
([service/memory/manager.py:500-602](../../../backend/service/memory/manager.py#L500-L602))
가 이미 `daily/YYYY-MM-DD.md` 에 자기 세션의 execution 을 적는다.
이건 *VTuber 자기 turn* 의 history. tool_run_summary 자체는 sub-worker
의 turn 이라 여기에 들어가지 않는다. 두 자리 (entities/ + daily/)
의 분담이 자연스럽다.

### 2.5 retrieval (GenyMemoryRetriever) — 그대로 작동

5-layer (recent_turns / session_summary / MEMORY.md / vector / keyword
/ backlinks / curated)
([geny-executor/src/.../memory/retriever.py:38-143](../../../../geny-executor/src/geny_executor/memory/retriever.py))
는 *모두 SessionMemoryManager 의 STM/LTM 위에서 동작*. 우리가
metadata 를 풍부하게 해도 retrieval 인터페이스는 변하지 않는다 —
content 가 풍부해지면 자연스럽게 좋은 chunks 가 lift up 된다.

단 한 가지 *능동적 활용* 을 위해 search 도구의 filter 만 확장한다
(아래 §6).

## 3. InteractionEvent — 표준 metadata schema

```python
@dataclass(frozen=True)
class InteractionEvent:
    """Single line in the VTuber's life history.

    Persisted as the `metadata` dict of one STM jsonl entry. The
    body of that entry (`role`, `content`) is unchanged — this is
    a *strict superset* of the existing schema.
    """

    event_id: str             # uuid (chronological, e.g. ULID)
    kind: Kind                # see below
    direction: Direction      # "in" | "out" | "internal"
    counterpart_id: str       # canonical id of the other party
    counterpart_role: CounterpartRole

    # Linkage — optional. tool_run_summary 가 task_request 를 가리킴 등.
    linked_event_id: Optional[str] = None

    # kind-specific structured payload — JSON-serialisable dict.
    # 예: tool_run_summary 의 payload 는 SubWorkerRun 카테고리화
    # (files_written, bash_commands, errors 등).
    payload: Dict[str, Any] = field(default_factory=dict)


class Kind(StrEnum):
    USER_CHAT          = "user_chat"          # 사용자와의 일반 대화
    DM                 = "dm"                  # 임의 카운터파트와의 평문 DM
    TASK_REQUEST       = "task_request"        # paired sub-worker 에게 task 보냄
    TASK_RESULT        = "task_result"         # paired sub-worker 의 SUB_WORKER_RESULT 수신
    TOOL_RUN_SUMMARY   = "tool_run_summary"    # P0-2 의 SubWorkerRun
    REFLECTION         = "reflection"          # THINKING_TRIGGER / ACTIVITY_TRIGGER
    SYSTEM_NOTE        = "system_note"         # 시스템 변화 (revival, schema 마이그레이션 등)


class Direction(StrEnum):
    IN       = "in"
    OUT      = "out"
    INTERNAL = "internal"


class CounterpartRole(StrEnum):
    USER             = "user"               # human
    PAIRED_SUBWORKER = "paired_subworker"
    PEER             = "peer"               # 다른 임의 세션 (미래)
    SELF             = "self"               # reflection / system_note
    SYSTEM           = "system"             # 런타임 자체 (rare)
```

**카니컬 ID 규칙**:

| counterpart_role | counterpart_id 형식 |
|---|---|
| `user` | `owner:<owner_username>` |
| `paired_subworker` | sub-worker 의 `session_id` |
| `peer` | 다른 세션의 `session_id` |
| `self` | `self` (literal) |
| `system` | `system` (literal) |

이 ID 가 **dimension 의 backbone**. 모든 retrieval / distillation /
도구 filter 가 이 위에서 동작.

## 4. 데이터 흐름 — write side

각 hook 이 InteractionEvent 의 어떤 kind 를 만드는가:

| 코드 위치 | 현재 동작 | 새 metadata 추가 |
|---|---|---|
| `_trigger_dm_response._deliver_and_respond` 가 만든 `[SYSTEM] You received a direct message ...` prompt → invoke 시작 시 `_classify_input_role(prompt) == "assistant_dm"` → STM 기록 | 본문만 기록 | `kind=dm or task_result, direction=in, counterpart_id=<sender>, counterpart_role=paired_subworker or peer, linked_event_id=<task_request 가 있다면>` |
| `_record_dm_on_sender_stm` (송신자 STM 에 outgoing DM 기록) | 본문만 기록 (`[DM to {target} (internal)]: {body}`) | `kind=dm or task_request, direction=out, counterpart_id=<target>, counterpart_role=paired_subworker or peer, payload={"task_id":...}` |
| `_notify_linked_vtuber` — sub-worker 종료 시점 | (cycle 20260430_1 P0-1 이후) explicit-report flag 로 일부 suppress | **항상** STM 에 `kind=tool_run_summary, direction=in, counterpart_id=<sub-worker session_id>, counterpart_role=paired_subworker, linked_event_id=<task_request>, payload={tool_calls categorised}` 로 기록. dispatch 결정과 *무관*. |
| `thinking_trigger` invoke 시작 prompt → `_classify_input_role == "internal_trigger"` → STM 기록 | 본문만 기록 | `kind=reflection, direction=internal, counterpart_id=self, counterpart_role=self, payload={"trigger_category": "first_idle / sub_worker_working / ..."}` |
| 사용자 chat input → user role STM 기록 | 본문만 기록 | `kind=user_chat, direction=in, counterpart_id=owner:<...>, counterpart_role=user` |
| VTuber 자기 assistant 텍스트 응답 (cycle 20260420_8 fix 가 이미 STM 기록) | 본문만 기록 | `kind=user_chat, direction=out, counterpart_id=owner:<...>, counterpart_role=user` |

핵심 invariant:

* **모든 message 는 metadata 의 표준 dimension 5개를 갖는다.** content
  자체는 손대지 않는다 (LLM-readable 자연어 그대로).
* **payload 는 kind 별 structured.** tool_run_summary 의 payload 가
  cycle 20260430_1 의 SubWorkerRun 카테고리화의 *영구 거주지*.
* **tool_run_summary 는 dispatch 와 무관하게 항상 기록.** P0-1 의
  suppression 은 *VTuber 알림* 만 막는 거고, 환경 데이터 (= 기억) 는
  보존되어야 한다.

## 5. 데이터 흐름 — read side (passive)

기존 retrieval 5-layer 는 *변동 없다*. recent_turns 는 InteractionEvent
가 metadata 만 풍부해진 STM 라인을 그대로 읽고, vector / keyword 도
content 를 인덱싱.

다만 **`recent_turns` 가 카운터파트별 균형을 가지면 좋다**. 현재는
시간순 N개. 이게 *sub-worker 와의 task 가 폭증한 turn* 에 사용자와의
직전 대화를 밀어내는 부작용을 만들 수 있다.

해결: GenyMemoryRetriever 의 `recent_turns` layer 가 metadata 의
`counterpart_role` 을 인지해 *"counterpart 별 최소 보장량"* 을 둔다.
예) recent 6개 ⇒ 사용자와의 메시지 최소 3개 보장 + 나머지는 시간순.
이건 retriever 옵션 추가로 끝남.

> 이 retriever 옵션은 *기능 변경* 이라 별도 PR 로 분리 권장. 본 cycle
> 의 *write side 표준화* 만 끝나면 retriever 가 그 데이터를 안 보고도
> 이미 기존대로 동작하므로 cycle 진행을 막지 않는다.

## 6. 데이터 흐름 — read side (능동, 도구 layer)

VTuber 가 *능동적으로* 자기 기억을 탐색하는 도구들. 모두
**progressive disclosure** 사다리. 모두 caller 자기 memory 만 봄.

### 6.1 도구 catalog

| 깊이 | 도구 | 페이로드 | 용도 |
|---|---|---|---|
| L0 | `memory_status(counterpart?)` | counterpart 의 *지금* (busy / last_seen) + 가장 최근 event 1줄 | "지금 내 워커 뭐 해?" "어제 그 사용자 마지막에 뭐랬더라?" |
| L1 | `memory_with(counterpart, kinds?, limit, since?)` | event meta list (event_id 포함) | 카운터파트별 최근 N 이벤트 |
| L2 | `memory_event(event_id)` | 한 event 의 full metadata + payload + linked events | 한 상호작용의 상세 |
| L3 | `memory_artifact(event_id, path)` | payload 의 artifact 본문 (size cap) | tool_run_summary 가 만든 파일 본문 보기 |
| 검색 | `memory_search(query, counterpart_filter?, kind_filter?)` | 의미/키워드 검색 | "지난주에 워커가 만들었던 분석 보고서" / 현재 `memory_search` 의 *확장* |
| (선택) | `memory_workspace_diff(counterpart, since_event_id?)` | 파일시스템 walk | Bash 부산물 등 SubWorkerRun 의 카테고리화 공백 보완 |

### 6.2 사다리 호출 시나리오

사용자: "어제 워커가 뭐 했어?"

```
LLM → memory_status(counterpart="paired_subworker")
  ↳ { paired:true, is_executing:false,
      last_event:{event_id:"E5", kind:"tool_run_summary",
                  ts:"...", summary:"..." } }

LLM → memory_with(counterpart="paired_subworker",
                  kinds=["tool_run_summary","task_result"],
                  limit=5)
  ↳ { events:[ {event_id:"E5",...}, {event_id:"E3",...}, ... ] }

LLM → memory_event(event_id="E5")
  ↳ { kind:"tool_run_summary", payload:{
        files_written:["self_intro.md"],
        bash_commands:[],
        ...
      },
      linked:[{event_id:"E4", kind:"task_request", content:"..."}] }

LLM → memory_artifact(event_id="E5", path="self_intro.md")
  ↳ { content:"안녕하세요 ...", size:412, truncated:false }

LLM → 사용자에게 paraphrase
```

각 단계는 **호출자의 능동 결정**. 매 turn 자동으로 들어오지 않는다.
호출하지 않는 turn 은 토큰 비용 0.

### 6.3 도구 description 디자인 원칙

각 도구의 description 은 *언제 호출할지* 와 *결과로 다음 도구의
인자를 얻을 수 있다* 는 affordance 를 명시. 예:

> `memory_with` — "List recent events with a specific counterpart
> (your paired Sub-Worker, the user, etc.). Each entry includes an
> `event_id` you can pass to `memory_event` for details. Use this
> after `memory_status` when the user wants more than the latest one."

이런 affordance 가 *prompt-side inject 없이도* LLM 이 사다리를
자연스럽게 따라가게 한다.

## 7. Distillation — 시간이 흐른 뒤의 *관계*

### 7.1 무엇을 distill 하는가

InteractionEvent stream 은 raw 데이터. 시간이 지나면 raw 만으로는
*패턴* / *경향* / *관계의 성격* 이 안 보인다. distillation 은:

* **카운터파트 별 entities/{id}.md** 를 갱신:
  * "이 워커 / 이 사용자 / 이 peer 와 누적된 협업 / 대화"
  * 잘하는 영역, 약한 영역, 갈등, 좋은 모멘트
  * 최근 N 건 요약 + 장기 누적 character profile
* **insights/{topic}.md** 갱신 (이미 존재하는 카테고리):
  * "내가 자주 잊는 것", "이 도메인에서의 학습"

### 7.2 어떻게 trigger 하는가

세 가지 방식:

1. **사용자 명시 호출 도구** — `memory_distill(counterpart)`. 사용자가
   "오늘까지의 워커와의 작업 정리해 줘" 같은 요청을 하면 VTuber 가
   호출.
2. **임계치 기반 자동** — counterpart 의 누적 event 가 N개 이상
   (default 50) 이 되면 백그라운드 cron 이 distill 호출.
3. **세션 종료/긴 idle 후** — 다음 cycle 의 후보. 본 cycle 외.

distillation 자체는 LLM 호출 (memory_model 에 위임 — agent_session
이 이미 s15 memory stage 에 같은 model 을 wiring). 한 번에 한
counterpart 만 처리해 비용/지연 통제.

### 7.3 distill 결과는 어디 사는가

`<storage>/memory/entities/<sanitized-counterpart-id>.md`. structured
note 양식. 자동으로 vector index + keyword index 에 들어가 다음
retrieval 사이클에서 lift up. *기존 LTM infrastructure 위* 에서 동작.

## 8. 미래 확장성 — 새 채널이 들어왔을 때

이 통합의 *진짜 가치*. 새 DM 기능이 추가될 때 시스템이 어떻게
받아들이는가:

| 새 기능 | 추가되는 것 | 도구 표면 변동 |
|---|---|---|
| Peer agent DM (다른 임의 세션과 1:1 대화) | `counterpart_role=peer` event 들이 stream 에 추가됨. paired guard 가 *paired_subworker 한정* 에서 *모든 alive counterpart* 로 (정책 결정 필요) | 0 — `memory_with` 가 그대로 받음 |
| Multi-VTuber (여러 vtuber 끼리 DM) | 같은 paradigm. counterpart_role=peer | 0 |
| Group chat (room) 부활 | counterpart_id="room:<id>", counterpart_role=peer (참여자 list 는 payload) | 0 |
| External API caller (예: Slack 봇이 task 보냄) | counterpart_role=external 신규 | 0 — enum 만 확장 |

이게 *통합 model 의 유일한 정당성*. 매 새 기능마다 별도 도구/별도
store 를 두면 시스템이 폭발한다. 통합 model 위에서는 *한 번 짜고
재사용*.

## 9. 보안 / 스코프 / 프라이버시

* **모든 도구는 caller 자기 memory 만 본다.** cross-session memory
  peek 는 영구 차단. paired sub-worker 의 *기억 그 자체* 는 그 워커가
  자기 STM 에 따로 가짐.
* **VTuber 의 stream 에 들어간 것은 *VTuber 의 관점에서의 기억*** —
  worker 의 raw 사용자 prompt 를 그대로 보지 않는다. tool_run_summary
  는 카테고리화된 *관찰 데이터* 만 (files_written 경로 / bash command
  preview / 도구 이름 / duration / cost).
* **artifact 도구는 sandbox** — paired sub-worker 의 working_dir +
  shared folder 안만. path traversal 차단.
* **counterpart_id 의 sanitize** — 파일명에 들어갈 때 alphanum+dash 만.
* **distillation 은 같은 vtuber session 의 LTM 으로만** 쓴다. 다른
  세션과 공유되지 않음.
* **개별 event 삭제 권한** (사용자 / 사용자 동의 운영자 한정) — `memory_delete` 의 자연스러운 확장. 단 본 cycle 외.

## 10. 마이그레이션 전략

### 10.1 무엇을 *건드리지 않는가*

* `ShortTermMemory` 의 schema (jsonl 라인 형식) — 변동 0
* `LongTermMemory` / `StructuredMemoryWriter` API — 변동 0
* `GenyMemoryRetriever` 5-layer 동작 — 변동 0
* 기존 `memory_*` 도구의 API — 변동 0 (`memory_search` 만 *확장*; 기존
  parameter 는 호환 유지)
* `_classify_input_role` — 변동 0

### 10.2 무엇을 *추가* 하는가

* `service/memory/interaction_event.py` 신규 — `InteractionEvent`,
  `Kind`, `Direction`, `CounterpartRole`, helper:
  ```python
  def make_event_metadata(*, kind, direction, counterpart_id,
                          counterpart_role, linked_event_id=None,
                          payload=None) -> Dict[str, Any]: ...
  ```
* 기존 hooks 가 위 helper 를 호출해 metadata 를 만든 뒤 기존
  `record_message` / `add_message` 의 `metadata=` 인자로 전달.
* 새 도구 5개 (memory_status / memory_with / memory_event /
  memory_artifact / memory_workspace_diff). 기존 `memory_search`
  는 옵셔널 filter 추가.
* `entities/<counterpart>.md` distillation — 별도 helper +
  `memory_distill` 도구.

### 10.3 backwards-compat

* metadata dimension 이 *없는* 옛 jsonl 라인은 retrieval 에서 그대로
  보임 (기존과 동일). 단지 새 도구 (memory_with 의 counterpart filter)
  의 결과에 안 잡힐 뿐.
* 옛 라인을 일괄 마이그레이션 할 필요 없음. *forward-only*. 새 line
  부터 dimension 채움. (필요시 별도 백필 cron 으로 rough mapping
  가능 — content prefix 분석으로 kind 추정. 본 cycle 외.)

## 11. 위험 / 트레이드오프

| 위험 | 완화 |
|---|---|
| metadata 가 jsonl 라인을 키워 토큰/디스크 비용 ↑ | dimension 5개 + payload (tool_run_summary 만 큼) → 평균 +200~500 bytes 증가. 영향 미미. |
| LLM 이 새 도구 표면을 잘못 활용 | description affordance + vtuber.md 사다리 가이드 + paired-only guard. |
| tool_run_summary 의 payload 가 비대 | 카테고리화 (cycle 20260430_1 P0-2 이미 한 일) + 도구별 args_preview 200 chars cap. 본 raw 는 P2-A jsonl 에 별도 저장. |
| persona 보호 — 워커의 내부 텍스트가 vtuber 발화에 침투 | content 는 *categorised* 만 (`Wrote notes.md`, `Ran git status — clean` 같은 짧은 표현). raw 는 payload 로 분리. retriever 가 content 를 inject 하므로 content 자체가 persona-safe 해야 함. |
| distillation 의 LLM 비용 | 임계치 / 사용자 호출 / cron throttle. 한 번에 한 counterpart. 근본적으로 *비용은 사용자 가치 만들 때만 발생*. |
| race — sub-worker 작업 중 vtuber 가 lookup | append-only 라 partial event 안 보임. tool_run_summary 는 sub-worker 종료 직후에만 append (P2-A 의 hook 위치). |
| counterpart_id 충돌 / 재사용 (세션 삭제 후 같은 이름 새 세션) | session_id 자체가 uuid 라 자연스럽게 unique. owner_username 은 사용자 단위라 안정. |
| event_id 의 정렬 / 시간 일관성 | ULID 사용 — 시간순 sortable. fallback 으로 ts 함께 저장 (이미 STM ts 가 있음). |

## 12. 본 cycle 의 *핵심 invariant 4개*

이 4개는 PR 수준의 기계적 검증 대상이다.

1. **모든 InteractionEvent 는 STM 의 metadata dict 안에 있다.** 별도 store 0.
2. **모든 hook 은 항상 metadata 를 채운다.** 빈 dict 금지 (`{}` 가 들어 있으면 회귀).
3. **모든 도구는 caller 의 자기 memory 만 본다.** cross-session 0.
4. **prompt-side 데이터 inject 0 byte.** 도구 호출 결과로만 정보가 흐름.

## 13. 본 cycle 외 / 다음 cycle 후보

* `recent_turns` 의 *카운터파트별 균형* (§5 끝의 retriever 옵션)
* InteractionEvent 의 *그룹 (room) 차원* — 미래
* DB 스키마의 metadata 인덱싱 (큰 deployment 에서 lookup 가속)
* `memory_distill` 의 자동 cron + 임계치 trigger
* 옛 jsonl 라인의 백필 마이그레이션
* chat panel UI 의 InteractionEvent stream 시각화 — admin observability

## 14. 다음 단계

[`plan/cycle_plan.md`](../plan/cycle_plan.md) 에 PR ladder, 의존성,
테스트 항목을 *통합 paradigm 위에서* 다시 작성한다.

이 문서는 [analysis/02](02_progressive_disclosure_revision.md) 의
*progressive disclosure 원칙을 그대로 유지* 하면서, *데이터 모델
자체* 를 한 단계 깊이로 끌어내린 결과다. 02 가 도구 ecosystem 의
*형태* 를 정의했다면, 03 은 그 ecosystem 이 *살고 있는 환경의 본질*
을 정의한다.
