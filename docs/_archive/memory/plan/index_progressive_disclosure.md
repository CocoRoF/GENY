# 인덱스 점진적 공개 + daily-journal 폐지 계획

작성일: 2026-05-03
범위: `_index.json` 단일 파일 거대 dump → 루트+카테고리별 계층 인덱스로 전환, `daily-journal` 카테고리 완전 폐지

---

## 0. 한 문장 요약

**`memory/_index.json` 한 파일이 vault 전체를 한 번에 덤프하는 현재 구조를 폐기하고, 루트 인덱스(카테고리 지도) + 카테고리별 인덱스(그 폴더 안 파일 목록)로 분리한다. `daily-journal/`은 같은 PR에서 함께 삭제한다.**

---

## 1. 현 상태 — 왜 이게 점진적 공개가 아닌가

### 1.1 현재 디스크
```
memory/
├── _index.json          ← 모든 파일/태그/링크가 한 파일에 dump (수백 KB까지 성장)
├── _vault_map.json      ← 시스템 프롬프트용 ~500자 요약
├── conversations/<...>
├── critical/<...>
├── daily/<...>
├── daily-journal — 사용자가 "지워버려"라고 명시
├── ...
```

### 1.2 무엇이 잘못됐나
- **"인덱스 하나 = 전체 vault"**. 파일 수가 늘어나면 `_index.json`이 수십~수백 KB 단일 거대 파일로 성장. 한 줄 갱신마다 통째로 다시 씀.
- 에이전트가 "tools 카테고리에 뭐가 있는지" 보려면 전체 인덱스를 받아야 함 → 점진적 공개의 정반대.
- 카테고리별 메타(예: 파일 수, 최근 수정)도 같은 파일에 섞여 있어 *vault 구조*와 *파일 목록*이 분리되지 않음.
- Opsidian/사이드바/검색이 모두 한 파일을 읽음 → 동시 갱신 시 lock 경합 + 부분 손상 위험.
- `daily-journal/<date>.md`는 모든 turn의 헤드라인을 한 파일에 누적해 놓는데, 이는 *시간순 인덱스*라는 가치보다 *중복 데이터*라는 비용이 더 큼 (`conversations/<sid>__*` 파일들이 이미 turn 본문을 갖고 있고, frontmatter의 `date_first/date_last`로 정렬 가능).

---

## 2. 목표 디스크 구조

```
memory/
├── _index.json                       ← 루트 인덱스 (카테고리 지도 + 통계 + 마지막 갱신)
├── _vault_map.json                   ← (현행 유지) 시스템 프롬프트용 짧은 요약
├── conversations/
│   ├── _index.json                   ← 이 폴더 안 파일 목록 + 태그맵 + 최근수정
│   ├── <sid>__user__안녕.md
│   ├── <sid>__reflection.md
│   └── <sid>__dm__<cp>.md
├── critical/
│   ├── _index.json
│   └── <slug>.md
├── daily/
│   ├── _index.json
│   └── execution-N-*.md
├── insights/
│   ├── _index.json
│   └── <slug>.md
├── topics/
│   ├── _index.json
│   └── <slug>.md
├── projects/
│   ├── _index.json
│   └── <slug>.md
├── compactions/
│   ├── _index.json
│   └── <sid>__<ts>.md
├── executions/
│   ├── _index.json
│   └── <YYYY-MM-DD>.md
└── dms/
    ├── _index.json                   ← per-counterpart 폴더들의 *그룹* 메타
    └── <cp_safe>/
        ├── _index.json               ← 이 카운터파트의 일별 인덱스 파일들
        └── <YYYY-MM-DD>.md

# 사라짐
~~memory/<YYYY-MM-DD>.md (daily-journal 본문)~~
~~memory/daily-journal — 카테고리 자체 삭제~~
```

---

## 3. 인덱스 스키마 — 정확한 모양

### 3.1 루트 `memory/_index.json`

