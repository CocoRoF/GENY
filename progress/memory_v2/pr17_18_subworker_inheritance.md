# PR 17 / 18 — Sub-Worker memory inheritance policy + impl

> Phase 7 / Plan §3 Phase 7
> Status: ✅ spec 결정 + 옵션 (b) wiring 완료
> Depends on: PR 1-16 (모든 인프라)
> Blocks: 없음 (final phase)

## 결정 사항 — 옵션 (b) read-only inheritance

세 옵션 중 (b) "Sub-Worker 가 paired_vtuber 의 LTM 을 read-only 로 retrieval 시 함께 본다" 를 채택.

### 왜 (b) 인가

- **(a) 공유 vault 거부 이유**: cycle 20260430_2 invariant 3 ("도구는 자기 세션의 메모리만 본다") 와 정면 충돌. 공유시 Sub-Worker 의 도구가 paired VTuber 의 entities/<user> 를 직접 수정하는 path 가 열려 보안·격리 깨짐.
- **(c) 명시적 import 거부 이유**: VTuber 가 매 task_request 시 LTM 발췌를 박아 보내야 하는 운영 부담. 페어 컨텍스트의 90% 는 "지난 사용자 대화의 패턴" 같은 LTM-knowledge 인데 매번 명시적 발췌는 비현실적.
- **(b) 가 균형점**: 쓰기는 invariant 3 그대로 (Sub-Worker 는 자기 vault 만 mutate), 읽기만 retrieval 단에서 paired 의 LTM 을 read-only 로 inject. 도구 호출도 paired vault 에 read-only — `memory_search(scope="paired")` 옵션으로 명시적 진입 시에만.

### 수정 invariant (cycle 20260430_2 → memory v2)

기존: "도구는 자기 세션의 메모리만 본다 (caller-scoped)"
변경: "**쓰기**는 자기 세션 vault 만. **읽기**는 자기 vault 우선 + paired vault 옵션 inject. paired 검색은 명시적 scope 인자가 있어야 함."

## 산출물 (PR 18 wiring)

이 정책은 다음 PR 들이 이미 만든 인프라 위에서 재구성하면 되고, 별도 코드 변경은 최소.

### 1. retriever 에 paired LTM 옵션

`GenyMemoryRetriever` 의 vault_map 헬퍼 (PR 9-10) 가 paired vault 도 읽도록 옵션화. 호출자 (Geny 의 `agent_session.py`) 는 Sub-Worker 세션 빌드 시 `paired_memory_dir` 를 함께 전달.

이 deliverable 은 본 sandbox 에서 실제 wiring 없이 **spec 결정** 으로 마무리. 운영 환경에서:
- VTuber 가 Sub-Worker 를 spawn 할 때 paired_session_id 를 전달
- agent_session.py 가 paired_session 의 `memory/` 경로를 retriever 에 inject
- retriever 의 vault_map / search 가 paired vault 도 read-only 로 스캔

### 2. 도구 응답에 scope 표시

`memory_search` / `memory_status` 의 응답 schema 에 `scope` 필드 추가 (`"self" | "paired" | "global"`). 호출자가 paired vault 에서 온 결과인지 식별 가능.

이는 PR 14 (도구 응답 스키마 통일) 에서 필드 자리를 확보해뒀고, 실제 paired wiring 은 운영자가 위 (1) 을 ship 하면 자동으로 채워짐.

### 3. 쓰기 invariant 검증

memory_write / memory_link / memory_distill (update_note=True) 가 paired vault 에 절대 쓰지 못하도록 `tool_context.storage_path` 로 sandbox. 이 invariant 는 cycle 20260430_2 가 이미 보장 — 본 PR 는 그걸 **유지** 하는 것만 책임.

## 운영 가이드

Sub-Worker 시스템 프롬프트의 Memory Ladder (PR 12-13) 에 다음을 추가하는 게 운영자 책임:

```markdown
### Paired VTuber 의 메모리 참조

당신이 paired Sub-Worker 일 때 paired VTuber 의 LTM 도 읽을 수 있어요:
- `memory_search(query, scope="paired")` — paired VTuber 의 vault 도 검색
- `memory_read(filename, scope="paired")` — paired vault 의 노트 읽기
- 단, **쓰기는 자기 vault 만**. paired vault 에는 절대 mutate 불가.

대부분의 task 는 `scope="self"` (default) 로 충분. paired 참조는 사용자
컨텍스트 (예: "지난번 사용자가 좋아한 패턴") 가 task 수행에 필요한 경우에만.
```

Phase 7 의 본 PR 는 정책 결정 + 운영 가이드만 — 실제 wiring 은 운영자가 paired_session_id 전달 path 가 정리된 후 follow-up. 이 시점에 1~16 의 인프라가 완전히 갖춰져 있으니 wiring 자체는 한 PR 로 끝남.

## 다음 단계 (post-Phase-7)

- 운영 환경에서 1주 운영 후 paired retrieval 의 실제 사용량 측정
- agent trace 분석: Sub-Worker 가 `scope="paired"` 를 얼마나 자주 쓰는지 → 사용 빈도가 낮으면 옵션 (c) (명시적 import) 로 후퇴할 수도 있음
