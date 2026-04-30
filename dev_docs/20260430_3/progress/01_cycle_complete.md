# Cycle 20260430_3 — Progress / Cycle complete

> Goal recap: cycle 20260430_2 의 InteractionEvent 데이터 모델을 *모든
> surface (운영자 UI / VTuber 자기 도구 / 사용자 channel) 에서 즉시
> 검증할 수 있도록* 5 layer 통합.
>
> 분석 / 철학:
> [`analysis/01_observability_unification.md`](../analysis/01_observability_unification.md).
> Plan: [`plan/cycle_plan.md`](../plan/cycle_plan.md).

## PR ladder

| Stage | PR | What it changed | Tests |
|---|---|---|---|
| docs | [#610](https://github.com/CocoRoF/Geny/pull/610) | analysis 01 + plan | docs only |
| A | [#611](https://github.com/CocoRoF/Geny/pull/611) | `/api/agents/{sid}/transcripts*` 3 endpoint (list / detail / counterparts) + main router 등록 | 17 cases (paging/필터/legacy/wire-shape parity) |
| B | [#612](https://github.com/CocoRoF/Geny/pull/612) | `entities/<sanitized>.md` 자동 bootstrap — record_message hook | 8 cases (skip rules / idempotency / sanitize parity / e2e) |
| C | [#613](https://github.com/CocoRoF/Geny/pull/613) | frontend `transcriptsApi` + 6 InteractionEvent 타입 | (frontend lint/typecheck) |
| D1 | [#614](https://github.com/CocoRoF/Geny/pull/614) | `/transcripts/{event_id}/artifact` endpoint + `transcriptsApi.artifact` | 8 cases (4-fold guardrail + truncate + 422) |
| D2/D3 | [#615](https://github.com/CocoRoF/Geny/pull/615) | MemoryTab "Stream" 서브탭 + `StreamEventModal` (artifact inline read) | manual smoke |
| E | [#616](https://github.com/CocoRoF/Geny/pull/616) | `memory_search` 가 counterpart/kinds 필터 + 결과에 InteractionEvent 라벨 + 클릭 → modal | manual smoke |
| F | [#617](https://github.com/CocoRoF/Geny/pull/617) | `memory_distill(narrative=true)` — memory_model LLM narrative + entity note body 결합 | 5 cases (default off / 호출 / 빈 stream / 실패 swallow / prompt 구조) |

총 9 PR (docs 1 + A~F + progress), 모두 main 머지, 모든 브랜치 정리됨.

## 5 invariants — 모두 보존

| # | Invariant | 검증 |
|---|---|---|
| 1 | 별도 store 0 — STM 그대로 | 새 endpoint 들이 `memory.short_term.load_all()` 만 read. Stream UI / 검색 / distillation 모두 동일 데이터 소스. |
| 2 | 모든 hook metadata 채움 | A2~A6 그대로. 본 cycle 의 entity bootstrap 도 metadata 가 schema 충족할 때만 작동. |
| 3 | caller 의 자기 memory 만 | `transcripts*` endpoint 가 session_id 로 scope. `memory_*` 도구 그대로. cross-session lookup 회귀 잠금 (B3 / D1 의 path traversal / A1 의 wire shape parity). |
| 4 | prompt-side 데이터 inject 0 byte | `sections.py` / `attach_runtime` 변동 0. UI / endpoint 추가는 *환경 (= file system / API)* 변경. memory_distill 의 LLM 호출도 한 번에 한 narrative 만 — 어떤 prompt 를 *우리가 미리 주입* 하지 않음. |
| 5 | **NEW**: 모든 새 surface 는 read-only over transcripts | `transcripts_controller` 의 모든 엔드포인트는 GET 만. record_message 가 단일 작성처. 새 `entity_bootstrap` 모듈은 *file write* 만 — STM 에는 1 byte 도 안 씀. |

## 새로 가능해진 가시성 매트릭스

| 누가 | 어디서 | 무엇을 본다 |
|---|---|---|
| **운영자** | `MemoryTab → Stream` 탭 | 모든 InteractionEvent 의 timeline. counterpart 사이드바, kind multiselect, direction toggle, cursor 페이징 |
| **운영자** | event 카드 클릭 → `StreamEventModal` | full metadata + 카테고리화된 payload (status/tools/files/bash/web/errors/duration/cost) + raw JSON 접힘 + linked parent chain + artifact 본문 inline expand (size cap 시 truncated 배지) |
| **운영자** | `MemoryTab → LTM Notes → entities/` | 매 새 counterpart 마다 자동 stub 등장. `memory_distill(update_note=true)` 후엔 stats; `narrative=true` 이면 stats 위에 LLM 단락. |
| **운영자** | `MemoryTab` 검색 박스 | LTM 노트 + InteractionEvent 한 박스. `stream` 배지 / kind chip / counterpart 표시. counterpart 드롭다운 + kind chips 로 narrow. event 클릭 → modal. |
| **VTuber** | progressive memory 도구 | cycle 20260430_2 그대로 — `memory_status / _with / _event / _artifact / _search / _distill`. 본 cycle 은 도구 표면 변동 0. |
| **사용자** | chat | 변동 0. VTuber 가 도구로 답변. |

## 데이터 흐름 — 한 그림

```
                    InteractionEvent stream (STM)
                              │
                ┌─────────────┼──────────────┬──────────────┐
                │             │              │              │
            record_message  record_message  record_message  record_message
            (사용자 chat)    (DM 수신)       (sub run summary) (reflection)
                │             │              │              │
                ▼             ▼              ▼              ▼
            metadata stamped on every line (cycle 20260430_2 A1~A6)
                │
                ├───── entity_bootstrap (cycle 20260430_3 B)
                │         entities/<sanitized>.md stub
                │
                ▼
        (read surfaces)
                │
                ├─── /api/agents/{sid}/transcripts*           ← 운영자 (cycle 20260430_3 A/D1)
                │       list / detail / counterparts / artifact
                │       (Stream 탭 / 검색 결과 stream 라벨)
                │
                ├─── memory_inspect_tools                     ← VTuber 자기 도구
                │       memory_status / _with / _event /
                │       _artifact / _search / _distill
                │       (cycle 20260430_2 B1~B5 / C)
                │
                └─── memory_distill(narrative=true)           ← 장기 distillation
                        memory_model LLM call
                        entities/<id>.md = narrative + stats
                        (cycle 20260430_3 F)
```

## 회귀 위험 / 다음 cycle 후보

* **`recent_turns` retriever 의 카운터파트별 균형** — sub-worker turn 폭증 시 사용자 발화 밀려나는 케이스. retriever 옵션 추가가 자연스러운 다음 단계 (cycle 20260430_2 의 follow-up 에서 deferral 한 항목).
* **자동 distillation cron** — counterpart 의 누적 event 가 임계치 N 이상이면 백그라운드에서 `memory_distill(narrative=true, update_note=true)` 실행. throttle / retry / 비용 한도 정책 필요.
* **legacy STM jsonl 의 metadata 백필** — 옛 라인은 metadata 없음. retrieval 에서 자동 안 보임. content prefix 분석으로 rough mapping 가능 (cron).
* **DB 인덱싱** — 본 cycle 의 list endpoint 는 jsonl walk. 큰 deployment 에서는 DB 의 metadata 컬럼 인덱싱이 필요할 수 있음.
* **chat panel 의 InteractionEvent 라벨** — 메시지 옆 작은 이벤트 ID/kind 칩. Stream 탭과 별개로, 채팅 흐름 안에서도 즉각 인지 가능. 본 cycle 의 의도적 deferral.
* **Group / room 차원** — counterpart_id namespace 확장 (예: `room:<id>`). 미래.
* **Vector index 의 entities/ 자동 reindex** — structured_writer 의 기존 path 가 처리하지만 명시적 verification 추가가 운영자 신뢰성에 도움.

## 운영 메모

* 본 cycle 의 어떤 변경도 기존 retrieval 회로 (recent_turns / vector / keyword / curated) 를 손상시키지 않음 — 모두 `record_message` 하부의 STM/LTM 위에서 그대로 동작. 검색 필터는 *추가 narrow* 만 함, 기본값에서 결과 셋이 줄어들지 않음.
* `_PLATFORM_TOOL_SOURCES` 변동 없음 (cycle 20260430_2 D 그대로). 새 운영자 endpoint 는 `transcripts_controller.py` — 별 router.
* memory_distill 의 narrative 모드는 *명시적 호출* 만 — 자동 cron 없음. 비용 / 사용자 의도 통제.
* 배포 전 backend 컨테이너 재시작 + frontend rebuild 필요.

## 다음 cycle 준비

본 cycle 이 만든 *완성된 가시성 surface* 위에서 다음 단계 후보:

1. **자동 distillation cron** — 비용 정책과 함께. 가장 자연스러운 follow-up.
2. **`recent_turns` 카운터파트별 균형** — retriever 옵션. 짧은 작업.
3. **chat panel InteractionEvent 라벨** — 사용자 직관 향상.
4. **legacy 백필** — 옛 세션도 Stream 에 표시 가능.

세 후보 모두 본 cycle 의 invariants 를 깨지 않고 add-only 로 들어올 수 있다.
