# Cycle 20260430_2 — Plan (통합 paradigm 위에서 재작성)

> Goal: VTuber 의 *모든 상호작용을 단일 InteractionEvent stream 으로*
> 통합 관리한다. Sub-Worker DM, 사용자 chat, 자기 reflection 모두
> 같은 memory model. 기존 STM/LTM 을 *대체하지 않고 강화*.
>
> 분석 / 철학:
> [`analysis/03_memory_unification.md`](../analysis/03_memory_unification.md).
> Progressive disclosure 원칙:
> [`analysis/02_progressive_disclosure_revision.md`](../analysis/02_progressive_disclosure_revision.md).
> 현황 진단:
> [`analysis/01_subworker_observability.md`](../analysis/01_subworker_observability.md) §1~7.
>
> Note: 이전 plan 파일이 *쓸모없는 도구만 추가하는* 안이었기 때문에
> 본 plan 으로 대체한다 — 이전 안의 후보들 (worker_status / worker_recent_runs
> / worker_run_detail / worker_read_artifact 등) 은 *통합 memory 도구*
> (memory_status / memory_with / memory_event / memory_artifact) 의
> 한 슬라이스로 자연스럽게 흡수.

본 cycle 의 4개 *invariant* (모든 PR 의 첫 테스트로 박힘):

1. 모든 InteractionEvent 는 STM 의 metadata dict 안에 있다 (별도 store 0).
2. 모든 hook 은 항상 metadata 를 채운다 (빈 `{}` 금지).
3. 모든 도구는 caller 의 자기 memory 만 본다 (cross-session 0).
4. prompt-side 데이터 inject 0 byte.

각 단계는 독립 PR. 이전 단계 머지 후 다음 단계 시작.

---

## Stage A — Write side: metadata 표준화 (단일 토대)

### A1 — `InteractionEvent` schema + helper ★ 가장 먼저

**무엇**

신규 `backend/service/memory/interaction_event.py`:

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional
import ulid  # or uuid4 if ulid unavailable
import datetime as dt


class Kind(str, Enum):
    USER_CHAT        = "user_chat"
    DM               = "dm"
    TASK_REQUEST     = "task_request"
    TASK_RESULT      = "task_result"
    TOOL_RUN_SUMMARY = "tool_run_summary"
    REFLECTION       = "reflection"
    SYSTEM_NOTE      = "system_note"


class Direction(str, Enum):
    IN       = "in"
    OUT      = "out"
    INTERNAL = "internal"


class CounterpartRole(str, Enum):
    USER             = "user"
    PAIRED_SUBWORKER = "paired_subworker"
    PEER             = "peer"
    SELF             = "self"
    SYSTEM           = "system"


def new_event_id() -> str:
    """ULID-style; falls back to uuid4 if ulid not installed."""
    ...


