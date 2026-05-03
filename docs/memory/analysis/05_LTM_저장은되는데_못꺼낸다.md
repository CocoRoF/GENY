# 05 · 저장과 회수의 비대칭

“메모리 시스템이 작동하는가?”에 대한 답은 절반 yes, 절반 no다.

| 단계 | 동작 | 평가 |
|---|---|---|
| 인사이트 추출 (`GenyMemoryStrategy._reflect`) | LLM이 `topics/insights/projects` 중 하나로 분류해 dict 반환 | ✅ 동작 |
| 인사이트 저장 (`StructuredMemoryWriter.write_note`) | `memory/insights/<slug>.md` + frontmatter + 인덱스 업데이트 | ✅ 동작 |
| 큐레이티드 promote (`auto_promote_importance ⊇ {high, critical}` + `curated_km` 존재 시) | `CuratedKnowledgeManager.write_note(...)` | ✅ 동작 (단, curated가 묶여있을 때만) |
| **차기 세션 회수 (`GenyMemoryRetriever.retrieve`)** | 6계층 시도 → **0건** | ❌ 본 사례 |

코드 라인 비교로 보면:

### 저장(write) 경로 — `service/memory/structured_writer.py`
1. 카테고리 화이트리스트 검증 → 디스크 mkdir-p → frontmatter 렌더 → atomic 파일 생성.
2. `_index_manager.update_file()`로 메모리 인덱스 갱신.
3. `_propagate_linked_from()`로 백링크 동기화.
4. (옵션) DB dual-write.

각 단계에 명확한 호출자, 명확한 파일 경로, 명확한 에러 처리. 동작은 안정적이다.

### 회수(retrieve) 경로 — `geny-executor/.../memory/retriever.py`

1. STM tail → 새 세션이면 0.
2. 세션 요약 → 새 세션이면 None.
3. (slim_mode일 때) vault_map → 목차만 반환.
4. MEMORY.md → insights는 자동 합쳐지지 않음.
5. 벡터 검색 → 임베딩 키 + 인덱스 + threshold 충족 시.
6. 키워드 검색 → 어휘 일치 시.
7. 백링크 → 위 결과가 있어야.
8. curated → curated 매니저가 있어야.

저장 경로의 “하나의 입력 → 하나의 결과” 구조와 달리, 회수는 “여러 조건이 동시에 맞아야 한 가지가 잡히는” 깔때기 구조다. **저장이 성공해도 회수가 자동으로 따라오지 않는다.**

## 자동화의 비대칭

저장 측에는 자동화가 잘 되어있다.

- `record_message` → STM JSONL + ConversationArchiver(leaf SoT) + DM/Daily 인덱스
- `record_execution` → dated 파일 + insights write_note + auto_promote
- `_index_manager.rebuild()` → 모든 메타데이터 재구성

회수 측에는 자동화가 거의 없다.

- “인사이트 N개가 저장되었으면 그 중 critical은 다음 system prompt에 자동으로 박는다” — **없음**
- “쿼리에 매칭되지 않더라도, 사용자에 관한 사실은 항상 들어간다” — **없음**
- “세션 시작 시 사용자 카드(이름/호칭/관계 메타)를 자동 합성해서 PersonaBlock에 합친다” — **없음**

## 사용자 시각의 모순

- 메모리 UI(스크린샷)에는 인사이트가 잘 보인다 → “저장은 됐구나” 기대.
- 다음 세션에서 에이전트가 모른다 → “저장한 게 무슨 의미냐” 좌절.

이 모순은 코드의 결함이라기보다 **저장과 회수 사이의 자동화 갭**이다. 사용자가 본 화면(`memory_inspect_tools` 또는 web UI)은 디스크를 직접 본 것이고, 에이전트가 보는 메모리는 검색이 빌드해 준 것이다. 두 뷰가 완전히 다르다.

## 해결 방향(요약)

저장 시점에 **회수 가능성**을 같이 결정해야 한다.

1. 저장 시 importance가 critical/high면 → `critical/` 카테고리에도 동시에 박는다(또는 단일 “pinned facts” 인덱스에 항목 추가).
2. retriever는 매 턴 `critical/` 전체를 char budget의 30% 안에서 무조건 주입한다 — 쿼리 무관.
3. 그 외 카테고리는 기존처럼 검색.
4. promotion(critical 카테고리로의 승격)을 명시적 툴로도 노출(`memory_pin`).

세부는 `plan/재설계계획.md`를 본다.
