# Geny 메모리 시스템 — 종합 리뷰

> 작성일: 2026-05-01
> 분석 범위: `Geny/backend/service/memory/*`, `Geny/backend/service/executor/agent_session*.py`, `Geny/frontend/src/{components/tabs/MemoryTab,components/obsidian,components/OpsidianHub,app/opsidian}`, `geny-executor/src/geny_executor/{memory,stages/s02_context,stages/s03_system}/*`
> 모든 주장 뒤에는 `file:line` 으로 코드 근거가 있어요. 추론은 ⚠️ 표시.

---

## 0. TL;DR — 검증된 4개의 사실

1. **Opsidian (`/opsidian`) 에는 대화(STM) 뷰어가 없다.** `ObsidianView` 가 호출하는 API는 `memoryApi.getIndex` + `memoryApi.getGraph` 두 개뿐이고 `transcriptsApi`는 한 곳도 호출하지 않음 ([ObsidianView.tsx:67-70](frontend/src/components/obsidian/ObsidianView.tsx#L67-L70)). 대화는 일반 에이전트 페이지의 `MemoryTab → Stream` 서브탭에서만 보이고, Opsidian 에서는 우측 패널에 `STM Entries: <숫자>` 만 카운트로 노출됨 ([RightPanel.tsx:241-243](frontend/src/components/obsidian/RightPanel.tsx#L241-L243)).
2. **메모리 주입 경로가 두 갈래로 분리되어 동시에 돌고 있다.** (a) 세션 생성 시 `_build_system_prompt` 가 동기 `build_memory_context(max_chars=4000)` 를 호출해 시스템 프롬프트 꼬리에 1회성 주입 ([agent_session_manager.py:429,461](backend/service/executor/agent_session_manager.py#L429)). (b) 매 턴 s02 ContextStage 가 `GenyMemoryRetriever.retrieve(query)` 로 6레이어를 가져와 `state.metadata["memory_context"]` 에 채우고, s03 의 `MemoryContextBlock` 이 `# Relevant Knowledge` 블록으로 렌더 (`geny-executor` 측 stage.py:207, builders.py:81-92).
3. **STM 쓰기는 단일 사이트로 통합됐지만 5000자에서 잘린다.** Cycle 20260501_1 C 에서 s18 GenyDedupeStrategy 가 유일 라이터 ([dedupe_strategy.py:30-33](backend/service/memory/dedupe_strategy.py#L30-L33)). 단, `record(role, content[:5000], metadata=metadata)` 로 잘려서 기록됨 ([dedupe_strategy.py:127](backend/service/memory/dedupe_strategy.py#L127)). 긴 어시스턴트 응답은 STM에서 5000자 이상이 사라짐.
4. **InteractionEvent metadata 는 절대 LLM 프롬프트로 들어가지 않는다.** Cycle 20260430_2 invariant 4: *"Zero bytes of prompt-side data injection"* ([interaction_event.py:21](backend/service/memory/interaction_event.py#L21)). UI/검색용 부가 정보일 뿐. 즉, "VTuber 가 Sub-Worker 와 한 task_request 가 다음 turn 의 시스템 프롬프트에 자동 들어가 있다" 는 가정은 **거짓**.

---

## 1. 현재 구조 — "실제로 무엇이 어디로 흐르는가"

### 1.1 디스크 레이아웃 (세션 1개 기준)

```
<GENY_AGENT_STORAGE_ROOT>/<session_id>/
├── transcripts/session.jsonl     ← STM (단일 라이터: s18, 5000자 캡, 라인당 1 InteractionEvent)
├── transcripts/summary.md         ← (선택) 세션 요약 — auto_flush 가 만듦
├── memory/MEMORY.md               ← LTM evergreen
├── memory/YYYY-MM-DD.md           ← LTM dated
├── memory/topics/<slug>.md        ← LTM topic
├── memory/{daily,topics,entities,projects,insights}/<slug>.md  ← Structured Notes
├── memory/_index.json             ← 파생 캐시 (태그/링크/요약)
└── vectordb/{index.faiss,metadata.json}  ← FAISS (선택 활성)

<root>/_user_opsidian/<username>/  ← 사용자 스코프 (세션 횡단)
<root>/_global_memory/             ← 전역 스코프
<root>/_curated_knowledge/<username>/  ← 큐레이션 승격 결과
```

세션 ID 디렉터리는 곧 vault 입니다. `memory/` 만 Obsidian-호환 vault 의 root. ([structured_writer.py:34](backend/service/memory/structured_writer.py#L34) 의 `VALID_CATEGORIES` 와 `geny-executor/.../layout.py:27` 의 `NOTE_CATEGORIES` 가 동일한 6개로 박혀 있음.)

### 1.2 메모리 주입 — 두 경로

#### 경로 A: 세션 시작 시 시스템 프롬프트에 1회성 부착
[agent_session_manager.py:421-461](backend/service/executor/agent_session_manager.py#L421-L461)
```python
mgr = SessionMemoryManager(storage_path)
mgr.initialize()
memory_context = mgr.build_memory_context(max_chars=4000)   # 🟡 sync, query=None
...
prompt = build_agent_prompt(...)
if memory_context:
    prompt = prompt + "\n\n" + memory_context
```

`build_memory_context(query=None, include_summary=True, include_recent=0, max_chars=4000)` 가 실제로 채워주는 부분 ([manager.py:874-948](backend/service/memory/manager.py#L874-L948)):

| 섹션 | query=None일 때 | 결과 |
|---|---|---|
| 1. session-summary | `_stm.get_summary()` | summary.md 있으면 포함 |
| 2. long-term-memory | MEMORY.md 헤드 | **항상 포함** (단, char_count 가 budget 안에서) |
| 3. memory-recall | `if query:` 가드로 SKIP | ❌ 노트 검색 0건 |
| 4. recent-message | `include_recent=0` 이라 SKIP | ❌ 최근 대화 0건 |

**즉 경로 A 는 사실상 "MEMORY.md (+ summary.md)" 만 1회성으로 시스템 프롬프트에 붙이는 정적 주입.** 4000자 예산이라 MEMORY.md 가 4KB 넘으면 잘림. **세션 도중 MEMORY.md 가 갱신돼도 경로 A 는 그걸 못 봄** — 시스템 프롬프트는 SDK 기준 세션 생명주기 동안 고정.

#### 경로 B: 매 턴 s02 ContextStage 의 동적 검색
`geny-executor/src/geny_executor/stages/s02_context/artifact/default/stage.py:156-207` + `geny-executor/src/geny_executor/memory/retriever.py`

- 트리거: 매 턴, 마지막 user 메시지를 query 로 추출 → `GenyMemoryRetriever.retrieve(query, state)` 호출
- 6 레이어 합성:
  - L0 recent_turns (기본 6턴, 예산의 40%까지)
  - L1 session summary
  - L2 MEMORY.md
  - L3 FAISS vector (`enable_vector_search=True` 기본)
  - L4 keyword + importance boost + tag overlap
  - L5 backlink context
  - L6 curated knowledge (옵션)
- 결과를 `state.metadata["memory_context"]` 에 string 으로 저장
- s03 의 `MemoryContextBlock.render()` 가 `# Relevant Knowledge\n{memory_ctx}` 로 렌더

**예산 기본값**: `max_inject_chars = 8000 (vtuber) / 10000 (worker)` ([agent_session.py:1401](backend/service/executor/agent_session.py#L1401)).

이게 **진짜 메모리 주입**. 경로 A 의 시스템 프롬프트 꼬리와 별도로 매 턴마다 `state.metadata["memory_context"]` 가 새로 채워지고, persona builder 가 이걸 읽어서 그 턴의 system message 를 만들어요.

### 1.3 메모리 쓰기 — 단일 사이트 (s18)

매 턴 끝 ([dedupe_strategy.py:55-135](backend/service/memory/dedupe_strategy.py#L55-L135)):
1. AgentSession 이 미리 `state.metadata["_pending_message_metadata"] = {"user": ..., "assistant": ...}` 에 InteractionEvent 메타를 박아둠
2. s18 GenyDedupeStrategy._record_transcript 가 새로 추가된 messages 를 walk
3. 첫 user/assistant 메시지에는 hint 그대로, 같은 role 의 후속 메시지는 `_fresh_from_template` 로 새 event_id 만 발급 (cycle 20260501_2 F1)
4. `record(role, content[:5000], metadata=metadata)` ← **5000자 트렁케이트**
5. `record_message` 안에서 `_maybe_bootstrap_entity` 가 비동기적으로 entities/<sanitized>.md 를 만들거나 stats 를 갱신 ([manager.py:252-264](backend/service/memory/manager.py#L252-L264) → [entity_bootstrap.py:71](backend/service/memory/entity_bootstrap.py#L71))

LTM/Notes 쓰기는 **명시적 호출이 있어야만** 일어남 (`remember*`, `write_note`, 또는 LLM reflection 결과). 자동으로 늘어나는 건 STM jsonl 과 entities/*.md 두 곳뿐.

### 1.4 UI 표면

| 화면 | 본 데이터 | API |
|---|---|---|
| 일반 에이전트 페이지 → MemoryTab → **LTM Notes** | `memory/` 폴더 트리 + 노트 본문 | `memoryApi.getIndex/readFile/search` |
| 일반 에이전트 페이지 → MemoryTab → **Stream** | `transcripts/session.jsonl` 파싱 | `transcriptsApi.list/counterparts` |
| `/opsidian` → **sessions** | `memory/` 만 (Stream 없음) | `memoryApi.getIndex/getGraph/readFile` |
| `/opsidian` → **user** | `_user_opsidian/<username>/` | `userOpsidianApi.*` |
| `/opsidian` → **curator** | `_curated_knowledge/<username>/` | `curatedApi.*` |

**Stream 탭은 일반 에이전트 페이지의 MemoryTab 안에만 존재합니다.** Opsidian 에서는 호출되지 않음.

---

## 2. 검증된 문제 11개

심각도 표기: 🔴 critical / 🟠 high / 🟡 medium / ⚪ low

### P1 🔴 Opsidian 에 conversation 뷰가 통째 빠져 있음

[ObsidianView.tsx:64-86](frontend/src/components/obsidian/ObsidianView.tsx#L64-L86) 가 로드하는 데이터는 `memoryApi.getIndex(sessionId)` + `memoryApi.getGraph(sessionId)` 둘뿐. `ObsidianTabs`, `ObsidianSidebar`, `NoteViewer`, `SearchPanel`, `RightPanel` 어디에서도 `transcriptsApi` 를 호출하지 않음 (`grep -rn "transcriptsApi" frontend/src/components/{obsidian,user-opsidian,curated-knowledge}/` → 0건).

영향:
- "이 세션이 누구와 무엇을 했는지" 시간 흐름으로 볼 길이 Opsidian 에 없음.
- Sub-Worker 의 task_run, paired DM, 사용자 채팅이 노트화되기 전에는 Opsidian 에서 *전혀* 안 보임. (entities/*.md 는 stub 수준의 stats 요약일 뿐 — 실제 대화 내용 X.)
- 우측 패널에 `STM Entries: 12` 같은 카운트가 떠도 클릭하면 아무 것도 안 열림 — 카운트 외 인터랙션 없음.

### P2 🔴 InteractionEvent payload 가 노트화되지 않음

`tool_run_summary` payload 안에는 `tools_used`, `files_written`, `bash_commands`, `web_fetches`, `errors`, `duration_ms`, `cost_usd`, `raw_tool_calls` 같은 풍부한 정보가 있음 (사용자가 보여준 jsonl 샘플의 `payload` 필드). 이건 **검색 가능한 LTM 노트로 영구화되지 않음**. 즉:

- 다음 세션은 "지난 세션에서 워커가 무엇을 했는지" 검색 못 함 (entities/<id>.md 의 stats 합계만 봄).
- vector index 에도 안 들어감 (`record_execution` 이 호출되지 않으면 새 노트 자체가 없음).
- payload 의 `raw_tool_calls.input.content` 같은 본문은 STM jsonl 안에만 살고, 2000줄 캡 이후 영원히 사라짐 ([short_term.py:40](backend/service/memory/short_term.py#L40)).

### P3 🟠 STM 쓰기 5000자 트렁케이트 — 긴 응답이 무음 손실

[dedupe_strategy.py:127](backend/service/memory/dedupe_strategy.py#L127): `record(role, content[:5000], metadata=metadata)`. 어시스턴트가 1만 자 짜리 분석 리포트를 내놓아도 STM 에는 처음 5000자만 남음. 이는:
- recent_turns 에서 잘린 본문이 다시 컨텍스트로 들어가 어시스턴트가 이어서 내놓은 후속 답변과 일관성이 깨질 수 있음.
- LTM 자동 변환이 없으니 잘린 5000자가 **유일한 흔적**.

### P4 🟠 경로 A (세션 시작 시 정적 주입) 와 경로 B (s02/s03 동적 주입) 의 중복·정합성 위험

같은 MEMORY.md 가 두 곳에서 system 메시지로 들어갈 수 있음:
- 경로 A: SDK 가 `system_prompt` 파라미터로 받은 문자열 끝에 붙어 세션 동안 고정
- 경로 B: 매 턴 system message 의 `MemoryContextBlock` 에서 `# Relevant Knowledge` 로 렌더

세션 도중 MEMORY.md 를 수정하면:
- 경로 A 의 사본은 **stale** (세션 생성 시 스냅샷)
- 경로 B 의 사본은 **fresh** (매 턴 다시 읽음)
→ 같은 system 메시지 안에 옛 본문 + 새 본문이 동시 등장해 LLM 이 모순된 두 버전을 보게 됨. ⚠️ 실제 발생 여부는 SDK 구현에 따라 달라지지만 가능성은 코드 상으로 열려 있음.

### P5 🟠 경로 A 가 기껏 4000자에서 잘림

`build_memory_context(max_chars=4000)` 하드코딩 ([agent_session_manager.py:429](backend/service/executor/agent_session_manager.py#L429)). MEMORY.md 가 4KB 넘으면 진짜로 절단된 본문이 system prompt 에 들어감. 경로 B 는 8000~10000 자 예산이라 더 관대 — 두 경로 예산이 다른 것도 일관성 깨짐.

### P6 🟠 STM 동시쓰기에 락이 없음

[short_term.py:123-170](backend/service/memory/short_term.py#L123-L170) 의 `add_message` 는 단순 `_append_jsonl` 호출, 락 0개. 한편:
- 사용자 메시지 record_message 와 ActivityTrigger/IdleTrigger 의 자동 reflection record_message 가 동시 도착 가능
- entity_bootstrap 의 update_note 는 다시 `read → modify → write` 비원자적 시퀀스 ([structured_writer.py:194-238](backend/service/memory/structured_writer.py#L194-L238))
- 인덱스 락은 있지만 ([index.py:120](backend/service/memory/index.py#L120)) STM jsonl 라인 단위 원자성 보장은 없음

증상: jsonl 라인 깨짐 (한 줄에 두 JSON 이 섞여 다음 파싱이 silently 실패하고 그 라인은 InteractionEvent 인덱스에서 사라짐 — Stream 탭에 안 보이는 "구멍").

### P7 🟠 entities/*.md 가 stub 으로 영원히 남는 케이스

[entity_bootstrap.py:128-154](backend/service/memory/entity_bootstrap.py#L128-L154): 첫 등장 → stub body, **재등장이 있어야만** stats 자동 갱신. 즉 한 번만 만난 카운터파트의 노트는 영원히 *"_(아직 distillation 이 진행되지 않았어요…)_"* 로 남음. distill 도구는 LLM 호출이라 자동 안 돌고, 운영자가 명시적으로 부르지 않는 한 본문이 비어 있음.

또한 stats 갱신은 **본문 통째 덮어쓰기** ([entity_bootstrap.py:196](backend/service/memory/entity_bootstrap.py#L196)) → 사람이 손으로 쓴 보강 메모는 다음 record_message 에서 사라짐.

### P8 🟡 Sub-Worker 와 VTuber 의 메모리는 완전 분리

각 세션은 **자기 storage_path 의 SessionMemoryManager 만** 봄 ([agent_session_manager.py:421-433](backend/service/executor/agent_session_manager.py#L421-L433)). VTuber 가 Sub-Worker 에게 task_request 를 보낼 때:
- VTuber 의 STM 에 `direction=out, kind=task_request` 라인이 추가됨
- Sub-Worker 의 STM 에 `direction=in, kind=task_request` 라인이 추가됨 (recipient-side 분류, [interaction_event.py:295-336](backend/service/memory/interaction_event.py#L295-L336))
- 하지만 두 STM 은 **다른 디스크 디렉터리** — 검색·인젝션 시 서로 못 봄

운영적 효과: VTuber 의 LTM (예: "지난 주 사용자가 좋아한 농담 패턴") 을 Sub-Worker 가 task 수행 중에 참조할 길이 메모리 시스템 안에 없음. context_files / shared_folder 가 부분적 우회를 제공하지만 **메모리 시맨틱이 아니라 파일 공유** 수준.

### P9 🟡 vector index 가 명시적 await initialize_vector_memory() 없으면 비활성

[manager.py:174-194](backend/service/memory/manager.py#L174-L194): `initialize()` 는 sync 라 vector 안 켬. 별도 async `initialize_vector_memory()` 를 호출해야 FAISS index 가 빌드됨. 부르지 않으면 `self._vmm.enabled == False` → L3 vector 검색은 그냥 skip ([manager.py:995](backend/service/memory/manager.py#L995)). ⚠️ 어디서 부르는지 운영 환경 확인 필요. 안 부르면 vector 가 6레이어 중 1레이어 떨어진 5레이어 합성으로 동작.

### P10 🟡 `build_memory_context_async` 는 production 에서 호출되지 않음

`grep -rn "build_memory_context_async" backend/service/` → 정의·로깅만 5건, 호출자 0건. 즉 manager.py 의 async 버전은 dead code. 경로 A 가 sync 버전을 쓰고, 경로 B 는 manager 가 아니라 GenyMemoryRetriever 를 거치므로 async 버전을 안 거침. 코드 가운데 한 함수가 죽어 있음 — 이걸 제거하든 wiring 하든 결정 필요.

### P11 ⚪ `_index.json` 의 백링크가 frontmatter `linked_from` 과 분리됨

노트 frontmatter 의 `linked_from` 은 항상 빈 배열로 저장됨 ([structured_writer.py:373-374](backend/service/memory/structured_writer.py#L373) — `linked_from` 는 인덱서가 in-memory 로만 채움, 디스크 파일에는 안 박힘). 사용자가 Obsidian 에서 같은 vault 를 열면 backlink 는 Obsidian 자체 패널에서 보이지만, frontmatter 만 보고 backlink 정보를 얻으려는 외부 도구는 정보 손실.

---

## 3. ⚠️ 추정 (코드만으론 확신 못 하는 항목)

| 항목 | 코드 단서 | 검증 방법 |
|---|---|---|
| 경로 A 와 B 의 중복 주입이 실제 LLM 입장에서 모순되게 보이는가 | system prompt 에 두 번 들어갈 가능성은 있지만 SDK 가 둘을 어떻게 합치는지는 코드 추적만으론 단정 어려움 | 실제 세션 1개 띄워 SDK 가 보낸 system 메시지 캡처 |
| `ActivityTrigger`/`IdleTrigger` 의 record_message 가 사용자 turn 과 정말 동시 도착하는가 | 트리거 모듈의 스케줄링·락 코드 미검토 | 트리거 코드 + STM 락 부재 조합으로 race condition 재현 시도 |
| Sub-Worker 가 paired_subworker 컨텍스트를 자동으로 받는 path 가 진짜 0인가 | grep 결과 0건이지만 PersonaProvider.append_context 같은 우회로 존재 | Sub-Worker 시작 시 system prompt dump 캡처 |

---

## 4. 개선 방향 — 우선순위 6단

각 항목은 (영향, 난이도, 의존성) 으로 평가.

### 🥇 1순위 — Opsidian 에 Conversation 뷰 추가 (영향 ↑↑, 난이도 중)

**왜:** P1+P2 가 동시에 해결됨. 사용자가 "메모리 시스템" 으로 인식하는 표면이 Opsidian 인데 거기서 대화가 안 보이면 시스템 자체가 반쪽으로 느껴짐.

**방법 (3 옵션):**
- **A. Opsidian 에 Stream 사이드탭 추가**: `ObsidianTabs.tsx` 에 "Conversation" 탭을 넣고 기존 `StreamTab` 컴포넌트를 재사용. props 로 sessionId 받아서 동일 동작. 가장 적은 코드.
- **B. Opsidian 의 vault tree 에 가상 폴더 `_conversation/` 추가**: jsonl 라인을 마크다운 노트처럼 시뮬레이트 (event_id → 가짜 filename, payload → frontmatter, content → body). Obsidian 검색·그래프와 통합되는 장점, 하지만 가상 노트가 실제 파일이 아니라 일관성 깨짐.
- **C. STM jsonl 라인을 `transcripts/<event_id>.md` 로 동시 작성**: 진짜 파일. 검색·grep·external Obsidian 데스크톱이 그대로 봄. 단, 디스크 IO 가 라인당 1 파일 추가 → 양 많을 때 파일 수 폭증.

→ 추천: **A 부터 시작** (1주일짜리 작업), 그 다음 운영 중에 C 로 점진 이행 검토.

### 🥈 2순위 — STM 5000자 트렁케이트 폐기 또는 LTM 자동 강등 (P3 + P2)

**왜:** 정보 손실의 주범. STM 은 어차피 2000줄 캡이라 디스크 부담 작음. 그리고 5000자 넘는 응답은 운영적으로 매우 흔함 (코드 리포트, 분석 글).

**방법:**
- 단순: [dedupe_strategy.py:127](backend/service/memory/dedupe_strategy.py#L127) 의 `[:5000]` 제거. 영향 검토 필요한 곳: STM 검색 인덱스, prompt 재인젝션 시 토큰 폭증.
- 더 나은: **5000자 넘으면 자동으로 `record_execution` 호출** → dated LTM + 노트 + vector 인덱싱. STM 라인은 "[truncated → see notes/insights/<file>]" 포인터만.

### 🥉 3순위 — 경로 A 폐기, 경로 B 로 단일화 (P4 + P5 + P10)

**왜:** 두 경로가 공존하는 한 일관성·예산·디버깅 모두 두 배. `_build_system_prompt` 가 memory_context 를 시스템 프롬프트에 직접 합치는 건 historical artifact (s02 ContextStage 도입 전 코드).

**방법:**
- [agent_session_manager.py:421-461](backend/service/executor/agent_session_manager.py#L421-L461) 의 memory_context 부착 블록 삭제.
- 경로 B 가 매 턴 `state.metadata["memory_context"]` 를 채워주므로 시스템 프롬프트는 정적 페르소나·instructions 만 갖게 됨.
- `build_memory_context` (sync) + `build_memory_context_async` (dead) 둘 다 deprecated 표시 → 차기 PR 에서 제거.

### 4순위 — STM 쓰기 락 + frontmatter `linked_from` 영구화 (P6 + P11)

**왜:** 데이터 무결성. 락 부재는 cycle 20260501_1 C 가 single-writer 로 줄였지만, ActivityTrigger 등 비동기 자동 trigger 는 여전히 별도 라이터.

**방법:**
- `ShortTermMemory.__init__` 에 `self._lock = asyncio.Lock()` (또는 threading lock — Geny 가 sync 라우터·async pipeline 을 섞고 있으면 둘 다 필요), `add_message`/`add_event` 를 락 안에서 실행.
- `_FilesystemNotesStore.write_to_disk` 가 frontmatter 에 `linked_from` 도 같이 박아넣도록. 단점: 매 노트 갱신 시 그 노트를 가리키는 다른 모든 노트도 갱신 필요 → batch reindex 트리거 비용. ⚠️ 트레이드오프 검토 필요.

### 5순위 — Sub-Worker 의 메모리 inheritance 정책 결정 (P8)

**왜:** 페어 에이전트 모델에서 메모리가 분리된 건 의도일 수도(invariant 3 — caller-scoped) 비의도일 수도 있음. 결정해야 함.

**옵션:**
- **유지 (read-only inheritance)**: Sub-Worker 의 `GenyMemoryRetriever` 가 paired_vtuber 의 LTM 도 함께 읽도록 확장. 쓰기는 절대 못 함.
- **공유 vault**: paired 세션 쌍이 같은 디스크 디렉터리를 공유. Cycle 20260430_2 invariant 3 ("도구는 자기 세션의 메모리만 본다") 와 정면 충돌 — 정책 변경 필요.
- **명시적 import**: VTuber 가 task_request 페이로드에 LTM 발췌를 직접 박아 보냄. 현 구조에서 가장 안전하지만 운영 부담 ↑.

### 6순위 — entities/*.md 의 본문 보존 모드 + auto-distill 트리거 (P7)

**왜:** 사람이 노트를 보강해도 다음 record_message 에서 통째 덮어쓰여지는 건 사용자 데이터 침해.

**방법:**
- entities/*.md 본문을 두 섹션 (`## Stats` (자동 갱신) + `## Notes` (수동, 보존)) 으로 분리.
- `_render_entity_stats_body` 가 `## Stats` 섹션만 교체.
- `events_seen >= N` (예: 10) 도달 시 auto-distill (LLM 호출) 큐에 추가 → curation_scheduler 처럼 백그라운드로 narrative 생성.

---

## 5. 즉각 점검해야 할 운영 질문 5개

1. **vector_memory 가 실제로 켜져 있는가?** `initialize_vector_memory()` 의 호출 사이트 grep 으로 확인. 안 켜져 있으면 6레이어 중 가장 강력한 의미 검색이 dead.
2. **MEMORY.md 가 운영 세션에서 4KB 를 넘었는가?** 한 세션의 `memory/MEMORY.md | wc -c` 출력. 4KB 넘으면 경로 A 가 본문 절단 중.
3. **Stream 탭에 보이는 이벤트 수와 jsonl 라인 수가 일치하는가?** 불일치 시 P6 (락 부재로 인한 깨진 라인) 또는 InteractionEvent 메타 누락.
4. **어떤 trigger 가 record_message 를 호출하는가?** ActivityTrigger / IdleTrigger / DM trigger 코드를 한 번에 봐야 P6 의 실제 race window 가 확정됨.
5. **Sub-Worker session 의 system prompt dump 에 paired VTuber 의 MEMORY.md 가 들어가 있는가?** 들어가 있으면 P8 의 "분리" 가정 자체가 틀림 — 코드 외 wiring 이 어디선가 일어남.

---

## 6. Obsidian 데스크톱 호환 — 결론

호환 자체는 됨 (frontmatter + wikilinks + 6 카테고리 폴더 = Obsidian vault 그대로). 그러나 **conversation 영구화가 빠져 있어** Obsidian 으로 vault 를 열어도 보이는 건 LTM 노트뿐. P1·P2 가 해결되기 전까지는:
- `<session_root>/memory/` 를 vault 로 열면 → 노트는 잘 보임. 대화 흐름은 안 보임.
- `<session_root>/transcripts/session.jsonl` 은 Obsidian 이 안 읽음 (.md 가 아니라서).
- 운영자가 "Sub-Worker 가 한 일을 vault 에서 검색" 하려면 entities/<id>.md 의 stats 합계만 검색 가능 — 실제 task 본문은 못 찾음.

---

## 7. 1주일짜리 권장 PR 순서

| 순서 | 작업 | 영향 |
|---|---|---|
| 1 | P3 — STM 5000자 cap 제거 + dated LTM 자동 강등 (5000+ 응답 시) | 정보 손실 즉시 차단 |
| 2 | P1 — Opsidian 에 Stream 서브탭 추가 (옵션 A) | 사용자 가시성 회복 |
| 3 | P4+P5+P10 — 경로 A 제거, 경로 B 단일화, dead async 함수 삭제 | 일관성·예산·dead code |
| 4 | P6 — STM 락 추가 | 무결성 |
| 5 | P7 — entities `## Stats`/`## Notes` 섹션 분리 + auto-distill 큐 | UX |
| 6 | P8 — Sub-Worker inheritance 정책 결정 (논의 → spec → 구현) | 정책 |

P2·P9·P11 은 위 작업과 함께 점진적으로 흡수.

---

## Appendix A — 핵심 파일 인덱스

| 영역 | 파일 |
|---|---|
| STM 쓰기 단일사이트 | `backend/service/memory/dedupe_strategy.py` |
| STM 본체 | `backend/service/memory/short_term.py` |
| LTM 본체 | `backend/service/memory/long_term.py` |
| 노트·인덱스 | `backend/service/memory/{structured_writer,index,frontmatter}.py` |
| InteractionEvent 스키마 | `backend/service/memory/interaction_event.py` |
| Entity bootstrap | `backend/service/memory/entity_bootstrap.py` |
| Manager facade | `backend/service/memory/manager.py` |
| 경로 A 주입 | `backend/service/executor/agent_session_manager.py:421-461` |
| 경로 B 주입 | `geny-executor/.../stages/s02_context/artifact/default/stage.py:156-207` |
| 경로 B retriever | `geny-executor/.../memory/retriever.py` |
| MemoryContextBlock | `geny-executor/.../stages/s03_system/artifact/default/builders.py:81-92` |
| Tail blocks resolver | `backend/service/persona/blocks_resolver.py` |
| Opsidian 진입 | `frontend/src/app/opsidian/page.tsx`, `frontend/src/components/OpsidianHub.tsx` |
| Opsidian session view | `frontend/src/components/obsidian/ObsidianView.tsx` |
| Stream 탭 (MemoryTab 내부) | `frontend/src/components/tabs/memory/StreamTab.tsx` |
| Transcripts API | `backend/controller/transcripts_controller.py` |

---

## Appendix B — "한 줄로 요약하면"

> **현재 시스템은 LTM 은 잘 쓰고, STM 은 잘 모으지만, 그 둘을 잇는 자동 변환과 사용자에게 보여주는 conversation 표면이 비어 있다. 메모리는 에이전트에게 절반만 전달되고 있다.**

— LTM 이 매 턴 들어간다는 점은 ✅ 검증 완료 (경로 B 의 GenyMemoryRetriever).
— STM 의 풍부한 payload 가 LTM 으로 자동 변환되지 않는다는 점이 ❌ 큰 누수.
— Opsidian 이 STM 을 시각화하지 않는다는 점이 ❌ 큰 표면 공백.
— 두 path 가 동시 존재 (A: 시작 시 4KB MEMORY.md, B: 매 턴 8-10KB 6레이어) 가 ⚠️ 일관성 위험.
