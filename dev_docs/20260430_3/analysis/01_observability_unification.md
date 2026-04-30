# Observability 통합 — InteractionEvent stream 의 모든 surface 노출

> **Cycle**: 20260430_3 · **Date**: 2026-04-30
>
> 직전 cycle 20260430_2 에서 *모든 상호작용 = InteractionEvent* 라는
> 인지 모델을 데이터 layer 까지 통합했다 ([analysis/03](../../20260430_2/analysis/03_memory_unification.md)).
> 그 cycle 의 의도된 *non-goal* 은 chat panel / memory UI 의 시각화
> 였다 — 데이터 모델이 안정된 다음에 다루기로 한 항목.
>
> 본 cycle 은 그 약속을 정확히 처리한다 — *어디서 보든 (운영자 UI /
> VTuber 자기 도구 / 사용자 channel) 같은 stream 을 즉각 검증할 수
> 있도록* 만든다. 더불어 distillation 의 LLM 통합도 같이 — 통계
> 합성 stub 만으로는 entities/<id>.md 가 어색하게 비어 있는 점을 해결.

## 0. 회귀의 진단 (사용자 보고)

스크린샷:
- VTuber 가 progressive memory 도구들을 잘 호출 (memory_with /
  memory_event / memory_artifact 모두 결과 반환). 페어 sub-worker 의
  `test.txt` 생성을 정확히 paraphrase.
- Memory UI 의 좌측 트리에는 옛 `daily/Execution #N — unknown path`
  markdown 만 보임. 새 InteractionEvent 는 *어디에도 보이지 않음*.

원인은 회귀가 아니라 *UI 가 보는 자리* 의 누락:

| 종류 | 저장 위치 | UI 가 보는가 |
|---|---|---|
| **STM jsonl + DB** (cycle 20260430_2 InteractionEvent 거주지) | `<storage>/transcripts/session.jsonl` (+ DB `stm_*`) | ❌ |
| **LTM markdown** (옛 자리) | `<storage>/memory/*.md` (daily/, root/, topics/, entities/, …) | ✅ MemoryTab 만 이걸 봄 |

`memory_controller.py` 의 모든 endpoint 가 `<storage>/memory/*.md` 만
expose. `transcripts/session.jsonl` 을 노출하는 endpoint 가 0개.
프론트의 MemoryTab 도 그 endpoint 만 fetch.

cycle 20260430_2 의 의도된 deferral — analysis/03 §13 "다음 cycle 후보"
의 첫 항목이 정확히 *"chat panel UI 의 InteractionEvent stream
시각화 — admin observability"*.

## 1. 본 cycle 의 *완성* 범위

사용자 요구: "전체적으로 완벽하게 완성해 놔. 간단한 즉시 효과가
아니라 제대로 만들어놓으라고."

따라서 즉시 fix 가 아니라 **5 layer 동시 통합**:

| Layer | 무엇이 도착하는가 |
|---|---|
| **Backend API** | `/api/agents/{sid}/transcripts*` — InteractionEvent 의 단일 진실 endpoint 셋 (list / detail / counterparts summary) |
| **자동 bootstrap** | 모든 새 counterpart 등장 시 `entities/<sanitized>.md` 자동 stub — 기존 MemoryTab 의 LTM 트리에서 *처음 1 turn 만에* "이 사람과의 기억" 노드가 보임 |
| **Frontend Stream UI** | MemoryTab 에 새 탭 "Stream" — 카운터파트 사이드바 + 이벤트 timeline + payload modal (artifact 본문 inline) |
| **Search 통합** | 기존 검색 결과에 InteractionEvent hit 가 *event_id/kind/counterpart* 와 함께 표시; counterpart/kind 필터 드롭다운 |
| **Distillation 의 LLM 통합** | `memory_distill(narrative=true)` 가 memory_model 로 풍성한 자연어 요약 생성. entities/<id>.md 의 body = stats + narrative |

