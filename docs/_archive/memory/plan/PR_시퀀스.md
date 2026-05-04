# PR 시퀀스 — 작은 단위로 끊은 변경 순서

원칙: 한 PR = 한 가지 의도. 평균 LOC 200 이하. 각 PR은 독립 머지 가능.
의존 관계는 표 마지막 컬럼에 명시.

| # | 제목 | 레포 | 주요 파일 | LOC 추정 | 닫는 결함 | 의존 |
|---|---|---|---|---|---|---|
| 1 | T1: `memory/critical/` 카테고리 화이트리스트 추가 | Geny | `service/memory/structured_writer.py` | <30 | F1 일부 | — |
| 2 | T1: `LongTermMemory.load_critical_pinned()` 추가 | Geny | `service/memory/long_term.py` | ~80 | F1, F2 | 1 |
| 3 | T1: `GenyMemoryRetriever`에 critical 레이어 추가 | executor | `memory/retriever.py` | ~60 | F1, F4 | 2 |
| 4 | T1: `MemoryContextBlock`이 `Pinned Facts` 분리 출력 | executor | `stages/s03_system/.../builders.py` + `s02_context/.../stage.py` | ~50 | F1 | 3 |
| 5 | T2: importance=critical/high 인사이트 자동 critical 복제 | executor | `memory/strategy.py:_save_insights` | ~40 | F11, F12 | 1 |
| 6 | 툴: `memory_pin` 추가 | Geny | `tools/built_in/memory_tools.py` | ~80 | F11 | 1 |
| 7 | T3: vault_map_lite 항상 주입 (slim_mode 무관) | executor | `memory/retriever.py` | ~30 | F10 | 3 |
| 8 | 검색: 키워드 normalize(NFC + Korean substring) | Geny | `service/memory/long_term.py` | ~60 | F5 | — |
| 9 | 검색: `manager.search()` vector fallback 합성 | Geny | `service/memory/manager.py` | ~80 | F6 | — |
| 10 | retriever L4: 카테고리 부스트(insights/projects ×1.2) | executor | `memory/retriever.py` | ~20 | F4 | — |
| 11 | 페르소나: 워커/VTuber 기본 프롬프트에 메모리 사용 강령 | executor | `memory/presets.py` | ~30 | F9 | 4 |
| 12 | 관측: retriever breakdown 이벤트 + 0건 이벤트 | executor | `memory/retriever.py` + `s02_context/.../stage.py` | ~40 | F15 | — |
| 13 | 백필 스크립트: 기존 critical/high 인사이트 → critical/ 복사 | Geny | `scripts/migrate_pin_critical.py` | ~120 | 마이그레이션 | 1, 5 |
| 14 | (별 트랙) 이전 감사 GP1 픽스 | Geny | `service/memory_provider/registry.py` | <50 | F14 | — |

## 머지 순서 권고

```
14 (GP1, 독립)      ──── 별 PR로 즉시
        │
        └─ 영향 없음

1 ─→ 2 ─→ 3 ─→ 4 ─→ 11 (T1 끝)
                ↘
                  7  (vault_map_lite, T3)
1 ─→ 5
1 ─→ 6
8, 9, 10, 12 (검색/관측, 독립)

13 (마이그레이션, 1+5 머지 후)
```

PR 1~6이 머지되면 **본 사례(주인님)는 재발하지 않는다.**
PR 7~12는 회수율을 끌어올려 “critical까지 가지 않더라도 일반 사실들도 더 잘 회수되도록” 만든다.

## 각 PR의 검증 절차

### PR 1
- 단위 테스트: `write_note(category="critical")` 성공.
- 기존 테스트 카테고리 검증 회귀 없음.

### PR 2
- 단위 테스트: critical 디렉토리에 .md 2개 두고 `load_critical_pinned()` 호출 시 본문 합쳐 반환, char cap 동작.
- 빈 디렉토리 → None.

### PR 3
- 단위 테스트: stub manager(`load_critical_pinned`)에 None / 짧은 / 긴 응답을 주고 chunks에 0/1/1+잘림 적절.
- 통합: 새 세션 + 임의 한국어 질의 → critical 청크가 chunks[0]에 등장.

### PR 4
- 단위 테스트: `state.metadata["memory_pinned"]`만 있어도 system prompt에 “Pinned Facts” 섹션 출력.
- 둘 다 있으면 두 섹션 동시 출력.

### PR 5
- 단위 테스트: `_save_insights({"importance": "critical", ...})` 호출 후 `memory/critical/<slug>.md` 존재.
- importance=medium → critical 디렉토리 변화 없음.

### PR 6
- 단위 테스트: tool 호출로 `memory/critical/<slug>.md` 생성 + 적절한 frontmatter.
- 다음 턴 retriever가 즉시 주입.

### PR 7
- 단위 테스트: slim_mode 끔 / 켬 둘 다에서 vault_map_lite chunk가 chunks에 포함.
- char 상한 500 준수.

### PR 8
- 단위 테스트: query=“주인님”, 본문에 “주인님”만 있는 노트 → 매칭. NFC 차이로 인한 매칭 실패 회귀 검증.

### PR 9
- 단위 테스트: vector mock 결과 + 키워드 결과를 합쳐 score 정렬.
- vmm.enabled=False 시 기존 동작 유지.

### PR 10
- 단위 테스트: 같은 키워드 매칭 결과에서 insights 카테고리 스코어가 1.2배.

### PR 11
- 회귀 테스트: 워커 / vtuber preset 통과.
- LLM 응답 시뮬레이션: “Pinned Facts”에 “호칭=주인님” 있으면 첫 응답에서 “주인님”으로 시작하는지 (manual smoke).

### PR 12
- 단위 테스트: retrieve 0건 시 이벤트 emit, breakdown에 layer별 카운트.

### PR 13
- 멱등성: 두 번 실행해도 디렉토리 상태 동일.
- 기존 critical/ 사용자 정의 항목 손상 없음.

### PR 14
- 별도 PR. provision()이 import + 호출 가능하고 describe() 결과가 dict로 떨어지는지.

## 운영 토글

후속 안전망으로 다음 환경 변수를 추가한다.

| ENV | 효과 | 기본 |
|---|---|---|
| `MEMORY_PIN_BUDGET_RATIO` | T1이 차지할 budget 비율(0.0–0.7) | `0.30` |
| `MEMORY_AUTO_PIN_IMPORTANCE` | 자동 pin할 최소 importance | `high` |
| `MEMORY_VAULT_MAP_ALWAYS` | vault_map_lite 매 턴 주입 활성화 | `true` |
| `MEMORY_RETRIEVE_TRACE` | breakdown 이벤트 emit | `true` |

운영자가 PR 11~12 이후 메모리 사용 패턴을 측정하고 budget 비율 등을 조정할 수 있게 한다.

## 후속 검토 항목

1. T1 demotion(오래된 pinned 자동 강등) — pinned가 무한 증가하지 않게.
2. v0.20.0 Provider Protocol에 `pinned()` 핸들 추가 — provider-level 일관 인터페이스.
3. 사용자별 별도 critical/ — 다중 사용자 때 user_id로 구획.
4. UI에서 critical 디렉토리 직접 편집(웹).
5. critical 디렉토리 conflict 처리 — 동일 슬러그 중복 시 머지 정책.
