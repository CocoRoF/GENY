# Conversations 저장 구조 — 현재 상태와 개선안

작성일: 2026-05-03 (v2 재작성)
근거: 사용자가 공유한 `_index.json` 실데이터 + 코드 라인 추적

---

## 0. 한 문장 요약

지금 `conversations/<sid>__<title>.md` 한 파일에 **사용자 채팅 + 어시스턴트 응답 + 자기-반사(reflection)** 가 전부 섞여 들어가고, 게다가 `<sid>`가 `unknown`으로 깨져 있다. 이건 사용자 의도(“누구와 대화했냐로 분리”)와 정면 충돌하므로 다음 PR에서 **kind별/카운터파트별 별도 파일로 split** 한다.

---

## 1. 사용자가 공유한 `_index.json` 실데이터에서 확정된 사실

### 1.1 한 세션이 만든 파일 4개

```
conversations/unknown__안녕.md             1910 chars   (롤업 — 사용자 + 반사 섞임)
2026-05-03.md                              1232 chars   (일별 인덱스)
daily/execution-1-안녕.md                   485 chars   (실행 카드 1)
daily/execution-2-thinking-…autonomous-…    750 chars   (실행 카드 2 — 반사 트리거)
```

### 1.2 `conversations/unknown__안녕.md` 안에 들어간 turn

`links_to`가 그 파일의 daily-journal 측 인덱스에서 보여준다:

```
turn-81049cc2   user_chat in   user → 사용자 메시지 "안녕"
turn-d686e98f   user_chat out  agent → "[calm:0.7] 안녕하세요!…"
turn-a453b865   reflection internal self  → "[THINKING_TRIGGER:time_evening] …"
turn-9b99559c   ?                          (네 번째 turn — 두 번째 reflection 추정)
```

태그도 그것을 그대로 반영:
```
"tags": ["conversation", "user_chat", "user", "reflection", "self"]
```

→ **사용자 채팅과 자기-반사가 한 파일에 같이 누적**.

### 1.3 `conversations/unknown__안녕.md`의 `_index.json` 항목이 비어 있음

```json
"event_id": "",
"kind": "",
"direction": "",
"counterpart": "",
"counterpart_role": "",
"linked_event_id": ""
```

이건 다음 두 가지가 합쳐진 결과:
- 세션 롤업 frontmatter는 키가 *세션 레벨* (`event_ids: [...]`, `kinds: [...]`, `counterparts: [...]`) 라서 per-turn 키가 없음.
- `index.py:355-359`는 여전히 per-turn 키 (`event_id`, `kind`, …)를 읽고 있어 항상 빈 문자열을 받는다.

세션 레벨 집계는 frontmatter엔 있지만 인덱스가 그걸 surface 안 한다.

### 1.4 `summary: "<!--meta\nevent_id: …"`

`index.py:325`:
```python
body_text = re.sub(r"^#+\s+.*$", "", body, flags=re.MULTILINE).strip()
summary = body_text[:200].strip()
```

마크다운 헤딩(`#`)만 strip하고 HTML 주석 블록은 그대로 둔다. 결과적으로 롤업 파일의 첫 200자는 `<!--meta event_id: …` 가 되어 사이드바/검색에 노이즈로 surface.

### 1.5 `unknown__` 파일명

`SessionMemoryManager.__init__`이 session_id를 받지 않음 (`manager.py:75` 부근). 흐름:

```
agent_session.py:923   SessionMemoryManager(sp)             # session_id 안 넘김
agent_session.py:924   mgr.initialize()                     # _session_id 는 아직 None
manager.py:179         ConversationArchiver(...,
                         session_id=self._session_id or "") # → ""
conversation_archiver  _slug_for_session_id("")             # → "unknown"
```

`set_database(db, session_id)` 가 나중에 `_session_id`를 채우지만, archiver는 이미 빈 값으로 묶여있고 다시 바인딩되지 않는다. DB 미사용 모드에서는 `set_database`가 아예 안 불려 영원히 `unknown__`.

### 1.6 daily-journal 파일이 한 파일이지만 두 종류 콘텐츠 누적

```
2026-05-03.md   links_to: [→ conversations/unknown__안녕#turn-81049cc2, …]   # DailyJournal 부분
                summary  : "> 안녕\n[[…|→ 본문]]\n…\n_(21:31 KST)_\n"         # 끝부분에 (21:31 KST) → write_dated 블록 시작
```