이 5 layer 가 모두 들어오면 — 운영자가 어떤 surface 에서 봐도 같은
stream 이 즉시 보인다. *"memory 가 어디 살고 있나?"* 질문은 영구
사라진다.

## 2. Layer 1 — Backend transcripts API

### 2.1 새 endpoint 셋

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/agents/{sid}/transcripts` | InteractionEvent stream 페이징 + 필터 |
| GET | `/api/agents/{sid}/transcripts/{event_id}` | 단일 event detail (memory_event 와 동일 schema, 운영자 view) |
| GET | `/api/agents/{sid}/transcripts/counterparts` | counterpart 별 카드 (id / role / 이벤트 카운트 / 가장 최근 ts) |

### 2.2 list endpoint 의 query params

```
limit         int    default 50, max 200
cursor        str    이전 응답의 next_cursor 또는 ts/event_id
counterpart   str    canonical counterpart_id
kinds         str    쉼표 구분 ("dm,task_request,task_result,...")
direction     str    "in" | "out" | "internal"
since         str    ISO ts 또는 event_id
```

응답 schema:
```json
{
  "events": [{...summarised event...}, ...],
  "next_cursor": "evt-...",
  "has_more": true,
  "total_estimate": 142
}
```

### 2.3 권한 / 스코프

* 운영자가 임의 세션의 `transcripts` 를 본다 — 이건 *admin observability* 이지 LLM 도구가 아니다. 따라서 LLM 한테 노출하지 않음 (memory_inspect_tools 는 그대로 caller-scoped).
* admin auth 통과만 검증 — 별도 ACL 추가 없음.

## 3. Layer 2 — Entities 자동 bootstrap

### 3.1 트리거 위치

`SessionMemoryManager.record_message` 의 *metadata 가 InteractionEvent
schema 를 충족할 때만*. 그 한 자리에서 hook — 모든 hook (A2/A3/A4/A5/A6) 이
같은 record_message 를 통과하므로 자연스럽게 단일 진입.

### 3.2 동작 규칙

1. metadata 에서 `counterpart_id` / `counterpart_role` 추출.
2. counterpart_id 가 *self* / *system* 이면 skip — entities 는 외부와의 관계이므로.
3. file path: `entities/<sanitized>.md` (cycle 20260430_2 C 의 sanitize 헬퍼 재사용).
4. file 이 *이미 있으면* skip (idempotent).
5. structured_writer 가 None 이면 silent.
6. structured_writer.write_note(category=entities, filename_override=...) 로 *최소 stub* 작성.
   * stub body 는 한 줄: "(아직 distillation 이 진행되지 않았어요. memory_distill 을 호출하면 누적된 상호작용을 요약해 둡니다.)"
   * frontmatter: title=`Counterpart <id>`, tags=[`entity`, `<role>`], importance=medium, source=bootstrap.

### 3.3 왜 안전한가 (분석 03 §10 의 invariant 4 위배 X)

* prompt-side data inject 와 무관. 이건 *환경 (= file system) 의 일부*.
* file 갱신은 LTM 의 정상 흐름. retrieval (vector / keyword) 가 stub 도 잡음 — 그게 이 단계의 가치.
* prompt 는 변동 0.

## 4. Layer 3 — Frontend Stream UI

### 4.1 화면 구조

```
┌─ MemoryTab ────────────────────────────────────────────┐
│ [Session] [Global]    [LTM Notes] [Stream]            │  ← 새 sub-tab
├────────────────────────────────────────────────────────┤
│ Counterparts │  Events (timeline, newest first)       │
│              │                                         │
│ [paired sub] │  ─ ts ─ kind ─ direction ─ summary ─ ▶ │  ← 클릭 → modal
│  3 events    │  ─ ts ─ kind ─ direction ─ summary ─ ▶ │
│              │  ...                                    │
│ [user:alice] │                                         │
│  12 events   │  [Load more] (cursor 페이징)            │
│              │                                         │
│ [self]       │                                         │
│  4 events    │                                         │
└──────────────┴────────────────────────────────────────┘
```

### 4.2 Event detail modal

* 모든 metadata + payload 표시 (JSON pretty)
* `linked_event_id` 클릭 → parent event modal 로 chain
* `payload.files_written` 의 path 클릭 → 인라인 본문 expand (memory_artifact 와 같은 read 경로)
* "raw_tool_calls" 는 접힌 상태로 디폴트 (긴 payload 라)

### 4.3 필터

* Kind multiselect (chips)
* Direction toggle (`in` / `out` / `internal` / 모두)
* Counterpart 사이드바 = 자동 필터

### 4.4 검색 (Layer 4 와 결합)

검색 입력은 LTM Notes 탭과 공유. 검색 시 결과 패널이 LTM 결과와
InteractionEvent hit 를 분리 (LTM ▶ N개 / Stream ▶ M개). Stream hit
클릭 → Stream 탭의 detail modal.

## 5. Layer 4 — Memory search 의 InteractionEvent UI 통합

* MemorySearchResults 컴포넌트가 결과 entry 가 `event_id` 를 갖고
  있을 때 *추가 라벨* (kind / counterpart / direction) 표시.
* 검색 form 에 counterpart/kind 드롭다운. counterpart 옵션은 위 §2.3
  의 `counterparts` endpoint 에서 fetch.
* 백엔드는 cycle 20260430_2 B5 의 `memory_search(counterpart, kinds)`
  필터 그대로 — 새 endpoint 추가 X.

## 6. Layer 5 — Distillation 의 LLM 통합

### 6.1 현 상태와 한계

cycle 20260430_2 C 의 `memory_distill` 은 *통계만* 합성 (kind 분포
/ files / counts). entities/<id>.md 의 body 가 다음과 같음:

```markdown
# Counterpart sub-1
- Events observed: 8
- Kinds: task_request=4, tool_run_summary=4
- Files written: 3
    - notes.md
    - report.md
    - ...