```json
{
  "version": "2",
  "categories": {
    "conversations": {
      "file_count": 2,
      "total_chars": 4167,
      "last_modified": "2026-05-03T22:36:50.344+09:00",
      "description": "Per-session, per-counterpart conversation rollups."
    },
    "critical": {
      "file_count": 1,
      "total_chars": 346,
      "last_modified": "2026-05-03T22:19:17.325+09:00",
      "description": "Always-pinned facts; injected every turn."
    },
    "daily": {
      "file_count": 4,
      "total_chars": 2822,
      "last_modified": "2026-05-03T22:36:52.998+09:00",
      "description": "Per-execution result cards."
    },
    "executions": { "file_count": 1, ... },
    "insights": { "file_count": 0, ... },
    "topics": { "file_count": 0, ... },
    "projects": { "file_count": 0, ... },
    "compactions": { "file_count": 0, ... },
    "dms": { "file_count": 0, ... },
    "root": { "file_count": 0, ... }
  },
  "total_files": 8,
  "total_chars": 9247,
  "last_rebuilt": "2026-05-03T22:36:53+09:00"
}
```

특징:
- 카테고리 *지도*만 담음. 개별 파일 메타는 없음.
- 약 1-2 KB로 고정 (vault 크기와 무관).
- 에이전트의 vault_map 렌더가 이 파일만 읽어 카테고리 표를 만듦.

### 3.2 카테고리별 `memory/<category>/_index.json`

```json
{
  "category": "conversations",
  "version": "2",
  "files": {
    "<sid>__user__안녕.md": {
      "filename": "<sid>__user__안녕.md",
      "title": "안녕",
      "tags": ["conversation", "user_chat", "user"],
      "importance": "medium",
      "char_count": 3113,
      "modified": "2026-05-03T22:36:50.344+09:00",
      "summary": "안녕\n\n---\n[curious:0.7] 안녕하세요!...",

      "session_id": "<sid>",
      "turn_count": 6,
      "event_ids": ["7893c828", "962d0e07", ...],
      "kinds": ["user_chat"],
      "counterparts": ["owner:gkfua00"],
      "importance_max": "medium",
      "date_first": "2026-05-03",
      "date_last": "2026-05-03",
      "links_to": []
    },
    "<sid>__reflection.md": { ... }
  },
  "tag_map": {
    "conversation": ["<sid>__user__안녕.md", "<sid>__reflection.md"],
    "user_chat": ["<sid>__user__안녕.md"]
  },
  "last_rebuilt": "2026-05-03T22:36:50+09:00"
}
```

특징:
- **filename은 카테고리 prefix 없음**. 그 폴더 안 상대 경로만 (예: `<sid>__user__안녕.md`). 카테고리 prefix는 폴더 위치로 자명.
- tag_map은 그 폴더 안 파일에만 기반.
- 한 파일이 갱신되면 그 폴더의 `_index.json`만 다시 쓰면 됨 (다른 폴더는 unaffected).

### 3.3 cross-folder 정보 — link_graph

링크는 본질적으로 cross-folder다. 두 가지 옵션:

**A. 루트에 집계**
- `memory/_index.json`에 `link_graph` 필드를 추가
- 모든 cross-folder 링크가 한 곳에 모임

**B. on-demand 계산**
- 각 폴더 인덱스의 `files[].links_to`만 저장
- `linked_from` 역방향 그래프는 필요 시 모든 폴더 인덱스를 합쳐 계산

**추천 A**. `link_graph`도 카테고리 지도 옆에 두면 그래프 뷰(Opsidian)가 한 번만 읽고 끝.

루트 `_index.json` 최종 모양:
```json
{
  "version": "2",
  "categories": { ... },
  "link_graph": {
    "conversations/<sid>__user__안녕.md": ["dms/owner_xxx/2026-05-03"],
    "critical/my-name-is-엘렌.md": []
  },
  "total_files": 8,
  "total_chars": 9247,
  "last_rebuilt": "..."
}
```

---

## 4. 메모리 매니저 측 코드 변화

### 4.1 `MemoryIndexManager` 재구성

현재:
- `MemoryIndex` (in-memory dataclass)
- `_index_path = memory/_index.json`
- `_save_to_disk()` → `_index.json` 통째로 dump
- `_load_from_disk()` → 단일 파일 read

새:
- `MemoryIndex` 인메모리 모델은 그대로 (전체 view 유지). 단지 영속화 분리.
- `_save_to_disk()` 분해:
  - 루트 `memory/_index.json`: 카테고리 지도 + link_graph + 통계
  - 각 `memory/<category>/_index.json`: 그 폴더 파일들의 entries + tag_map
- `_load_from_disk()`:
  - 루트 read → 어떤 카테고리가 있는지 파악
  - 각 카테고리 폴더 walk → entries 모음
  - 인메모리 `MemoryIndex` 재구성 (기존 코드 호환)
