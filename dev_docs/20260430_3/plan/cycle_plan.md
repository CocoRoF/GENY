# Cycle 20260430_3 — Plan

> Goal: cycle 20260430_2 의 InteractionEvent 데이터 모델 위에 *모든
> surface 의 가시성 통합* 을 얹는다 — backend API / 자동 entities
> bootstrap / frontend Stream 탭 / 검색 UI 통합 / LLM-driven
> distillation 까지.
>
> 분석 / 철학:
> [`analysis/01_observability_unification.md`](../analysis/01_observability_unification.md).

본 cycle 의 5 invariants:

1. 별도 store 0 (STM 그대로)
2. 모든 hook 이 metadata 채움
3. 모든 도구는 caller 자기 memory 만
4. prompt-side 데이터 inject 0 byte
5. **새**: 모든 새 endpoint / UI 는 transcripts 를 *read 만*

각 단계는 독립 PR.

---

## Stage A — Backend transcripts API

### A1 — `GET /api/agents/{sid}/transcripts` (list)

* `controller/transcripts_controller.py` 신규
* Query params: `limit` (default 50, max 200), `cursor`, `counterpart`,
  `kinds` (csv), `direction` (`in`|`out`|`internal`), `since`
* 응답: `{ events: [...], next_cursor, has_more, total_estimate }`
* Event 직렬화는 cycle 20260430_2 의 `_summarise_event` 를 재사용 (도구
  공유 — 같은 schema 가 backend / LLM 양쪽에서 떠야 운영자 = LLM
  의 view 가 일치).
* 페이징: STM 의 chronological order 위에서 cursor = 마지막으로 본
  event_id. cursor 도달 후 그 다음 page 부터 읽음.
* 권한: agent_session 존재 검증. ACL 별도 X.

**테스트**: 신규 `tests/controller/test_transcripts_controller.py`
* 빈 STM → events=[]
* 5 event 시드 → newest-first
* limit clamp / cursor 페이징
* counterpart 필터
* kinds 필터 (csv)
* direction 필터
* since (event_id) cutoff
* unknown session → 404
* legacy 라인 (event_id 없음) → skip

### A2 — `GET /api/agents/{sid}/transcripts/{event_id}` (detail)

* 동일 controller. event 단일 lookup (`memory_event` 의 운영자 view)
* 응답: `{ event: {...full}, linked: { parent: {...summary} } }`
* 미존재 → 404

**테스트**: 신규 add to test_transcripts_controller.py
* 정상 detail
* parent 매칭
* 미존재 → 404

### A3 — `GET /api/agents/{sid}/transcripts/counterparts` (summary)

* 카운터파트별 카드 응답:
  ```json
  {
    "counterparts": [
      {"id": "sub-1", "role": "paired_subworker", "events": 12, "last_ts": "..."},
      {"id": "owner:alice", "role": "user", "events": 24, "last_ts": "..."},
      {"id": "self", "role": "self", "events": 4, "last_ts": "..."}
    ]
  }
  ```
* 단일 STM walk — O(N) 한 번만.

**테스트**:
* 빈 STM → []
* 여러 카운터파트 시드 → 카운트 정확
* legacy 라인 (event_id 없음) → 카운트에서 제외

### A4 — Router 등록

* `main.py` 의 `app.include_router(transcripts_router)` 추가
* Prefix `/api/agents`

---

## Stage B — Entities 자동 bootstrap

### B1 — `_bootstrap_entity_for_counterpart` helper

* `service/memory/interaction_event.py` 또는 신규 `service/memory/entity_bootstrap.py`:
  ```python
  def bootstrap_entity_stub(
      memory_manager, *, counterpart_id, counterpart_role,
  ) -> Optional[str]:
      """Create entities/<sanitized>.md if missing. Idempotent."""
  ```
* sanitize: cycle 20260430_2 C 의 `_sanitize_counterpart_for_filename` 재사용 (또는 같은 위치로 옮김).
* skip 규칙:
  * counterpart_id ∈ {"self", "system"} → skip
  * structured_writer is None → skip
  * file 이미 존재 → skip
* stub body: 짧은 자리만 차지. distill 호출 후 풍성한 내용으로 갱신.

### B2 — `record_message` hook

* `SessionMemoryManager.record_message` 의 metadata 가 schema 충족시
  bootstrap_entity_stub 호출 (best-effort, swallow exceptions).
* 호출은 record 직후 / DB write 직후. 한 turn 의 critical path 영향 ≤ 1ms (file stat + 옵셔널 write).

### B3 — Tests

* helper unit tests: skip 규칙 / sanitize / stub body / structured_writer 없음 silent
* record_message 통합 — fake structured_writer + InteractionEvent metadata → bootstrap 호출됨

---

## Stage C — Frontend transcripts API + types

### C1 — `lib/api.ts` `transcriptsApi`

* `list(sessionId, params?)` → list response
* `get(sessionId, eventId)` → detail
* `counterparts(sessionId)` → counterpart summary

### C2 — `types/index.ts` (또는 적절 위치) 의 InteractionEvent 타입