```

읽기 좋지만 *관계의 character* 는 안 잡힘 — 어떤 패턴, 강점/약점,
인상적이었던 모멘트.

### 6.2 LLM 통합

`memory_distill` 에 `narrative=false` 디폴트, `narrative=true` 시 LLM
호출:

* 입력: counterpart 와의 최근 N events 의 카테고리화 + content
  (≤ 8K chars cap)
* 모델: `APIConfig.memory_model` (s15 와 같은 model — agent_session 의
  기존 wiring 재사용)
* prompt: "이 카운터파트와의 관계를 한 단락으로 요약. 협업 패턴 /
  강점 / 약점 / 인상적이었던 모멘트 / 다음 단계 추천. 2~4 문장."
* 결과 narrative 을 entities/<id>.md 의 body 에 stats *위에* 배치:

```markdown
# Counterpart sub-1

이 워커와는 지금까지 8회 협업했고, 파일 작성 위주의 task 에 매우
안정적인 모습을 보여줬다. 가장 안정적인 영역은 file write (실패 0) /
가장 약한 영역은 long-running bash 작업 (durations 이 점차 증가).
이번 turn 에서는 self-introduction 을 의외로 성실하게 작성한 것이
인상적.

---

## Stats
- Events observed: 8
- Kinds: task_request=4, tool_run_summary=4
...
```

### 6.3 비용 / 캐싱

* 1 호출 ≈ 1 LLM call (memory_model — usually cheap tier).
* 호출은 *명시적* — 자동 cron 은 본 cycle 외.
* `update_note=true` 와 결합: distill 결과 + narrative 가 entities
  파일에 영구 거주.
* 실패 시 stats only fallback (graceful).

## 7. 보안 / 스코프 / 위험

### 7.1 transcripts endpoint

* admin auth 통과 + session 존재 검증. 그 외 별도 ACL 0 — 운영자가
  본인 워크스페이스의 STM 을 보는 건 자연스러운 기본 권한.
* 본문 그대로 노출 — STM 의 raw content 가 그대로 보임. 이건 의도된
  운영자 view (sanitize 하지 않음). frontend 가 markdown 렌더링 시
  XSS 방지는 ReactMarkdown 자체 보호.

### 7.2 Entities bootstrap

* counterpart_id sanitize → filename safe (cycle 20260430_2 C 의
  헬퍼 재사용 — `[A-Za-z0-9_-]` only, 80 chars cap).
* file 존재 시 skip — 같은 counterpart 의 매 event 마다 file write
  하지 않음.
* structured_writer 없으면 silent.
* `record_message` 의 hot path 에 새 file IO 가 들어가는 점 — 첫
  접촉 1번 file exists check + 1번 write. 이후엔 1번 stat call 만.

### 7.3 Stream UI

* 페이징은 cursor-based — 큰 STM 도 안전.
* event detail modal 의 `payload.raw_tool_calls` 는 접힌 상태 — 긴
  payload 가 화면 부담을 주지 않음.

### 7.4 Distillation LLM 통합

* memory_model 호출 비용. 사용자가 명시적으로 `narrative=true` 시.
* LLM 실패 → stats only 로 fallback. graceful.
* 결과 length cap (2K chars) — 무한 길어지지 않음.

## 8. 마이그레이션 전략

본 cycle 의 변경은 *모두 add-only*:

* `transcripts*` endpoint 신규 추가 (기존 `memory*` 무영향)
* entities bootstrap 은 새 helper + record_message 의 hook (silent on absent writer / on existing file)
* Frontend Stream 탭은 *추가* (LTM Notes 탭 무변동)
* Search 결과의 추가 라벨은 conditional (event_id 있을 때만 표시)
* Distill 의 narrative 는 옵셔널 — 디폴트 false

기존 데이터/세션 무영향.

## 9. 실현될 *완성된 가시성*

cycle 20260430_3 가 끝났을 때 운영자/사용자가 즉각 체감하는 변화:

| 누가 | 어디서 | 무엇을 본다 |
|---|---|---|
| **운영자** | MemoryTab → Stream 탭 | 모든 InteractionEvent 의 timeline. 카운터파트 별 슬라이스. 클릭 시 payload 전체 |
| **운영자** | MemoryTab → LTM Notes 탭 → entities/ 폴더 | 매 새 counterpart 마다 자동으로 stub `<id>.md` 가 떠 있음. distill 호출 후엔 narrative + stats. |
| **운영자** | MemoryTab → 검색 박스 | LTM 결과 + InteractionEvent 결과 양쪽 다 표시. counterpart/kind 드롭다운으로 narrow. |
| **VTuber** | 자기 도구 | cycle 20260430_2 의 progressive ladder 그대로 — *변동 0* (분석 03 의 invariant 4 보존). |
| **사용자** | chat | 변동 0 — VTuber 가 도구로 답변. |

## 10. 본 cycle 의 *명시적 invariants*

직전 cycle 의 4 invariant 를 *모두* 그대로 보존 + 본 cycle 의 1
invariant 추가:

1. **별도 store 0** — STM 그대로
2. **모든 hook 이 metadata 채움** — A1~A6 그대로
3. **모든 도구는 caller 자기 memory 만** — memory_inspect_tools 그대로
4. **prompt-side data inject 0 byte** — sections.py / attach_runtime 변동 0
5. **본 cycle 추가**: *모든 새 endpoint / UI 는 transcripts 를 read 만 함* — write 도구 0. STM 의 진실은 record_message 가 단일 작성처.

## 11. 다음 단계

[`plan/cycle_plan.md`](../plan/cycle_plan.md) 에 PR ladder 와 의존성
그래프를 작성한다. 본 cycle 의 stage:

| Stage | 무엇 |
|---|---|
| A | Backend transcripts API (3 endpoint + tests) |
| B | Entities 자동 bootstrap (record_message hook + tests) |
| C | Frontend transcripts API + types |
| D | Frontend Stream 탭 (UI) |
| E | Search UI 의 InteractionEvent 통합 |
| F | Distill LLM narrative |
| G | Documentation + progress |

각 stage 는 독립 PR. PR 사이즈 큰 단계는 sub-PR 로 나눔.