DailyJournalWriter가 frontmatter+헤드라인을 관리하고, `LongTermMemory.write_dated`가 같은 파일에 `_(...)\n\n[✅] Execution #1 — …` 블록을 단순 append한다. 같은 lock을 쓰지 않으므로 race-friendly. 리포트 v1의 지적이 정확.

---

## 2. 사용자 의도 ↔ 현재 구조 미스매치

> 사용자: “conversation 폴더에 저장되는 원천 데이터는 누구와 대화를 하였는지에 따라서 다르게 저장되는 것이 맞다고 생각해. 사용자와의 대화인지, 다른 agent와의 dm 메세지인지에 따라서.”

현재 코드: **kind/counterpart 무관, 세션당 1파일**. 그래서 user_chat + reflection이 같은 파일에 섞이고, 향후 sub-worker DM도 같이 들어간다. 사용자 의도와 정면 충돌.

---

## 3. SoT/인덱스/카드 구분 (말 정리)

이전 리포트의 "1급 시민" 표현은 빼고, 명확하게 다시 씀.

| 카테고리 | 이름 | 무엇을 담나 | 누가 읽나 |
|---|---|---|---|
| **A. raw 로그** | `transcripts/session.jsonl` | 모든 turn의 머신-친화적 JSON 한 줄 | StreamTab UI, retriever L0(recent_turns) |
| **B. 사람-친화적 본문** | `memory/conversations/...md` | turn body 그대로 + 메타 (현재 1세션=1파일, 개선안: 1 카운터파트=1파일) | Opsidian 사이드바, 사용자 검토, 위키링크 점프 |
| **C. 시간 인덱스** | `memory/<YYYY-MM-DD>.md` (DailyJournal 부분) | 일별 헤드라인+위키링크 | Opsidian, 일별 회고 |
| **D. 카운터파트 인덱스** | `memory/dms/<cp>/<date>.md` | 카운터파트×일별 헤드라인 | Opsidian, “이 사람과 무슨 얘기” 회상 |
| **E. 실행 카드** | `memory/daily/Execution #N — *.md` | execution 사이클 1개 카드 | 검색용 |
| **F. 누적 텍스트** | `memory/<YYYY-MM-DD>.md` (write_dated 부분) | execution 한 줄 요약이 단순 append | retriever L4 키워드 검색 |
| **G. 항상 주입** | `MEMORY.md`, `memory/critical/*.md` | 매 턴 system prompt에 박힘 | 모든 LLM 호출 |
| **H. 검색 시 주입** | `memory/insights/`, `topics/`, `projects/` | LLM-distilled / 큐레이티드 사실 | retriever L3-L4 |

retriever가 매 턴 보는 것 (`GenyMemoryRetriever.retrieve`):
- A의 끝부분 (recent_turns 6개)
- G 전체 (캡 budget×0.3)
- B/C/D/E/F/H는 *검색이 잡으면* surface; 못 잡으면 안 보임

사용자가 conversations/<sid>를 사람-검토용으로 수정해도 다음 턴 LLM은 그 본문을 *직접 통째로* 받지 않는다(L4 키워드 검색이 잡거나, 위키링크가 가리킬 뿐). 이게 v1 리포트가 "1급 시민" 운운한 부분의 원래 뜻 — 표현이 모호했음. 정확히는: **B(사람용 conversations 본문)를 retriever 어느 계층도 *항상* 읽지는 않는다.** STM tail (A)이 가까운 대용이지만 A는 jsonl이지 사람 편집물이 아니다.

---

## 4. 문제 4가지 — 정확한 라인 인용

| 번호 | 문제 | 코드 | 영향 |
|---|---|---|---|
| **P1** | session_id가 archiver에 전달되지 않아 `unknown__` 슬러그 | `manager.py:75-118` (생성자가 session_id 안 받음), `agent_session.py:923` (`SessionMemoryManager(sp)`), `manager.py:179` (`session_id=self._session_id or ""`) | 모든 신규 conversation 파일이 `unknown__<title>` 로 만들어짐 |
| **P2** | conversations 한 파일에 user_chat + reflection 혼재 | `conversation_archiver.py:643-680` (`_locate_or_initialise`가 kind 무관하게 `<sid>__<title>` 한 파일에 합침) | 사용자 의도 위반; 검색이 두 종류 사실을 혼동 |
| **P3** | 세션 롤업 frontmatter ↔ index.py 키 불일치 | `index.py:355-365` (per-turn 키만 읽음), `conversation_archiver.py:build_session_frontmatter` (세션 레벨 키 출력) | `_index.json`에 conversations 메타 fields 전부 빈 문자열 |
| **P4** | summary가 `<!--meta` HTML 주석을 그대로 노출 | `index.py:324-326` (`#` 헤딩만 strip) | 사이드바/검색에서 노이즈 |
| **P5** *(v1에서 이미 지적)* | `<YYYY-MM-DD>.md` 한 파일에 DailyJournal + write_dated 두 writer 동시 진입 | `manager.py:303` + `manager.py:736` | race 가능, 본문 형식 혼재 |

