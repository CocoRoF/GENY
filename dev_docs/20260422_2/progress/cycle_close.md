# Cycle 20260422_2 — X6 종료 정리

**Date.** 2026-04-22
**Shipped.** PR-X6-1, PR-X6-2 (2 PR merge — index.md §범위 정책 상
Ship 범위 완결)

## 정착한 것

| PR | 브랜치 | 내용 |
|---|---|---|
| PR-X6-1 | `feat/memory-schema-emotion-fields` | `SessionMemoryEntryModel` 에 `emotion_vec` (TEXT JSON) + `emotion_intensity` (REAL) nullable 컬럼 2개 추가. `service.affect` 패키지 — `encode_emotion_vec` / `decode_emotion_vec` (permissive, never raises). |
| PR-X6-2 | `feat/affect-aware-retriever-mixin` | `AffectAwareRetrieverMixin` at `service.affect.retriever` — opt-in 재랭크 레이어. `cosine_similarity` / `blend_scores` / `rerank_by_affect`. null-safe / dim-mismatch-safe / stdlib only. |

**테스트 성장치:**
- `tests/service/affect/` 0 → 37 tests (encode/decode 11 + retriever 26).
- `tests/service/database/test_session_memory_entry_model.py` +6 tests.
- **총 +43 tests, 회귀 없음.**
- plugin + database + affect 전체 스위프: 79 passed.

## 의도적으로 미이식 (index.md §비범위)

본 사이클은 선언 그대로 **infra-only**. 저장 컬럼과 재랭크 산술까지만
깔고, "실제 데이터 인입" 과 "기존 retriever 에 mixin 배선" 은 분리:

- **Writer 경로.** `AffectTagEmitter` (X3 PR-7) 가 emit 하는 감정
  태그를 `SessionMemoryEntryModel.emotion_vec` 에 실제로 적재하는
  브릿지. 현재는 태그가 creature mood mutation 으로만 흘러가고
  메모리 레코드에는 남지 않음 — X6-follow-up.
- **Concrete retriever 배선.** `SessionMemoryManager.search` /
  `VectorMemoryManager.search` 등 중 어느 것을 먼저 mixin 대상으로
  할지, 그 SELECT 쿼리에 `emotion_vec` 을 포함시키는 작업 —
  X6-follow-up.
- **Vector store metadata 확장.** FAISS `ChunkMeta` 에 감정 차원
  추가 — SQL-only 범위를 넘음. 별도 사이클.
- **PR-X6-3 `tune/prompt-cache-bucketing`** / **PR-X6-4
  `chore/retrieval-cost-dashboard`** — 실사용 데이터 필요. `plan/05
  §6.3` 명시: "실 데이터 없이는 파라미터 튜닝 불가". Defer.

## PR-X6-3 / PR-X6-4 — 데이터 의존 공식 이월

`index.md §범위 정책` 에서 선언한 대로:

> **Defer (데이터 필요)**: PR-X6-3, PR-X6-4.

활성화 트리거:
1. X6-follow-up (writer 경로 + concrete retriever 배선) merge 후.
2. 감정 태그가 실제 메모리 레코드에 적재되기 시작하고, retrieval 이
   mixin 경로로 수 주 운영된 이후.
3. 운영 로그에서 cache miss / retrieval latency / mAP 측정 데이터
   확보.
4. 이 때 PR-X6-3 (bucket 파라미터 fitting) / PR-X6-4 (대시보드
   인프라) 진입.

태스크 트래커상 X6-3 / X6-4 는 *애초에 ticketing 하지 않음* — 조건이
갖춰지면 새 사이클의 PR 로 선언 후 진입.

## 불변식 체크 (plan/05 §8 + index.md §불변식)

X6 PR 을 통해 깨지지 않은 것:

1. **executor 는 게임을 모른다.** → X6 는 Geny 리포만 수정 (affect /
   memory / tests / docs). executor 변경 없음. ✅
2. **Pure additive schema.** → 신규 컬럼 2개 모두 `DEFAULT NULL`.
   기존 INSERT/SELECT 무수정. ✅
3. **Retriever 호환성.** → mixin 은 opt-in. 기존 retriever 어느
   것도 수정되지 않음 — byte-identical 결과. ✅
4. **FAISS vector store 무영향.** → `service/memory/vector_store.py`
   미변경. ✅
5. **Stage 는 Provider 를 직접 잡지 않는다** / **Mutation 4 op** /
   **Decay 는 TickEngine 에만** / **Side-door 재생 금지** /
   **Manifest 전환은 세션 경계** — 본 사이클 관여 지점 없음. N/A. ✅

## 산출물 요약

```
backend/service/affect/__init__.py       # encode / decode helpers
backend/service/affect/retriever.py      # AffectAwareRetrieverMixin
backend/service/database/models/session_memory_entry.py  # +2 nullable cols
backend/tests/service/affect/__init__.py
backend/tests/service/affect/test_affect.py       # 11 tests
backend/tests/service/affect/test_retriever.py    # 26 tests
backend/tests/service/database/__init__.py
backend/tests/service/database/test_session_memory_entry_model.py  # 6 tests
dev_docs/20260422_2/index.md
dev_docs/20260422_2/progress/pr1_memory_schema_emotion_fields.md
dev_docs/20260422_2/progress/pr2_affect_aware_retriever_mixin.md
dev_docs/20260422_2/progress/cycle_close.md       # this
```

## 다음 사이클

plan/05 는 X6 까지 — 본 사이클 Ship 완결로 `dev_docs/20260421_6/plan`
의 청사진 전체 커버리지 달성 (X1 ✅ / X2 ✅ / X3 ✅ / X4 ✅ / X5 ✅
/ X6 ✅, X5-4/5-5 및 X6-3/6-4 는 조건부 defer).

자연스러운 follow-up 후보 (별도 사이클로 진입):

1. **X6-follow-up A — writer bridge.** `AffectTagEmitter` → memory
   record. 이것이 없으면 X6 infra 는 "dead" 상태.
2. **X6-follow-up B — retriever adoption.** 기존 retriever 1~2개를
   `AffectAwareRetrieverMixin` 상속으로 전환 + SELECT 쿼리에
   `emotion_vec` 포함.
3. **(조건부) X6-3 / X6-4 재활성.** A + B 가 merge 되고 수 주
   운영 데이터가 쌓인 뒤 prompt cache bucketing / cost dashboard.
4. **(선택) X5-4 / X5-5.** attach_runtime kwarg 가 *정말로 필요해지는*
   지점이 생길 때. 지금 요구 지점 없음 (shared dict 로 모두 우회
   가능).

본 사이클 종료.