- `update_file(rel_path)`:
  - 그 파일의 카테고리 식별
  - 해당 폴더 `_index.json`만 부분 갱신
  - 루트 `_index.json`의 카테고리 카운트/last_modified만 갱신
  - 다른 폴더 파일은 손도 안 댐

### 4.2 외부 API (호환성)

기존 코드 사용처(`mgr.get_memory_index()`, `idx.files`, `idx.tag_map`, `idx.link_graph`)가 많다. 인메모리 `MemoryIndex` 모양은 *유지*. 외부 API는 변경 없음. **변경은 디스크 영속화 형태에 한정**.

이렇게 하면:
- `memory_controller.py`의 `get_memory_index` 엔드포인트, Opsidian 사이드바, `memory_inspect_tools` 모두 *수정 불필요*.
- 단지 디스크에 저장될 때만 분리됨.

---

## 5. daily-journal 폐지 — 정확히 무엇을 지우는가

### 5.1 삭제 대상
- `backend/service/memory/daily_journal_writer.py` 전체
- `backend/service/memory/manager.py`:
  - `from service.memory.daily_journal_writer import DailyJournalWriter` import
  - `self._daily_journal` 필드와 `_DailyJournalWriter` 빌더
  - `initialize()`의 `self._daily_journal = ...` 라인
  - `_maybe_append_daily_journal()` 메서드 + `record_message()`의 호출
  - `set_database()`의 `_daily_journal`까지 propagate하는 분기
- `backend/service/memory/conversation_archiver.py`:
  - `build_links_to()`의 `out: List[str] = [date]` 라인 (daily-journal 위키링크 타깃 제거).
  - 결과: `links_to`는 DM 류만 `["dms/<cp>/<date>"]`, 그 외는 `[]`.
- `backend/service/memory/structured_writer.py`:
  - `VALID_CATEGORIES`에서 `"daily-journal"` 제거 (있으면).
- `frontend/src/lib/memoryCategories.ts`:
  - `MEMORY_CATEGORIES`/`CATEGORY_ICONS`/`CATEGORY_COLORS`/`CATEGORY_FALLBACK_LABELS`에서 `'daily-journal'` 제거.
- 테스트:
  - `tests/service/memory/test_daily_journal*.py` — 있으면 모두 삭제
  - 다른 테스트의 `daily-journal` 참조 정리

### 5.2 conversations 파일의 `links_to`는 어떻게 되나
PR 13/14에서 `links_to`는 frontmatter에 union으로 누적되는데, daily-journal 타깃이 빠지면:
- DM 류: `["dms/<cp>/<date>"]` (1개)
- 그 외: `[]` (빈 리스트)

이는 의도된 결과. conversations 파일은 자기 안에 모든 turn이 다 들어있으니, 외부로 나가는 위키링크는 카운터파트 인덱스(dms/) 정도면 충분.

### 5.3 기존 디스크에 남아있는 `<YYYY-MM-DD>.md`는?
사용자가 이전에 “기존 데이터 다 삭제하고 새로 시작”이라 했으니 마이그레이션 없음. 다만 남아있으면 사이드바에서 root 카테고리로 surface될 텐데, deploy 전 vault 정리하면 끝.

---

## 6. 에이전트의 점진적 공개 흐름

### 6.1 시스템 프롬프트 (Tier 1 — 항상 주입)
`render_vault_map()`이 루트 `_index.json`만 읽어 ~500자 마크다운 렌더:

```
## Vault Map
- conversations (2 files, 4.2K chars) — Per-session, per-counterpart conversation rollups
- critical (1 file, 0.3K chars) — Always-pinned facts
- daily (4 files, 2.8K chars) — Per-execution result cards
- executions (1 file, 0.5K chars) — Execution-summary append stream
- insights (0 files) — LLM-distilled facts
- topics (0 files) — Curated subject pages
- projects (0 files) — Curated initiative pages
- compactions (0 files) — Compaction artifacts
- dms (0 counterparts) — Per-counterpart conversation indexes

Use `memory_list(category)` to see files in a folder; `memory_read(filename)` for full content.
```

### 6.2 에이전트 도구 호출 (Tier 2 — 폴더 진입)
`memory_list(category="conversations")`:
- 백엔드가 `memory/conversations/_index.json`만 읽어 응답
- 응답: `[{filename, title, summary, turn_count, kinds, counterparts, modified}, ...]`
- 페이로드는 보통 1-10 KB