---

## 5. 개선안 — 한 PR로 같이 처리

### 5.1 conversations 파일을 kind/counterpart로 split (P2 해결)

새 파일 명명 규칙:

| Kind | 파일명 |
|---|---|
| `user_chat` | `conversations/<sid>__user__<title_slug>.md` |
| `reflection`, `internal_trigger` | `conversations/<sid>__reflection.md` |
| `dm`, `task_request`, `task_result`, `tool_run_summary` | `conversations/<sid>__dm__<cp_safe>.md` |
| `system_note` | `conversations/<sid>__system.md` |

규칙:
- **`user_chat`**: title은 첫 사용자 발화. 한 세션에 user 카운터파트가 보통 1명이라 한 파일이지만, 다중 사용자 세션이 생기면 `__user__<user_id_short>` 로 확장.
- **`reflection`**: title 없음 (자기-대화는 “안녕” 같은 의미 있는 라벨이 안 잡히기 때문). 파일명 고정.
- **`dm`**: 카운터파트 ID로 분리. 같은 세션이 worker_A, worker_B와 각각 DM하면 두 파일.
- **`system`**: 시스템 노트 분리.

이걸로 사용자가 본 “user_chat + reflection 섞임” 사례는 자연히 두 파일로 갈라진다:
```
conversations/<sid>__user__안녕.md          (turn 81049cc2 + d686e98f)
conversations/<sid>__reflection.md          (turn a453b865 + 9b99559c)
```

각 파일의 title slug:
- user 파일: 첫 user_chat의 첫 줄 (현재 로직 유지)
- reflection 파일: 고정 “Reflection” (또는 첫 reflection의 첫 줄로 바꿀 수 있지만 트리거 텍스트 `[THINKING_TRIGGER:time_evening]` 같은 게 슬러그가 되어 무의미; 고정이 낫다)
- dm 파일: counterpart ID 슬러그

위키링크 타깃:
- 이전: `conversations/<sid>__<title>#turn-<eid8>`
- 이후: `conversations/<sid>__<bucket>__<sub>#turn-<eid8>` (bucket = user/reflection/dm/system)

dm_archiver / daily_journal_writer는 변경 불필요 (`.md`-strip 로직이 anchor 형식과 무관).

### 5.2 `unknown__` 슬러그 픽스 (P1 해결)

`SessionMemoryManager.__init__` 시그니처에 `session_id` 추가:

```python
def __init__(self, storage_path: str, *,
             session_id: str = "",
             max_inject_chars: int = ...):
    ...
    self._session_id: str = session_id or ""
```

`agent_session.py:923` 도 함께 갱신:
```python
self._memory_manager = SessionMemoryManager(sp, session_id=self._session_id)
```

또한 `set_database(db, session_id)`가 나중에 호출돼 `_session_id`가 바뀌는 경우 archiver가 stale 한 채 남으니, archiver에도 setter 추가하거나 `set_database` 안에서 archiver들의 session_id를 갱신.

### 5.3 index.py가 세션 롤업 frontmatter를 이해하도록 (P3 해결)

`MemoryFileInfo`에 다음 필드 추가:
```python
# Session-rollup metadata (conversations/ category)
turn_count: int = 0
event_ids: List[str] = field(default_factory=list)
kinds: List[str] = field(default_factory=list)
counterparts: List[str] = field(default_factory=list)
importance_max: str = ""
```

`_scan_file` 에서 conversations 카테고리이고 `turn_count` 키가 있으면 위 필드들을 frontmatter에서 채운다. 기존 per-turn `event_id` 등은 conversations 카테고리에선 안 채움 (의도된 빈 값).

`render_vault_map` / 사이드바가 `turn_count` 와 `kinds`를 노출하면 사용자가 “이 파일은 user_chat 4 turn + reflection 2 turn” 같은 정보를 빨리 볼 수 있다.

### 5.4 summary가 `<!--meta` 블록을 건너뛰게 (P4 해결)

`index.py:324-326`:
```python
# 헤딩 + HTML 주석 + frontmatter-스타일 block 모두 strip
body_text = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
body_text = re.sub(r"^#+\s+.*$", "", body_text, flags=re.MULTILINE).strip()
summary = body_text[:200].strip() if body_text else None
```