def make_event_metadata(
    *,
    kind: Kind,
    direction: Direction,
    counterpart_id: str,
    counterpart_role: CounterpartRole,
    linked_event_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Return the canonical metadata dict to attach to STM.add_message."""
    return {
        "event_id": new_event_id(),
        "kind": kind.value,
        "direction": direction.value,
        "counterpart_id": counterpart_id,
        "counterpart_role": counterpart_role.value,
        **({"linked_event_id": linked_event_id} if linked_event_id else {}),
        **({"payload": payload} if payload else {}),
    }


def canonical_user_id(owner_username: Optional[str]) -> str:
    return f"owner:{owner_username}" if owner_username else "owner:unknown"
```

* 검증 helper: `parse_event_metadata(meta_dict) -> Optional[InteractionEvent]` —
  옛 jsonl 라인을 읽을 때 metadata 가 빈 dict 면 None 반환 (forward-compat).
* helper test: dict round-trip, missing field → 적절한 default.

**테스트**

* `make_event_metadata` 의 모든 kind / direction / counterpart_role 값 round-trip
* `event_id` uniqueness (1만번 생성 충돌 없음)
* `parse_event_metadata` 가 빈 dict 에 대해 None
* `canonical_user_id` 정규화 (None / 빈 / 정상)

**Risk**: ulid 의존성 — 첫 PR 은 uuid4 fallback only 로 시작해도 됨.

---

### A2 — `_record_dm_on_sender_stm` 어댑터 (outgoing DM)

**무엇**

[tools/built_in/geny_tools.py:97-139](../../../backend/tools/built_in/geny_tools.py#L97-L139)
의 helper 가 STM 에 적을 때 metadata 를 채운다.

* counterpart_role 결정: caller 의 `_session_type` 이 vtuber 이고
  target 이 paired sub-worker 면 `PAIRED_SUBWORKER`, 그 외 `PEER`.
* kind 결정: `[SUB_WORKER_RESULT]` body 시작이면 `TASK_RESULT` (드물게 발생) /
  paired 에게 보내는 일반 task 면 `TASK_REQUEST` / 그 외 `DM`.
* counterpart_id: target session_id.

```python
def _record_dm_on_sender_stm(*, session_id, content, target_label,
                              channel, target_session_id):
    ...
    # 기존 LTM 영향 0. 단지 metadata 만 추가.
    memory.record_message(
        "assistant_dm", body[:10000],
        # 신규 metadata
        metadata=make_event_metadata(
            kind=Kind.TASK_REQUEST if (
                getattr(self_agent, "_session_type", None) == "vtuber"
                and target_role == CounterpartRole.PAIRED_SUBWORKER
            ) else Kind.DM,
            direction=Direction.OUT,
            counterpart_id=target_session_id,
            counterpart_role=...,
        ),
    )
```

**구현 디테일**

* `record_message(role, content, **metadata)` 의 가변 `**metadata`
  접근에 주의. 현재 시그니처가 metadata 를 *통째 dict 로* 받는지
  *kwargs* 로 받는지 확인 후 어댑터에서 `**meta` 또는 `metadata=meta`
  로 일치시킴 ([service/memory/manager.py:200-220](../../../backend/service/memory/manager.py#L200-L220)).

**테스트**

* paired sub-worker 에게 task 보냄 → metadata.kind == TASK_REQUEST
* peer 에게 DM → metadata.kind == DM
* `[SUB_WORKER_RESULT]` 본문으로 보냄 (희귀; sub-worker 가 vtuber
  쪽으로) → metadata.kind == TASK_RESULT
* metadata 가 *항상* 채워짐 (invariant 2)

---

### A3 — `_trigger_dm_response` 어댑터 (incoming DM 의 vtuber 측 기록)

**무엇**

수신 측은 `_trigger_dm_response` 가 만든
`[SYSTEM] You received a direct message ...` prompt 가 invoke 되면서
`_classify_input_role` 이 `assistant_dm` 으로 분류 → STM 에 들어간다.
이 자리는 *invoke 의 입력 record_message* 호출
([executor/agent_session.py:2004-2010](../../../backend/service/executor/agent_session.py#L2004-L2010))
에서 일어남.

문제: 그 자리는 *generic* — 어떤 prompt 가 어떤 sender 에게서 왔는지
모른다. 수정 방향은 둘 중 하나:

* (a) invoke 의 `record_message` 가 prompt 의 `[SYSTEM] You received
  a direct message from {name} (session: {id})` 헤더를 파싱해서
  metadata 를 만들 (parser 로직).
* (b) `_trigger_dm_response` 가 invoke 를 트리거할 때 새로운
  `invoke(... extra_metadata=...)` 인자를 통해 미리 metadata 를 박아 둠.

(b) 가 더 깨끗 — *어디서 들어왔는지 아는 곳에서 metadata 를 만든다*.
구현 방안:

* `agent.invoke(..., source_metadata: Optional[Dict] = None)` 인자 추가
* `_invoke_pipeline` 시작 시 `record_message` 의 metadata 인자에
  `source_metadata` 를 inject (없으면 parser fallback)
* `_trigger_dm_response` 가 source_metadata 채워서 호출

**테스트**

* sub-worker 가 task_result 보냄 → vtuber STM 의 metadata.kind == TASK_RESULT, direction=IN, counterpart_id=<sub session_id>, linked_event_id=<원래 task_request id>
* parser fallback 동작 (source_metadata 미전달 시 prompt 파싱)

**Risk**: agent_session 시그니처 변경 — backwards-compat 유지 위해
keyword-only + default None.

---

### A4 — `_notify_linked_vtuber` 어댑터 (tool_run_summary 의 영구 기록)

**무엇**

cycle 20260430_1 P0-2 가 만든 `_compose_subworker_payload_from_tools`
의 카테고리화 결과를 *VTuber 의 STM* 에 영구 기록.

핵심: **dispatch 결정 (P0-1 의 explicit-report suppress 등) 과 무관하게
항상 기록.** suppress 는 "VTuber 알림" 만 막는 것; 기억 자체는 보존.

위치: `_notify_linked_vtuber`
([service/execution/agent_executor.py:183-...](../../../backend/service/execution/agent_executor.py#L183))
의 진입 직후, suppress 분기 *전에* tool_run_summary 를 vtuber STM 에
append.

```python
async def _notify_linked_vtuber(session_id, result):
    ...
    # vtuber_agent 가 잡혀 있는 시점
    try:
        vtuber_memory = getattr(vtuber_agent, "_memory_manager", None)
        if vtuber_memory is not None:
            payload = _categorize_tool_calls(result.tool_calls)  # P0-2 카테고리화 재사용
            content_repr = _short_summary(payload)               # "Wrote 1 file, ran 0 commands."
            vtuber_memory.record_message(
                "subworker_run",  # 신규 role label, _classify_input_role 가 이미 assistant_dm 비슷하게 다룰지 결정 필요 — 안 하면 새 role 추가
                content_repr,
                metadata=make_event_metadata(
                    kind=Kind.TOOL_RUN_SUMMARY,
                    direction=Direction.IN,
                    counterpart_id=session_id,           # sub-worker
                    counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
                    linked_event_id=...,                  # 마지막 task_request 의 event_id (옵셔널)
                    payload={
                        "files_written": payload["files_written"],
                        "files_read": payload["files_read"],
                        "bash_commands": payload["bash_commands"],
                        "web_fetches": payload["web_fetches"],
                        "errors": payload["errors"],
                        "duration_ms": result.duration_ms,
                        "cost_usd": result.cost_usd,
                        "status": ...,
                        "raw_tool_calls": result.tool_calls,  # debug 용 raw
                    },
                ),
            )
    except Exception:
        logger.debug("tool_run_summary record failed", exc_info=True)

    # 기존 dispatch 분기 (P0-1 / P0-3 / P1-1 그대로) ...
```

**핵심 디테일**

* role label 의 선택: `subworker_run` 신규 role vs `assistant_dm` 재활용.
  retrieval 표시 일관성을 위해 **`assistant_dm` 재활용** 권장 — content
  표현이 자연어 ("Wrote 1 file, ran 0 commands") 라 일관됨. 단
  `_classify_input_role` 이 이걸 input 으로 받았을 때 처리되는 케이스가
  *없다* (이건 record-only). 그래서 안전.
* content_repr 는 *짧은 자연어* 한 줄. raw_tool_calls 는 payload 로 분리.
* linked_event_id 의 최선의 노력: 직전 `_record_dm_on_sender_stm` 가
  만든 task_request 의 event_id 를 vtuber STM tail 에서 lookup. 미발견시
  None.

**테스트**

* tool only worker run → vtuber STM 에 metadata.kind == TOOL_RUN_SUMMARY
- 기록됨
* P0-1 suppress (explicit report sent) → metadata 는 *그래도* 기록되어야 함
* P0-3 empty turn (도구 0 + 평문 0) → tool_run_summary 도 기록 안 함 (의미 없는 event)
* linked_event_id 가 직전 task_request 와 매칭

**Risk**: vtuber_memory_manager 가 없는 케이스 (game/test) → silent skip.

---

### A5 — `thinking_trigger` / `activity_trigger` 어댑터 (reflection)

**무엇**

`_classify_input_role` 이 `internal_trigger` 로 분류한 prompt 가
record_message 될 때 metadata 추가. invoke 의 `source_metadata` 메커니즘
재사용 (A3 와 같은 path).

* kind = REFLECTION
* direction = INTERNAL
* counterpart_id = "self"
* counterpart_role = SELF
* payload = `{"trigger_category": "first_idle | sub_worker_working | activity_web_surf | ..."}`

**구현 위치**

* `ThinkingTriggerService._fire_trigger` 가 `execute_command` 호출 시
  `source_metadata` 전달 (A3 의 인자).

**테스트**

* sub_worker_working trigger → metadata.payload.trigger_category == "sub_worker_working"
* first_idle → 마찬가지
* counterpart_id 는 항상 "self"

---

### A6 — 사용자 chat input 의 어댑터

**무엇**

사용자 chat → record_message("user", content) 의 자리. 같은 invoke
source_metadata 메커니즘으로:

* kind = USER_CHAT
* direction = IN
* counterpart_id = `owner:<username>` (canonical_user_id 헬퍼)
* counterpart_role = USER

VTuber 의 *자기 응답* 도 record_message("assistant", content) 자리에서
같은 metadata (direction=OUT) 로.

**구현 위치**

* chat broadcast / agent_controller 의 invoke 호출자가 source_metadata
  전달. 이 자리는 broadcast 컨텍스트가 user 인 걸 확실히 알기 때문에
  좋은 자리.

**테스트**

* 사용자 chat → STM 의 metadata.kind == USER_CHAT IN
* assistant text → ... OUT
* 두 라인의 counterpart_id 일치

---

## Stage B — Read side: progressive memory tools

### B1 — `memory_status(counterpart?)` (L0)

**무엇**

```python
class MemoryStatusTool(BaseTool):
    name = "memory_status"
    description = (
        "One-line snapshot of your most recent interaction with a "
        "counterpart (your paired Sub-Worker, the user, or — when "
        "no counterpart is given — your last interaction overall). "
        "Use this as the FIRST step when the user asks 'what's "
        "happening with X' or 'what did Y just do'. Cheap; safe to "
        "call any time."
    )
    parameters = {
        "type": "object",
        "properties": {
            "counterpart": {
                "type": "string",
                "description": (
                    "Counterpart id. Use 'paired_subworker' for your "
                    "bound Sub-Worker, 'user' for the current user, "
                    "or omit for the latest event regardless of "
                    "counterpart."
                ),
            }
        }
    }
```

결과:
```json
{
  "counterpart": "paired_subworker",
  "counterpart_id": "sub-1",
  "is_executing": false,
  "last_event": {
    "event_id": "...", "kind": "tool_run_summary",
    "direction": "in", "ts": "...",
    "summary": "Wrote 1 file (notes.md)."
  }
}
```

**구현**

* caller (vtuber) 의 STM 을 tail-scan, metadata.counterpart_role 일치
  하는 가장 최근 event 1개.
* counterpart 인자가 alias (`paired_subworker`, `user`) 면 자동 변환
  (helper 가 caller agent 에서 resolve).

**테스트**

* paired 있고 last event 있음 → 결과
* counterpart 없음 → 가장 최근 event 일반
* unpaired vtuber + counterpart="paired_subworker" → null

### B2 — `memory_with(counterpart, kinds?, limit, since?)` (L1)

**무엇**

특정 카운터파트와의 최근 N event 메타. event_id 포함 (B2→B3 chained
nav).

결과:
```json
{
  "counterpart_id": "sub-1",
  "events": [
    {
      "event_id": "...", "kind": "tool_run_summary",
      "direction": "in", "ts": "...", "summary": "..."
    },
    ...
  ]
}
```

* limit clamp 1..50
* kinds filter (옵셔널)
* since (event_id 또는 ISO ts) 옵셔널 — 그 이후 events
* 시간 역순 (newest first)

### B3 — `memory_event(event_id)` (L2)

**무엇**

한 event 의 *full payload* + linked events resolve.

결과:
```json
{
  "event": {
    "event_id": "...", "kind": "tool_run_summary",
    "ts": "...", "content": "...",
    "metadata": { ... 전체 ... },
    "payload": { ... 전체 ... }
  },
  "linked": {
    "parent": { "event_id": "...", "kind": "task_request", ... }
  }
}
```

linked.parent 는 metadata.linked_event_id 가 가리키는 event 를 resolve.

**테스트**

* tool_run_summary 의 event_id → payload + parent task_request resolve
* unknown event_id → error (caller 의 STM 안에 없음)

### B4 — `memory_artifact(event_id, path)` (L3)

**무엇**

* event 의 payload.files_written 안에 path 포함되어 있어야 함 (정합성 가드).
* paired sub-worker 의 working_dir + shared 경로 안만 read.
* size cap 64KB (max 256KB).

결과:
```json
{
  "event_id": "...", "path": "notes.md",
  "size_bytes": 412, "truncated": false, "content": "..."
}
```

**테스트**

* 정상 read
* path 가 payload.files_written 에 없음 → 거부 (security 강화)
* path traversal / 절대경로 거부

### B5 — `memory_search` 의 *옵셔널 filter 확장*

**무엇**

기존 `memory_search(query, max_results)` 시그니처에 옵셔널
`counterpart_id`, `kinds` 추가. backward-compat — 옛 호출자 무영향.

* search 결과의 entry metadata 에서 counterpart_id / kind 매칭.

---

## Stage C — Distillation

### C1 — `entities/<counterpart>.md` 자동 부트스트랩

**무엇**

새 counterpart 가 처음 등장한 직후 (= 첫 InteractionEvent 가 그
counterpart 와 record 되는 순간) `entities/<sanitized>.md` 가 없으면
빈 stub 을 생성.

```markdown
---
title: <counterpart label>
category: entities
tags: [<role>]
importance: medium
source: bootstrap
---

# <label>

(아직 distillation 이 진행되지 않았어요. memory_distill 을 호출하면
누적된 상호작용을 요약해 둡니다.)
```

이게 있는 것만으로도 LTM/vector 에 잡혀 retrieval 에서 lift up 가능.

### C2 — `memory_distill(counterpart)` 도구

**무엇**

* paired-only counterpart 한정 (지금 cycle).
* InteractionEvent stream 에서 그 counterpart 와의 최근 N (default
  100) event 만 추려 LLM 에 요약 요청 (memory_model 사용).
* 결과를 `entities/<sanitized>.md` 에 *덮어쓰기* (점진 갱신은 다음 cycle).
* 비용: 한 번 호출 ≈ 1 LLM call. 사용자 호출 또는 백그라운드 cron 에서만.

**테스트**

* counterpart 와의 event 5개 이상 있어야 호출 가능 (의미 없는 호출 차단)
* 결과 파일이 entities/ 카테고리로 저장
* vector index 에 자동 등록 (structured_writer 의 기존 path 사용)

---

## Stage D — Contract / 환경 통합

### D1 — `vtuber.md` 의 짧은 사다리 가이드

```markdown
## Recalling Your Memory

When the user asks anything about past interactions — "what did the
Worker do", "what did I tell you yesterday", "have we discussed X" —
walk this ladder:

1. `memory_status(counterpart?)` — one-line snapshot.
2. `memory_with(counterpart, kinds?, limit)` — list past events.
3. `memory_event(event_id)` — drill into a specific event.
4. `memory_artifact(event_id, path)` — read a file produced in
   that event.
5. `memory_search(query, ...)` — semantic / keyword recall when
   you don't know which counterpart.

For long-term character of a relationship (your Sub-Worker, the
current user), `memory_distill(counterpart)` once in a while.

You will not receive any of this information unless you call for it.
```

**중요**: 이 단락도 데이터 *inject 가 아니다*. 도구 catalog 사용
가이드일 뿐.

### D2 — env_template / tool roster 회귀

* `_PLATFORM_TOOL_SOURCES` 에 새 도구 모듈 등록
* `_VTUBER_PLATFORM_DENY` 변동 0 (새 도구는 *허용*)
* test: `_vtuber_tool_roster(...)` 출력에 5개 도구 (memory_status / memory_with / memory_event / memory_artifact / memory_distill) 모두 포함

---

## PR ladder (의존성 그래프)

```
A1 (InteractionEvent schema)
 ├── A2 (outgoing DM 어댑터)
 ├── A3 (incoming DM via invoke source_metadata)
 │     ├── A5 (thinking_trigger)
 │     └── A6 (user chat)
 └── A4 (tool_run_summary record)
                                       │
                                       ▼  (Stage A 전체 머지 후)
                                       │
                                       ▼
B1 (memory_status)
 ├── B2 (memory_with)
 │     └── B3 (memory_event)
 │           └── B4 (memory_artifact)
 └── B5 (memory_search filter 확장)
                                       │
                                       ▼  (Stage B 머지 후)
                                       │
                                       ▼
C1 (entities/ bootstrap)
 └── C2 (memory_distill)
                                       │
                                       ▼
D1 (vtuber.md 사다리 가이드)
D2 (env / roster 회귀)
```

---

## 매 PR 의 *공통 첫 테스트* (4 invariant 검증)

각 PR 의 PR body 에 다음 체크 명시:

* [ ] `make_event_metadata` helper 외 *모든 hook* 가 metadata 를 채움 (invariant 2)
* [ ] 새 도구 / 어댑터가 *caller 의 자기 memory 만* 본다 — paired guard 또는 own session_id (invariant 3)
* [ ] system prompt 빌더 (sections.py / build_agent_prompt / attach_runtime) 의 *어떤 변경도 없다* — grep diff 확인 (invariant 4)
* [ ] 별도 store/DB 추가 0 — `service/memory/short_term.py` / `structured_writer.py` 만 사용 (invariant 1)

---

## Non-goals (이 cycle 에서 안 한다)

* `recent_turns` retriever 의 *카운터파트별 균형* — 별 cycle
* InteractionEvent 의 *그룹 (room) 차원* — 미래
* DB 스키마의 metadata 인덱싱 (지금은 jsonl 의 metadata dict 만 활용)
* `memory_distill` 의 자동 cron + 임계치 trigger — 본 cycle 은 *수동* 만
* 옛 jsonl 라인의 백필 마이그레이션 — forward-only
* chat panel UI 의 InteractionEvent stream 시각화
* Vector index 의 페어 공유 — 영구 폐기
* **Prompt-side 데이터 inject — 영구 폐기**

---

## 가치 / 결과 — 이 cycle 이 끝나면

* **VTuber 의 인지 model 이 통합됨.** 사용자와의 대화, sub-worker 와의
  task, 자기 reflection 모두 같은 stream. 같은 도구로 회상.
* **Sub-worker 작업이 *기억* 으로 영속화.** 매번 휘발하던
  ExecutionResult / SubWorkerRun 이 InteractionEvent 의 한 종류로 STM
  에 영구 거주.
* **VTuber 가 자기 기억을 *능동적* 으로 탐색 가능.** prompt-side inject
  없이 도구 사다리만으로.
* **미래 확장의 토대.** Peer agent, multi-vtuber, room chat, external
  caller — 어떤 새 채널이 들어와도 *같은 model*. 도구 표면 변동 0.
* **distillation 의 자리 마련.** entities/{counterpart}.md 가 *관계
  long-term memory* 의 자연스러운 자리. 다음 cycle 에서 자동 cron 만
  붙이면 끝.

이게 본 cycle 이 끝났을 때 사용자가 즉시 체감하는 차이다.