* `InteractionEvent`, `InteractionEventDetail`, `CounterpartSummary`,
  `TranscriptListResponse` 등.

---

## Stage D — Frontend Stream 탭

### D1 — MemoryTab 의 *내부 sub-tab 시스템* 추가

* 기존 Session/Global 토글은 그대로
* 새 sub-tab: "LTM Notes" (지금 화면) | "Stream" | (검색 결과는 sub-tab 가로지름)

### D2 — Stream 탭 컴포넌트

* `components/tabs/memory/StreamTab.tsx` 신규
* 좌측: counterpart 카드 사이드바 (counterparts endpoint fetch)
* 우측: timeline (transcripts list endpoint 페이징)
* 필터 chips: kind multiselect / direction toggle
* 카드 클릭 → event detail modal

### D3 — Event detail modal

* `components/tabs/memory/StreamEventModal.tsx`
* full metadata + payload (JSON pretty)
* `payload.raw_tool_calls` 접힌 상태 디폴트
* `payload.files_written` path 클릭 → memory_artifact endpoint 호출 결과 inline expand
* `linked_event_id` 클릭 → parent modal (chain)

### D4 — Tests

* 프론트엔드 unit test 인프라가 본 repo 에 별로 없음 — *manual smoke* 만 가능. lint / typecheck 만 PR 검증.

---

## Stage E — Search UI 통합

### E1 — MemorySearchResults 강화

* result entry 가 event_id 가지면 라벨 (`kind` chip / `counterpart` chip / `direction`) 추가
* 클릭 → Stream 탭의 Event detail modal

### E2 — 검색 form 의 새 필터

* counterpart 드롭다운 (counterparts endpoint fetch)
* kind multiselect (chips)
* `memoryApi.search` 가 `counterpart` / `kinds` 인자 받아 백엔드로 전달 (cycle 20260430_2 B5 의 확장 활용)

---

## Stage F — Distill LLM narrative

### F1 — `memory_distill` 의 `narrative` 옵션

* 신규 인자 `narrative: bool = False`
* True 시:
  * `_summarise_counterpart_events` 결과 + 최근 N events 의 content 텍스트 → LLM prompt
  * 호출: `APIConfig.memory_model` 의 client (agent_session 가 만들어둔 것 재사용)
  * 결과 narrative 를 entities 노트의 body 맨 위에 stats 와 결합
* fallback: LLM 실패 → stats only

### F2 — LLM client wiring

* `memory_distill` 가 caller agent 의 `_pipeline` 의 memory model client 를 hook 가능한 형태로 노출. 또는 `service/llm/...` 에 별도 helper.
* 가장 깔끔한 path 검토 후 결정.

### F3 — Tests

* narrative=False (default) → cycle 20260430_2 와 동일 동작
* narrative=True + LLM 모킹 → 결합 body
* LLM 실패 → stats only fallback 확인

---

## Stage G — Documentation + progress

* `progress/01_cycle_complete.md` — PR ladder + invariants 검증 + 새로 가능해진 가시성 매트릭스 + 다음 cycle 후보

---

## 의존성 / PR 순서

```
Stage A (transcripts endpoints)
  A1 list → A2 detail → A3 counterparts → A4 router register
                                                │
                                                ▼
Stage B (entities bootstrap)
  B1 helper → B2 record_message hook → B3 tests
                                                │
                                                ▼
Stage C (frontend API)
  C1 api.ts → C2 types
                                                │
                                                ▼
Stage D (Stream UI)
  D1 sub-tab → D2 Stream 컴포넌트 → D3 event modal
                                                │
                                                ▼
Stage E (search 통합)
  E1 results 강화 → E2 form 필터
                                                │
                                                ▼
Stage F (LLM distill)
  F1 narrative 옵션 → F2 client wiring → F3 tests
                                                │
                                                ▼
Stage G (progress)
```

각 stage 는 *독립 PR*. PR 사이즈를 작게 유지하기 위해 stage 안의
sub-step 을 별 PR 로 분리 (e.g. A1, A2, A3 각자).

본 cycle 은 frontend + backend 양쪽 변경이 큰 만큼, 시각적 동작은
*수동 smoke* 로 검증해야 함 (개발 머신에 frontend dev 서버 띄우기).
PR 본문에 **"manual smoke"** 가 필요한 항목을 명시.

---

## Non-goals (이 cycle 에서 안 한다)

* 자동 distillation cron — 사용자 명시 호출만
* legacy STM jsonl 의 metadata 백필 — forward only
* DB 인덱싱 — 본 cycle 의 list endpoint 는 jsonl 위에서 동작 (DB
  write-through 는 그대로 유지)
* Vector index 의 entities/ 파일 자동 reindex — structured_writer 의 기존 path 가 처리
* prompt-side 데이터 inject — *영구 폐기*
* chat panel 자체의 InteractionEvent 라벨 (메시지 옆에 작은 표시 등) — 가능하지만 본 cycle 외; Stream 탭으로 통합 가시성 우선