이걸로 롤업 파일의 summary는 첫 turn 본문 첫 줄이 된다 (예: “안녕”).

### 5.5 `<YYYY-MM-DD>.md` 두 writer 충돌 (P5 해결)

옵션 A — `LongTermMemory.write_dated`를 별도 파일로:
```
memory/executions/<YYYY-MM-DD>.md
```
기존 `<YYYY-MM-DD>.md`는 DailyJournalWriter 전용. 라우터 깨끗.

옵션 B — `record_execution`이 daily-journal에 남기는 “execution 블록”을 daily-journal 의 frontmatter-aware writer를 통해 쓰도록 통합. 즉 write_dated 직접 호출 폐지 → DailyJournalWriter에 `append_execution_block()` 메서드 추가.

**추천: 옵션 A**. 책임이 명확해지고 두 writer가 다른 파일을 만진다. 마이그레이션은 기존 `<date>.md` 파일에서 `_(HH:MM …)\n\n[✅]…` 블록을 추출해 새 위치로 옮기면 됨.

---

## 6. 실행 계획 — 한 PR로 나눠서

| # | 변경 | 파일 | 위험도 |
|---|---|---|---|
| 1 | `SessionMemoryManager(session_id=...)` 받기 + archiver들에 propagate | `manager.py`, `agent_session.py` | 낮음 |
| 2 | `_resolve_bucket(view)` 헬퍼 → `(bucket, sub_slug)` 반환; archiver의 `_locate_or_initialise`가 bucket별로 다른 파일 선택 | `conversation_archiver.py` | 중간 |
| 3 | `derive_session_title`을 bucket별로 분기 (user는 본문 첫 줄, reflection은 “Reflection”, dm은 cp slug) | `conversation_archiver.py` | 낮음 |
| 4 | `MemoryFileInfo`에 `turn_count/event_ids/kinds/counterparts/importance_max` 추가 + `_scan_file`에서 채우기 | `index.py` | 낮음 |
| 5 | `_scan_file`이 `<!--…-->` strip | `index.py` | 매우 낮음 |
| 6 | `record_execution`의 write_dated → `memory/executions/<date>.md` 로 이동 (daily-journal 분리) | `manager.py`, `long_term.py` | 중간 (마이그레이션 필요) |
| 7 | 기존 `unknown__<title>.md` 파일과 `<date>.md` 안 execution 블록을 새 위치로 옮기는 마이그레이션 스크립트 | `scripts/migrate_conversations_split.py` 신규 | 중간 |
| 8 | 테스트 갱신 — `test_conversation_archiver.py`에 bucket split 케이스 추가 | tests | 낮음 |

각 step은 독립 commit. 머지 시 단일 PR.

---

## 7. retriever 측 후속 (별 PR)

본 PR이 conversations 폴더 구조를 정리하고 나면, retriever가 새 파일 구조를 활용하도록 후속:

- L0 recent_turns: 현재처럼 STM tail 6개 — 변경 없음.
- 신규 L0.5 “현재 세션의 user 본문 tail”: `conversations/<sid>__user__*.md`의 마지막 N anchor를 항상 추가 주입. 이러면 사용자가 conversations 본문에 직접 메모를 넣어도 다음 턴이 그것을 본다.
- vault_map은 새 파일 구조를 그대로 보여주므로 자동.

이 retriever 측은 **분리해서 다음 PR로** — 본 PR(conversations split)이 머지된 뒤 작업.

---

## 8. 결정 필요 항목

진행 전 확정 필요:

1. **bucket 분류**: user / reflection / dm / system 4개로 합의?
   - 또는 dm을 worker별로 더 세분 (`dm__worker_A`, `dm__worker_B`)? — 기본 그렇게 갈 예정.
2. **마이그레이션 정책**: 기존 `unknown__<title>.md`를 새 구조로 split해서 옮길지, 그냥 두고 새 세션부터 적용할지.
   - 추천: split 마이그레이션 (idempotent, dry-run 지원).
3. **옵션 A vs B (5.5)**: write_dated를 별도 파일(`executions/<date>.md`)로? 아니면 DailyJournal 안으로 통합?
   - 추천: 별도 파일.
4. **reflection 파일 title**: 고정 "Reflection" vs 첫 reflection 본문 첫 줄?
   - 추천: 고정. THINKING_TRIGGER 같은 트리거 텍스트가 슬러그가 되면 무의미.

위 4가지 답 받으면 한 PR로 처리.