### 6.3 에이전트 도구 호출 (Tier 3 — 본문 진입)
`memory_read(filename="conversations/<sid>__user__안녕.md")`:
- 그 파일 본문 전체

이 세 단계가 점진적 공개의 정의.

---

## 7. PR 분할

### PR-1: daily-journal 폐지 (작은 변경, 위험도 낮음)
- 파일: 7개 정도 수정 + 1개 삭제 + 테스트 일부 정리
- 영향: 사이드바에서 daily-journal 폴더 사라짐, conversations frontmatter `links_to`가 짧아짐
- 머지 후 즉시 동작

### PR-2: 계층 인덱스 (중간 위험도, 신중)
- 핵심: `MemoryIndexManager`의 `_save_to_disk` / `_load_from_disk` / `update_file` 재구현
- 외부 API는 무손실 — `mgr.get_memory_index()`가 같은 shape 반환
- 테스트:
  - 새 폴더별 `_index.json` 쓰기/읽기 단위 테스트
  - 기존 `test_index*` 테스트는 외부 API 의존이라 통과해야 함
- 머지 후 자동 — 다음 rebuild 시 새 형태로 디스크 갱신
- 옵션: 기존 monolithic `_index.json`이 있으면 부팅 시 한 번 읽고 split, 없으면 fresh

### PR-3 (선택): vault_map / 도구 surface 개선
- `render_vault_map`이 루트 `_index.json`만 읽도록 최적화 (성능 개선)
- `memory_list_categories` 도구 신규 (Tier 1을 도구 호출로도 노출)
- 우선순위 낮음 — Tier 1은 이미 system prompt에 들어가므로 도구가 굳이 필요 없을 수 있음

---

## 8. 호환성 / 안전망

### 8.1 외부 코드 변경 최소화
인메모리 `MemoryIndex` 인터페이스는 그대로. `memory_controller.py`, Opsidian frontend, `memory_inspect_tools.py` 모두 수정 불필요.

### 8.2 부팅 시
- 루트 `_index.json` 없음 + 폴더 인덱스 없음 → 기존처럼 풀 스캔 → 새 형태로 저장
- 루트 `_index.json` 있음(레거시 monolithic) → 한 번 읽고 split해서 새 형태로 저장
- 폴더 인덱스만 있고 루트 없음 → 폴더 인덱스 합쳐서 루트 생성

### 8.3 동시 갱신
- 한 turn 갱신 → 그 카테고리 폴더 인덱스 + 루트 인덱스만 touch
- 다른 폴더는 무영향
- 이전: 매 갱신마다 거대 단일 파일 다시 쓰기 → race-friendly
- 이후: 폴더별 lock으로 분산 → race 위험 감소

---

## 9. 결정 필요 항목

진행 전 확정 필요:

| # | 항목 | 추천 |
|---|---|---|
| 1 | PR-1과 PR-2를 한 번에 (1 PR), 분리해서 (2 PR), 또는 PR-2만? | **분리 (2 PR)** — daily-journal 폐지부터 작은 PR로 |
| 2 | `link_graph` 위치 — 루트(A) vs on-demand(B)? | **A (루트 집계)** — Opsidian 그래프 뷰 1회 read로 끝 |
| 3 | 레거시 monolithic `_index.json` 자동 split 필요? | **자동 split** (idempotent. 기존 데이터 살아있는 환경 대비) |
| 4 | Tier 1 vault_map에 카테고리 description 포함? | **포함** (각 카테고리 1줄 설명, 에이전트가 어떤 도구를 부를지 결정에 도움) |
| 5 | PR-3(도구 surface 개선) 지금 진행? | **다음 사이클** — 본 두 PR이 충분히 안정된 뒤 |

---

## 10. 작업 순서 (확정 후)

1. PR-1 브랜치: `delete-daily-journal`
   - 파일 삭제 + 참조 제거 + 테스트 정리
   - smoke: 한 turn 만들고 `_index.json`에 daily-journal이 안 보이는지 확인
   - PR + merge
2. PR-2 브랜치: `hierarchical-index`
   - `MemoryIndexManager._save_to_disk` 분해 + `_load_from_disk` 보강
   - 부팅 시 자동 split
   - 단위 테스트 + smoke
   - PR + merge

각 PR은 독립적으로 안전하게 머지 가능.

---

## 결정 부탁드립니다

위 9번 결정 항목 5개 중 답 주시면 그대로 진행합니다. 추천대로 가도 OK라면 “추천대로” 한 단어면 됩니다.
