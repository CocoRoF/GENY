# Geny 메모리 시스템 — 통합 재설계 Plan v2

> 작성일: 2026-05-01
> 입력: review.md (현 구조 + 11개 문제), 사용자 5대 철학, "대화 원천을 별도 카테고리로" 결정.
> 분석 대상: `Geny/backend/service/memory/*`, `Geny/backend/tools/built_in/memory_*.py`, `Geny/backend/prompts/*`, `geny-executor/src/geny_executor/{memory,stages/s02_context,stages/s03_system}/*`.
>
> v1 대비 핵심 변화: **`memory/conversations/` 를 leaf source-of-truth 카테고리로 도입.** `insights/` 는 derived 영역으로 의미 순화. `dms/`, `YYYY-MM-DD.md` 는 본문 중복 없이 wikilink 인덱스로 가벼워짐.

---

## 0. 5대 철학 — 한 페이지 매핑

| # | 철학 | 한 줄 의미 | 현재 상태 | 핵심 갭 |
|---|---|---|---|---|
| 1 | 세션 대화 연결성 | 최근 N턴 + 관련 턴이 세션에 항상 보존·인젝션. 단 한 글자도 손실 없음. | recent_turns(6) 만 자동 인젝션. 5000자 트렁케이트로 본문 손실. relevant turns 검색은 도구로만 가능 | **conversations/ 도입으로 STM 캡 무관하게 본문 보존**; "relevant turns" 자동 검색이 retrieval 에 없음 |
| 2 | Context 길어지면 compact 필수 | executor 레벨에서 자동 발동, summary 결과는 영구 저장 | `LLMSummaryCompactor` 정의됨, 임계 0.8 트리거 코드 존재 | 실제 production wiring 미확인; compaction 결과가 LTM 으로 안 들어가서 다음 세션이 못 봄 |
| 3 | LTM 완벽 관리 + memory/ 폴더 + Obsidian 가시성 | 모든 LTM이 markdown frontmatter+wikilink로 영구화 | LTM 본체는 Obsidian 호환. 단 `linked_from` 디스크 미저장, entities 본문 자동 덮어쓰기 | `linked_from` 영속화, entities Stats/Notes 섹션 분리 |
| 4 | 모든 Agent의 DM → LTM 영구화 + memory/ + Obsidian + Stream | 모든 turn(DM 포함) 이 markdown 노트로 자동 저장 | STM jsonl 라인만 있고 2000줄 캡 후 영구 손실. LTM 노트 자동 변환 0건 | **conversations/ 자동 작성** (per-turn 1 file) + `dms/` 인덱스 + Opsidian Conversation 뷰 |
| 5 | LTM 은 TOOL 로 점진적 공개 | 프롬프트에는 "지도" 만, 본문은 도구로 펼침 | 도구 13개 존재, vtuber.md만 ladder 문서화. path A 가 MEMORY.md 4KB 강제 인젝션 — 점진적 공개 철학과 충돌 | path A 폐기 + 모든 role 프롬프트에 ladder 추가 + Vault Map 자동 인젝션 + 도구 응답에서 본문 제거 |

---

## 1. 목표 아키텍처

### 1.1 한 줄 요약

> **모든 turn 은 `memory/conversations/` 에 1 파일 1 turn 으로 영구 보존된다 (leaf source of truth). STM jsonl·dms/·daily journal·entities/ 는 그것을 wikilink 로 가리키는 인덱스일 뿐이다. 시스템 프롬프트엔 "지도" 만, 매 턴엔 "최근 + 인덱스 요약" 만 들어가고, 본문은 Agent 가 도구로 펼친다.**

### 1.2 메모리 주입 — 세 단(段)으로 정리

```
┌─────────────────────────────────────────────────────────────┐
│ STATIC LAYER (시스템 프롬프트, 세션 시작 시 1회)             │
│  ─ 페르소나 / 도구 목록 / 행동 지침                         │
│  ─ MEMORY LADDER doc (모든 role별 prompts/*.md 에 포함)     │
│  ─ Vault MAP (memory/ 트리 카테고리·파일수·태그·최근수정만) │
│  ✗ MEMORY.md 본문 인젝션 금지 (path A 폐기)                 │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│ DYNAMIC LAYER (s02 ContextStage, 매 턴)                     │
│  ─ Recent N turns          (STM 에서, 빠른 액세스)         │
│  ─ Relevant turns 신설     (현재 query 와 유사한 STM top-3)│
│  ─ Session summary         (compaction 결과)               │
│  ─ Vault Map snapshot      (~500자 요약)                   │
│  ✗ MEMORY.md / vector / keyword 본문 자동 인젝션 X         │
│    (Agent 가 도구로 직접 펼치게)                            │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│ ON-DEMAND LAYER (도구 호출, Agent 가 결정)                  │
│  memory_search(query, category?, kind?, counterpart?)        │
│    → 후보 filename·score·1-line snippet 만 반환              │
│  memory_read(filename) → 본문 전체 (conversations/, etc.)   │
│  memory_status / memory_with / memory_event / memory_artifact│
│  memory_distill / memory_link / memory_write                 │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 메모리 쓰기 — 자동 변환 파이프

```
record_message(role, content, InteractionEvent metadata)
    ├─ STM jsonl append (캡·트렁케이트 유지, fast mirror 용)
    ├─ ★ conversations/<YYYY-MM-DD>/<HH-MM-SS>__<role>__<eid8>.md ★
    │     1 turn = 1 file. 본문 전체 + frontmatter (event_id, kind,
    │     direction, counterpart, role, ts, session_id, importance, …)
    │     → leaf source of truth. 모든 다른 카테고리는 이걸 wikilink.
    │
    ├─ dms/<sanitized_counterpart>/<YYYY-MM-DD>.md  (kind ∈ {dm, task_*, tool_run_summary} 일 때)
    │     index 갱신: 그 날 그 카운터파트의 event_id 누적, 1-line headline 추가,
    │     본문엔 [[conversations/...]] wikilink 로 점프
    │
    ├─ <YYYY-MM-DD>.md  (daily journal, root 카테고리)
    │     index 갱신: 그 날의 모든 turn 의 1-line headline + wikilink
    │
    └─ entity_bootstrap (counterpart 첫 등장 → entities/<id>.md Stats 갱신)

compaction triggered (s02 ContextStage, threshold 도달)
    └─ LLMSummaryCompactor 실행
         ├─ state.messages 압축
         ├─ memory/compactions/<sid>__<ts>.md 자동 작성 (vault 검색 가능)
         ├─ transcripts/compactions/<ts>.md (audit log)
         └─ summary.md 누적 갱신

LLM reflection (선택, 별도 사이클)
    └─ memory/insights/<slug>.md
         (LLM 이 conversations/ 들을 읽고 distill 한 정제 지식)

LTM 명시적 쓰기 (memory_write 도구 등)
    └─ memory/{topics,projects,daily}/<slug>.md (사람·도구가 작성)
```

**핵심 invariant**: 본문은 `conversations/` 한 곳에만 산다. 다른 카테고리는 메타·요약·링크.

### 1.4 디스크 레이아웃

```
<root>/<session_id>/
├── transcripts/                                    ← FAST MIRROR (STM)
│   ├── session.jsonl              (캡 2000줄·라인당 5000자 유지)
│   ├── summary.md                 (compaction 누적 요약)
│   └── compactions/<ts>.md        (각 compaction 시점 audit)
│
└── memory/                                          ← LTM VAULT (Obsidian-호환)
    │
    │ ── LEAF (source of truth) ──────────────────────────────────
    ├── conversations/             ← ★ 모든 turn = 1 파일 ★
    │   └── 2026-05-01/
    │       ├── 01-22-12__assistant_dm__25a3ca45.md
    │       ├── 01-22-15__user__0312d51b.md
    │       ├── 01-22-15__assistant__a8d9d03e.md
    │       ├── 01-22-31__user__d230c154.md   (kind=tool_run_summary)
    │       └── …
    │
    │ ── INDEX (cross-references conversations/) ─────────────────
    ├── dms/<sanitized_counterpart>/<YYYY-MM-DD>.md
    │       (그 날 그 카운터파트의 turn 들 — 1-line headline + wikilink)
    ├── 2026-05-01.md              (daily journal — 그 날의 모든 turn)
    ├── entities/<sanitized>.md    (카운터파트 Stats / Notes split)
    │
    │ ── DERIVED (curated/distilled) ─────────────────────────────
    ├── insights/<slug>.md         (LLM reflection 산출물)
    ├── MEMORY.md                  (evergreen 누적, 사람·remember 도구가 작성)
    ├── topics/<slug>.md           (주제 페이지, 명시적 작성)
    ├── projects/<slug>.md         (진행 프로젝트)
    ├── daily/<slug>.md            (free-form day note, 명시적)
    │
    │ ── COMPACTION ARTIFACTS ────────────────────────────────────
    ├── compactions/<sid>__<ts>.md (vault-searchable summary)
    │
    │ ── SYSTEM ──────────────────────────────────────────────────
    ├── _index.json                (linked_from 도 frontmatter 동기화)
    └── _vault_map.json            (시스템 프롬프트 인젝션용)

<root>/_user_opsidian/<username>/   ← 사용자 횡단 vault (구조 동일)
<root>/_global_memory/              ← 전역 vault (구조 동일)
<root>/_curated_knowledge/<username>/ ← 큐레이션 승격 결과
```

### 1.5 카테고리 매트릭스 — 누가 무엇을 담당하는가

각 카테고리의 **역할**, **누가 쓰는가**, **본문 보유 여부**:

| 카테고리 | 역할 | 자동 생성? | 본문 보유 | 가리키는 곳 |
|---|---|---|---|---|
| `conversations/<date>/<id>.md` | **Leaf SoT** — 1 turn 1 file 영구 보존 | ✅ 모든 record_message | ✅ 전체 본문 | (없음 — 다른 게 가리킴) |
| `dms/<cp>/<date>.md` | **Index** — 카운터파트별 일일 묶음 | ✅ kind∈{dm,task_*,tool_run_summary} 시 | ❌ 1-line headline 만 | conversations/ |
| `<YYYY-MM-DD>.md` (root) | **Index** — 일자별 모든 turn 시간순 | ✅ 매 turn | ❌ 1-line headline 만 | conversations/ |
| `entities/<id>.md` | **Index + Notes** — 카운터파트 stats + 사람 메모 | ✅ counterpart 첫 등장 / stats 갱신 시 | △ Stats(자동) + Notes(수동) | conversations/, dms/ |
| `insights/<slug>.md` | **Derived** — LLM distill 정제 지식 | ❌ 명시적 reflection 시 | ✅ 정제 본문 | conversations/ (소스 인용) |
| `MEMORY.md` | **Curated** — evergreen 누적 narrative | ❌ remember() / 사람 | ✅ | (자유) |
| `topics/<slug>.md` | **Curated** — 주제 페이지 | ❌ remember_topic / 사람 | ✅ | (자유) |
| `projects/<slug>.md` | **Curated** — 진행 프로젝트 | ❌ 사람 / 도구 | ✅ | (자유) |
| `daily/<slug>.md` | **Curated** — free-form day note | ❌ 사람 / 도구 | ✅ | (자유) |
| `compactions/<sid>__<ts>.md` | **Artifact** — compaction 스냅샷 | ✅ s02 compactor 발동 시 | ✅ summary 본문 | (소스: 압축 전 messages) |

**핵심 의미 분리**:
- **SoT (conversations)**: 변하지 않는 사실. "이 turn 에서 이 글자가 나왔다."
- **Index (dms / daily / entities)**: SoT 의 다른 각도 보기. 본문 X. 변경 자유 (재생성 가능).
- **Derived (insights)**: LLM 이 재해석한 지식. SoT 가 변하지 않아도 derived 는 다시 만들 수 있음.
- **Curated (MEMORY/topics/projects/daily)**: 사람 또는 명시적 도구가 의도적으로 쌓은 narrative. 자동 갱신 X.
- **Artifact (compactions)**: 시스템 운영 산출물. 영구화는 되나 사람이 직접 편집할 일 없음.

### 1.6 conversations/ 카테고리 — 정의

#### 1.6.1 파일명 규칙
```
memory/conversations/<YYYY-MM-DD>/<HH-MM-SS>__<role>__<event_id_8>.md
```
- 일자 서브폴더: `ls` 가독성 + Obsidian 폴더 트리에서 시간순 자연 정렬
- 파일명 시간 prefix: 같은 날 내 시간 정렬 (Obsidian alphabetic = chronological)
- `<role>`: `user` / `assistant` / `assistant_dm` / `internal_trigger` / `system` 중 하나
- `<event_id_8>`: event_id 의 첫 8자 (full id 는 frontmatter)

예:
```
conversations/2026-05-01/01-22-12__assistant_dm__25a3ca45.md
conversations/2026-05-01/01-22-15__user__0312d51b.md
conversations/2026-05-01/01-22-31__user__d230c154.md   ← kind=tool_run_summary
```

#### 1.6.2 Frontmatter 표준 (canonical 13 키)
```yaml
---
title: "[task_request → 82b10c90] test.txt 만들고 자기소개..."
category: conversations
date: "2026-05-01"
ts: "2026-05-01T01:22:12.884629+09:00"
event_id: "25a3ca4544db4eebaf5048433533b610"
role: assistant_dm
kind: task_request
direction: out
counterpart: "82b10c90-4c95-4e4f-863d-0bef73801fde"
counterpart_role: paired_subworker
linked_event_id: null                              # task_result 라면 task_request 의 event_id
session_id: "e36b0599-2dfb-47fd-8ab3-f387f6f06042"
content_chars: 287
tags: [conversation, task_request, paired_subworker]
importance: medium
links_to:
  - "dms/82b10c90/2026-05-01"
  - "entities/82b10c90"
  - "2026-05-01"
linked_from: []                                     # batch reindex 시 채워짐
---
```

#### 1.6.3 본문 규칙

**일반 turn (user / assistant / assistant_dm 본문이 텍스트):**
```markdown
# task_request → 82b10c90 (paired_subworker)

[DM to ㅍㅋ_worker (internal)]: test.txt 파일을 만들고, 그 안에
너(Sub-Worker)의 자기소개를 작성해줘. 어떤 역할을 하는지, 어떤 걸
잘하는지 자유롭게 써줘!

---
**Linked:**
- ↑ Day journal: [[2026-05-01]]
- ↑ DM bundle: [[dms/82b10c90/2026-05-01]]
- ↑ Counterpart: [[entities/82b10c90]]
```

**tool_run_summary turn (구조화 payload 가 있음):**
```markdown
# tool_run_summary ← 82b10c90 (paired_subworker)

**Status:** ok
**Tools:** Write (1 call · 1 ok / 0 failed)
**Files written:**
- `/data/geny_agent_sessions/<sid>/test.txt`
**Duration:** 15.5s · **Cost:** $0.0709095

## Summary
Completed using Write (1 tool call).

## Body
[SUB_WORKER_RESULT]
status: ok
summary: Completed using Write (1 tool call).
... (전문) ...

## Raw payload
\`\`\`json
{ "status": "ok", "tools_used": ["Write"], "files_written": [...],
  "raw_tool_calls": [...], "cost_usd": 0.0709095, ... }
\`\`\`

---
**Linked:**
- ↓ Originating task_request: [[conversations/2026-05-01/01-22-12__assistant_dm__25a3ca45]]
- ↑ DM bundle: [[dms/82b10c90/2026-05-01]]
```

#### 1.6.4 importance 자동 산정 규칙
record_message 시점에 frontmatter `importance` 를 다음 휴리스틱으로 부여:
- `critical`: kind=`system_note` AND payload.errors 비어 있지 않음
- `high`: kind=`task_result` AND files_written≥1 / 또는 content_chars > 5000 / 또는 payload.errors 비어 있지 않음
- `medium`: kind ∈ {`user_chat`, `dm`, `task_request`} (default)
- `low`: kind ∈ {`reflection`, `internal_trigger`} OR content_chars < 50

이로써 `memory_search(importance="high")` 가 의미 있는 turn 우선 반환.

#### 1.6.5 인덱싱 정책
- `_index.json` 가 conversations/ 도 다른 카테고리와 동일하게 스캔·인덱싱
- **Vector index**: `content_chars > 200` 인 conversation 만. 짧은 ack 라인은 vector 풀에 안 넣음 (검색 노이즈 방지)
- `tag_map`: `[conversation, <kind>, <counterpart_role>]` 가 자동 태깅
- `link_graph`: links_to 의 wikilinks 가 그래프에 반영됨

#### 1.6.6 보존 정책
- 영구. auto-truncate 없음.
- 디스크 압박 시 운영자가 수동 archive (시작은 N일 이전 conversations/ 를 zip 으로 외부 백업) — Phase 8 후속.
- ✗ STM 트렁케이트 같은 무음 손실 절대 없음.

### 1.7 인덱스 노트 형태 — dms/, daily journal

#### dms/<cp>/<date>.md (가벼움화됨)
```yaml
---
title: "DM with paired_subworker (82b10c90)"
category: dms
counterpart: "82b10c90-4c95-4e4f-863d-0bef73801fde"
counterpart_role: paired_subworker
date: "2026-05-01"
event_count: 2
event_ids: ["25a3ca4544db4eebaf5048433533b610", "d230c154db6443daa9ca548bb562b61b"]
tags: [dms, paired_subworker]
importance: medium
links_to:
  - "conversations/2026-05-01/01-22-12__assistant_dm__25a3ca45"
  - "conversations/2026-05-01/01-22-31__user__d230c154"
  - "entities/82b10c90"
---
# 2026-05-01 — DM with 페어드 워커 (82b10c90)

## 01:22:12 · task_request → out
> [DM to ㅍㅋ_worker (internal)]: test.txt 파일을 만들고...
[[conversations/2026-05-01/01-22-12__assistant_dm__25a3ca45|→ 본문]]

## 01:22:31 · tool_run_summary ← in
**ok** · Write × 1 · 15.5s · $0.0709
- `/data/.../test.txt`
[[conversations/2026-05-01/01-22-31__user__d230c154|→ 본문]]
```

본문은 1-line headline 만. 본문 전문은 wikilink 클릭 한 번으로 conversations/ 로 점프.

#### <YYYY-MM-DD>.md (daily journal, 가벼움화됨)
```yaml
---
title: "Day journal — 2026-05-01"
category: daily-journal
date: "2026-05-01"
event_count: 14
turn_summary:
  user_chat: 4
  task_request: 2
  task_result: 0
  tool_run_summary: 2
  reflection: 6
tags: [daily-journal]
---
# 2026-05-01

## 01:22 — paired_subworker (82b10c90)
- task_request → out: test.txt 자기소개 작성 요청
  [[conversations/2026-05-01/01-22-12__assistant_dm__25a3ca45]]
- tool_run_summary ← in: ok · Write × 1 · 15.5s · $0.07
  [[conversations/2026-05-01/01-22-31__user__d230c154]]

## 01:25 — user (gkfua00)
- user_chat: 워커한테 test.txt 만들어서 자기소개 좀 해달라고해
  [[conversations/2026-05-01/01-25-42__user__a8d9d03e]]
- assistant: 알겠어요! 워커한테 바로 부탁해볼게요
  [[conversations/2026-05-01/01-25-42__assistant__86797ca7]]

…
```

---

## 2. 5대 철학별 상세 설계

### 철학 1: 세션 대화 연결성

#### 1.1 Source of Truth = conversations/ (트렁케이트 무관해짐)
- STM 의 5000자 캡과 2000줄 캡은 **유지**해도 정보 손실이 없어짐. 이유: 모든 turn 의 full body 가 `conversations/<date>/<id>.md` 에 있음.
- STM jsonl 라인의 metadata 에 `payload.conversation_ref = "conversations/2026-05-01/01-22-12__assistant_dm__25a3ca45.md"` 박힘 → Stream 뷰에서 본문 fetch 시 이 ref 로 conversations/ 읽기.
- 결과: STM jsonl 은 fast paginated mirror, conversations/ 는 complete archive. 두 표면이 명확히 분리.

#### 1.2 Recent + Relevant 두 축 인젝션
- 현 `GenyMemoryRetriever` L0 (recent_turns) 유지 — 마지막 6턴 STM 에서 무조건 인젝션. STM 이 트렁케이트되어 있더라도 5000자 한도 안에서 충분.
- **신설 L0.5 — Relevant turns**: 현재 query 와 유사한 STM 라인 top-3
  - 1차: STM 키워드 (이미 `ShortTermMemory.search` 존재)
  - 2차 (선택): conversations/ vector index — 단, 자동 인젝션이 아닌 retrieval 시점 vector 검색 ≠ 도구 호출. 예산 5%·top-3 로 제한해 도구 호출 부담 줄여줌
- 결과 청크의 `source` 는 `recent_message` (L0) vs `recall_message` (L0.5) 로 구분 (UI/디버깅 가시성)

#### 1.3 STM 락
- `ShortTermMemory.__init__` 에 `self._lock` 추가 (asyncio + threading 둘 다 보유, 패턴은 `geny-executor/.../file/stm_store.py` 참고)
- `add_message` / `add_event` / `_append_jsonl` 모두 락 안에서 실행
- conversations/ 작성과 STM 작성이 같은 트랜잭션처럼 묶이도록 (둘 중 하나만 성공해서 일관성 깨지지 않도록)

### 철학 2: Context Compaction (executor 레벨)

#### 2.1 LLMSummaryCompactor production wiring
- `geny-executor/.../compactors.py:135` 의 `LLMSummaryCompactor` 가 `has_override + resolve_cfg + client_getter` API 노출
- Geny `agent_session.py:_build_pipeline` 에서 s02 stage compactor 슬롯에 명시 주입:
  ```python
  s02.compactor = LLMSummaryCompactor(
      keep_recent=10,
      resolve_cfg=lambda s: s02.resolve_model_config(s),
      has_override=lambda: s02._compactor_model_override is not None,
      client_getter=lambda s: getattr(s, "llm_client", None),
  )
  ```
- 트리거: 현재 [`s02 stage.py:211`](backend/../geny-executor/src/geny_executor/stages/s02_context/artifact/default/stage.py#L211) `if estimated_tokens > state.context_window_budget * 0.8` 그대로

#### 2.2 Compaction 결과 LTM 영구화 (핵심)
- 현재 compactor 는 messages 를 압축하고 `state.add_event("context.compacted", {...})` 만 발행 — 다음 세션이 못 봄.
- **신규 인터페이스**: `MemoryProvider.record_compaction(summary: str, replaced_count: int, ts: datetime, session_id: str) -> NoteRef`
- 두 곳에 동시 작성:
  - `transcripts/compactions/<ts>.md` (audit log, vault 외부)
  - `memory/compactions/<sid>__<ts>.md` (vault 내부, search 가능)
- frontmatter:
  ```yaml
  category: compactions
  session_id: <sid>
  ts: <iso>
  replaced_count: 47
  tags: [compaction, system-artifact]
  importance: medium
  ```
- summary.md 도 누적 갱신 (heading + ts)

#### 2.3 Compaction 임계 운영 (role 별)
- `agent_session.py:_tuning` dict 에 `compaction_threshold` 필드 추가
- 기본:
  - vtuber: `0.70` (짧은 응답이 잦으니 보수적으로)
  - worker / developer / researcher / planner: `0.85` (긴 분석을 살리는 게 더 중요)
- LLM 호출 비용 가드: `max_compactions_per_session` (기본 5)

#### 2.4 conversations/ ↔ compaction 의 관계
- compaction 은 STM messages 를 압축하지만, conversations/ 는 **그대로 남음** (compaction 이 conversations/ 를 건드리지 않음).
- 이유: compaction 의 목적은 "다음 LLM 호출의 컨텍스트 부담 줄이기" 이지, "기록 삭제" 가 아님. SoT 는 영구 보존.
- 미래의 어떤 세션이라도 `memory_search` / `memory_with` 로 옛 conversations/ 를 그대로 읽을 수 있음.

### 철학 3: LTM 완벽 관리 + Obsidian 가시성

#### 3.1 frontmatter `linked_from` 영속화
- 노트 한 장 갱신 → 그 노트가 가리키는 다른 노트들의 `linked_from` frontmatter 동기화 필요
- 비용 vs 정합성 트레이드오프:
  - **즉시 반영**: O(out_links) read-modify-write per save. 한 노트 평균 3-5 wikilink → 매 쓰기당 3-5 추가 IO.
  - **batch 5분**: 빠른 쓰기, 하지만 그 사이 frontmatter 가 stale.
- 결정: **batch 5분** + 즉시 반영 옵션 (config flag). conversations/ 가 매 turn 생성되니 즉시 반영 시 IO 폭증 가능.
- batch 트리거: `_index.json` 갱신 hook 안에서 dirty 노트 추적 → cron-like async task 가 5분마다 처리

#### 3.2 entities/<id>.md Stats/Notes 분리
- `_render_entity_stats_body` 가 `<!-- AUTO_STATS_END -->` 마커 위쪽만 교체. 마커 아래 `## Notes` 섹션은 read-then-preserve.
- 마이그레이션: 기존 entities/*.md 는 첫 번째 stats 갱신 시 자동 마커 삽입.
- 노트 본문에 conversations/ wikilink 자동 추가:
  ```markdown
  ## Recent conversations
  - [[conversations/2026-05-01/01-22-12__assistant_dm__25a3ca45]]
  - [[conversations/2026-05-01/01-22-31__user__d230c154]]
  ```
  (이 섹션도 AUTO_STATS_END 위, 즉 자동 갱신 영역)

#### 3.3 Vault Map 자동 갱신
- `_vault_map.json` 에 캐시:
  - 카테고리별 파일수 (`{conversations: 1247, dms: 23, entities: 8, insights: 12, ...}`)
  - 태그 top-10
  - 최근 갱신 5개 (filename + title + modified)
  - `MEMORY.md` 의 첫 200자 (있다면)
- 노트 쓰기마다 batch update (성능: dirty_flag → 1초 debounce)
- 시스템 프롬프트 STATIC LAYER 가 이걸 ~500자 markdown 으로 렌더

### 철학 4: 모든 turn → LTM 자동 영구화

#### 4.1 record_message hook 확장 — 두 단계
현재 `record_message` 는 `_maybe_bootstrap_entity` 만 호출. 다음 hook 들이 그 옆에 순차 추가:

```python
def record_message(role, content, metadata=...):
    # 1. STM jsonl append
    self._stm.add_message(role, content, metadata)
    
    # 2. ★ SoT 작성 (모든 turn) ★
    self._maybe_archive_conversation(role, content, metadata)
    
    # 3. Index 갱신 — daily journal (모든 turn)
    self._maybe_append_daily_journal(role, content, metadata)
    
    # 4. Index 갱신 — DM bundle (kind 한정)
    self._maybe_archive_dm(role, content, metadata)
    
    # 5. entity bootstrap / refresh
    self._maybe_bootstrap_entity(metadata)
```

#### 4.2 conversation_archiver.py (신규 모듈)
책임:
- frontmatter 빌드 (1.6.2 의 13키)
- importance 자동 산정 (1.6.4)
- 파일명 빌드 (1.6.1)
- payload (tool_run_summary 등) 의 구조화 렌더 (1.6.3)
- linked_from 미세 동기화 — 같은 turn 안에서 dms/, daily, entities/ 가 이 conversation 을 가리키므로 batch 큐에 dirty 등록
- 락: 같은 디렉터리 (`conversations/<date>/`) 의 파일 생성은 file lock, frontmatter 빌드는 thread-safe

#### 4.3 dm_archiver.py (신규 모듈, 가벼움)
- kind ∈ {`dm`, `task_request`, `task_result`, `tool_run_summary`} 일 때만 동작
- `dms/<sanitized_cp>/<date>.md` 가 없으면 신규 작성, 있으면 read-modify-write 로 그 turn 의 1-line headline + wikilink 추가
- frontmatter `event_ids` 누적, `event_count++`
- 본문 wikilink 형식: `[[conversations/.../<file>|→ 본문]]` (별칭으로 깔끔하게)

#### 4.4 daily_journal_writer.py (신규 모듈)
- 모든 turn 마다 `<YYYY-MM-DD>.md` 의 본문 끝에 1-line headline + wikilink 추가
- frontmatter `event_count++`, `turn_summary` 의 해당 kind +1
- 시간대별 섹션 구분 (`## 01:22 — paired_subworker (82b10c90)`)

#### 4.5 Opsidian 에 Conversation 뷰 추가
- `ObsidianTabs.tsx` 에 "Conversation" 탭 추가
- 두 sub-view 토글:
  - **Notes** view: `memory/conversations/` + `memory/dms/` 트리. 클릭 시 markdown 렌더 (NoteViewer 재사용).
  - **Stream** view: 기존 `StreamTab` 통째 임베드 (sessionId props 표준화 필요).
- Stream → Notes 점프: Stream 의 event 행 클릭 → modal 안에 "Open in vault: [[conversations/...]]" 링크 → Notes view 로 전환 + 해당 파일 자동 선택
- Notes → Stream 점프: conversation 노트의 frontmatter `event_id` → "Show in stream" 버튼 → Stream view 로 점프 + event open

### 철학 5: TOOL 기반 진행적 공개

#### 5.1 Path A 폐기
- [`agent_session_manager.py:421-461`](backend/service/executor/agent_session_manager.py#L421-L461) 의 memory_context 부착 블록 삭제
- `build_memory_context` (sync) + `build_memory_context_async` (dead) 둘 다 `@deprecated` → 다음 PR 에서 제거

#### 5.2 Path B 슬림화
GenyMemoryRetriever 6 레이어 → 4 레이어:
- L0 recent_turns (STM 에서, 유지)
- L0.5 relevant_turns (신설, 철학 1.2)
- L1 session_summary (compaction 결과, 유지)
- L2 vault_map (신설, ~500자)
- ✗ MEMORY.md 본문 → 도구 (`memory_read("MEMORY.md")`)
- ✗ vector top-k → 도구 (`memory_search`)
- ✗ keyword recall → 도구 (`memory_search`)
- ✗ backlink, curated → 도구

매 턴 자동 인젝션 ~3KB 이내. 나머지는 Agent 가 도구로 펼침.

#### 5.3 Memory Ladder doc — 모든 role 프롬프트 공통
신규 파일 `prompts/templates/memory_ladder.md`:

```markdown
## Recalling Your Memory

도구로만 메모리에 접근하세요. 시스템 프롬프트엔 본문이 들어 있지 않습니다.

### 빠른 점검
1. `memory_status(category?, tag?)` — vault 카테고리·태그·최근 갱신 요약. 어디부터 볼지 결정용.

### 검색 → 읽기
2. `memory_search(query, category?, kind?, counterpart?, limit?)`
   — 후보 filename·점수·1-line snippet 만 반환. 본문 없음.
   카테고리 권장:
   - `conversations` — 특정 turn 의 verbatim 본문 (가장 정확)
   - `dms` — 카운터파트별 일일 묶음 인덱스
   - `insights` — LLM 이 distill 한 정제 지식
   - `topics` / `MEMORY` / `projects` — 사람이 작성한 narrative
3. `memory_read(filename)` — 본문 전체 읽기. step 2 결과의 filename 을 그대로 전달.

### 카운터파트 / Stream 탐색
4. `memory_with(counterpart, kinds?, limit?, since?)` — 카운터파트별 InteractionEvent 리스트.
5. `memory_event(event_id)` — 특정 이벤트의 raw payload + linked parent.
6. `memory_artifact(event_id, path)` — 그 이벤트가 만든 파일의 raw 내용.

### 쓰기 / 정리
7. `memory_write(title, content, category?, tags?)` — 새 노트 작성. category 는 보통
   `topics` / `projects` / `insights`. **conversations 는 자동이라 직접 쓰지 않습니다.**
8. `memory_link(source, target)` — wikilink 추가.
9. `memory_distill(counterpart, update_note?)` — 카운터파트의 conversations/ 를 LLM 으로
   요약 → entities/<id>.md 갱신 (옵션) 또는 insights/<slug>.md 작성.

### 원칙
- 본문이 필요하다 싶을 때만 `read` 하세요. 그 전엔 `status`/`search` 로 지도만.
- `conversations/` 는 leaf SoT 입니다 — 어떤 turn 의 정확한 글자가 필요하면 거기를 보세요.
- `dms/`, `daily journal`, `entities/` 는 인덱스이고 본문은 conversations/ 에 있어요.
- `insights/` 는 distill 된 결론입니다 — 정확한 사실은 conversations/ 가 정답.
```

#### 5.4 Memory Ladder import — 5개 role 프롬프트
- `prompts/vtuber.md` — 기존 ladder 섹션을 import 로 교체
- `prompts/worker.md` — 신규 추가
- `prompts/developer.md` — 신규 추가
- `prompts/researcher.md` — 신규 추가
- `prompts/planner.md` — 신규 추가

(런타임에 `{{include: templates/memory_ladder.md}}` 같은 minimal templating, 또는 build-time concatenation 중 택 1)

#### 5.5 도구 응답 스키마 통일
**`memory_search` 응답:**
```json
{
  "results": [
    {
      "filename": "conversations/2026-05-01/01-22-12__assistant_dm__25a3ca45.md",
      "title": "[task_request → 82b10c90] test.txt 만들고 자기소개...",
      "category": "conversations",
      "kind": "task_request",
      "counterpart": "82b10c90...",
      "ts": "2026-05-01T01:22:12+09:00",
      "score": 1.42,
      "tags": ["conversation", "task_request", "paired_subworker"],
      "importance": "medium",
      "char_count": 287,
      "snippet_first_line": "[DM to ㅍㅋ_worker (internal)]: test.txt 파일을..."
    },
    ...
  ],
  "count": 5,
  "more_available": true,
  "next_offset": 5
}
```

본문은 절대 안 옴. `memory_read(filename)` 으로 명시적으로 가져와야 함.

**`memory_status` 응답** (Vault Map 의 도구판):
```json
{
  "categories": {
    "conversations": {"files": 1247, "last_modified": "2026-05-01T01:22:31+09:00"},
    "dms": {"files": 23, "last_modified": "..."},
    "entities": {"files": 8, "last_modified": "..."},
    "insights": {"files": 12, "last_modified": "..."},
    "topics": {"files": 7, "last_modified": "..."},
    "MEMORY": {"chars": 2300, "last_modified": "..."}
  },
  "top_tags": [["conversation", 1247], ["paired_subworker", 132], ...],
  "recently_modified": [
    {"filename": "...", "title": "...", "modified": "..."},
    ...
  ]
}
```

---

## 3. 단계별 구현 (Phase Plan)

각 Phase 는 **자체 종결적**(self-contained, mergeable) — 도중에 stop 해도 깨지지 않음.

### Phase 0 — 안전망 (PR 0)
- **목적**: 변경 전후 동일 시나리오 동작 비교 가능하게
- 시나리오 fixture: VTuber + Sub-Worker 1 쌍, 사용자 ↔ VTuber 5턴, VTuber ↔ Sub-Worker 3턴, 1턴은 5000자 초과 의도
- before snapshot: `memory/`, `transcripts/session.jsonl`, system prompt dump
- assertion 도구: `tests/integration/test_memory_v2_parity.py` 가 모든 후속 phase 회귀 검증

### Phase 1 — conversations/ SoT 도입 (PR 1, 2, 3)

- **PR 1: conversations/ 카테고리 인프라**
  - `service/memory/conversation_archiver.py` 신규 — frontmatter 빌더, 파일명 빌더, importance 산정, payload 렌더
  - `service/memory/structured_writer.py` 의 `VALID_CATEGORIES` 에 `conversations` 추가
  - `geny-executor/.../file/layout.py` 의 `NOTE_CATEGORIES` 에도 동기 추가
  - 단위 테스트: frontmatter 13키 round-trip, importance 휴리스틱 8 케이스

- **PR 2: record_message → conversations/ 자동 작성**
  - `manager.py:record_message` 안에 `_maybe_archive_conversation` hook 호출
  - STM jsonl 라인 metadata 의 `payload.conversation_ref` 박힘
  - 락: `conversations/<date>/` 디렉터리 파일 생성에 file lock (per-session lock manager)
  - **STM 캡 5000자 / 2000줄 그대로 유지** — 정보 손실 없음 (conversations/ 가 SoT)
  - **검증**: Phase 0 시나리오 후 `conversations/2026-05-01/` 에 turn 수만큼 파일 존재, 5000자 초과 turn 의 본문 전체 보존

- **PR 3: STM 락**
  - `ShortTermMemory` 에 asyncio + threading lock 추가
  - `add_message` / `add_event` 락 보호
  - 동시성 테스트: 100 concurrent record_message → STM 라인 100개 + conversations/ 파일 100개 (깨진 라인 0)

### Phase 2 — Index 카테고리 (dms, daily journal) + Opsidian 뷰 (PR 4, 5, 6)

- **PR 4: dms/ + daily journal index 자동 작성**
  - `service/memory/dm_archiver.py` 신규
  - `service/memory/daily_journal_writer.py` 신규
  - `manager.py:record_message` 안에 두 hook 호출
  - 본문은 1-line headline + `[[conversations/...]]` wikilink 만 (본문 중복 X)
  - **검증**: 시나리오 후 `dms/<cp>/2026-05-01.md` + `2026-05-01.md` 가 모두 conversation 파일들을 wikilink 로 가리킴

- **PR 5: Opsidian 에 Conversation 탭 추가**
  - `ObsidianTabs.tsx` 에 "Conversation" 추가
  - `ConversationView.tsx` 신규 — Notes ↔ Stream sub-view 토글
  - Stream → Notes 점프 핸들러 (modal 안 wikilink → vault 점프)
  - Notes → Stream 점프 (conversation frontmatter event_id → stream open)
  - `StreamTab.tsx` 의 sessionId 를 props 로 받도록 표준화

- **PR 6: 카운터파트 fallback + Conversation 메타 인덱싱**
  - sender_agent resolution 실패 시 PEER 처리되던 path 보강
  - "unknown" counterpart 가 Conversation 사이드바에 별도 카드
  - `_index.json` 가 conversations/ 의 frontmatter 13키 모두 인덱싱

**검증**: Phase 0 시나리오 종료 후 Opsidian Conversation 탭에서 Notes/Stream 두 뷰 모두 같은 turn 들을 보여주고, 클릭으로 상호 점프

### Phase 3 — Compaction 영구화 (PR 7, 8)

- **PR 7: LLMSummaryCompactor wiring**
  - `agent_session.py:_build_pipeline` 에서 s02 stage compactor 슬롯 주입
  - role 별 임계: vtuber 0.70 / 그 외 0.85
  - `max_compactions_per_session` 가드 (기본 5)

- **PR 8: Compaction 결과 LTM 영구화**
  - `MemoryProvider.record_compaction(...)` 인터페이스 추가
  - `transcripts/compactions/<ts>.md` (audit) + `memory/compactions/<sid>__<ts>.md` (vault) 동시 작성
  - summary.md 누적 갱신
  - `compactions` 도 `VALID_CATEGORIES` 에 추가

**검증**: 50턴 시뮬레이션 → compaction 1회 발생 → 새 세션 시작 후 `memory_search("이전 세션", category="compactions")` 호출 → 그 노트 반환됨

### Phase 4 — Path A/B 슬림화, Vault Map (PR 9, 10, 11)

- **PR 9: Vault Map 빌더**
  - `MemoryIndexManager.build_vault_map() -> dict` 신규
  - `_vault_map.json` 자동 갱신 (note write hook → 1초 debounce → batch save)
  - 시스템 프롬프트 STATIC LAYER renderer

- **PR 10: GenyMemoryRetriever 슬림화**
  - 기존 6 레이어 → 4 레이어 (recent + relevant + summary + vault_map)
  - vector / keyword / backlink / curated 자동 인젝션 제거
  - 도구 호출 path 만 유지

- **PR 11: Path A 폐기**
  - `agent_session_manager.py:421-461` memory_context 부착 블록 삭제
  - `build_memory_context` / `build_memory_context_async` deprecated mark
  - 차후 PR 에서 함수 자체 제거

**검증**: 시스템 프롬프트 dump 비교 — MEMORY.md 본문이 들어가지 않고, Vault Map 섹션이 그 자리

### Phase 5 — Memory Ladder + 도구 응답 스키마 (PR 12, 13, 14)

- **PR 12: prompts/templates/memory_ladder.md 추가**
  - 단일 source-of-truth ladder 문서 (5.3 본문)
  - `vtuber.md` 의 § "Recalling Your Memory" 도 import 로 교체

- **PR 13: worker/developer/researcher/planner 에 ladder import**
  - 4개 role 프롬프트의 적절한 위치에 `## Recalling Your Memory` 삽입

- **PR 14: 도구 응답 schema 통일**
  - `memory_search` / `memory_list` / `memory_status` / `memory_with` 모두 lite payload (filename + meta + score + 1-line snippet) 만
  - 본문 fetch 는 `memory_read` / `memory_event` / `memory_artifact` 단독 책임
  - 스키마 unit test

**검증**: Worker agent 가 "지난 비슷한 task" 를 찾아야 하는 시나리오 → memory_status → memory_search → memory_read chain 이 LLM trace 에 등장

### Phase 6 — LTM 무결성 (PR 15, 16)

- **PR 15: frontmatter linked_from 영속화 (batch 5분)**
  - `_index.json` 갱신 시점에 dirty 노트 추적
  - 별도 async task 가 5분마다 dirty 노트의 `linked_from` frontmatter 동기화
  - 즉시 반영 옵션 flag (대량 IO 우려 시 OFF)

- **PR 16: entities/<id>.md Stats/Notes 분리 + Recent conversations 섹션**
  - `_render_entity_stats_body` 가 `<!-- AUTO_STATS_END -->` 마커 위만 교체
  - 사람이 손으로 쓴 `## Notes` 섹션 보존
  - 자동 영역에 `## Recent conversations` (최근 conversations/ 5개 wikilink)
  - 마이그레이션: 기존 entities/*.md 첫 갱신 시 자동 마커 삽입

**검증**: 손으로 entities/<id>.md `## Notes` 에 한 줄 추가 → 다음 record_message → 그 줄 보존

### Phase 7 — Sub-Worker Inheritance 정책 (PR 17, 18)

- **PR 17: spec 결정**
  - 옵션:
    - (a) 공유 vault: paired 세션 쌍이 같은 디스크 디렉터리 공유
    - (b) read-only inheritance: Sub-Worker retriever 가 paired_vtuber 의 LTM 도 읽음
    - (c) 명시적 import: VTuber 가 task_request payload 에 LTM 발췌 박아 보냄
  - cycle 20260430_2 invariant 3 ("도구는 자기 세션의 메모리만 본다") 와의 충돌 정리
  - 운영자 vs agent 모드 구분

- **PR 18: 구현**
  - 결정에 따라 retriever / 도구 / persona 변경

(Phase 7 정책 PR 이라 7 자체로 stop OK — 1~6 만 머지돼도 일관 동작)

### Phase 8 — 운영 도구 (선택, PR 19+)

- conversations/ 디스크 사용량 모니터링
- N일 이전 conversations/ archive 도구 (zip + 외부 백업)
- 디스크 압박 시 자동 archive 정책

---

## 4. PR 의존 그래프

```
PR0 (fixture) ─┐
               │
               ├→ PR1 (conversations/ infra)
               │     ↓
               │   PR2 (record→conversations) ─┐
               │     ↓                          │
               │   PR3 (STM lock)               │
               │                                │
               ├──────────────────────────────→ PR4 (dms+daily index)
               │                                  ↓
               │                                PR5 (Opsidian Conv tab)
               │                                  ↓
               │                                PR6 (counterpart fallback)
               │
               ├→ PR7 (compactor wire) → PR8 (compaction LTM)
               │
               ├→ PR9 (Vault Map) → PR10 (retriever slim) → PR11 (path A 폐기)
               │
               ├→ PR12 (ladder doc) → PR13 (ladder import) → PR14 (tool schema)
               │
               └→ PR15 (linked_from) — PR16 (entities split) — 독립 병렬
                                                         │
                                                         └→ PR17 → PR18 (정책)
```

PR1 → PR2 → PR3 → PR4 가 critical path. PR9 / PR12 / PR15 는 PR4 이후 병렬 가능.

---

## 5. 영향 받는 모듈 (변경 표면 카탈로그)

### Backend (Geny)
| 파일 | 변경 |
|---|---|
| `service/memory/conversation_archiver.py` | **신규** — leaf SoT writer |
| `service/memory/dm_archiver.py` | **신규** — DM bundle index writer |
| `service/memory/daily_journal_writer.py` | **신규** — daily journal index writer |
| `service/memory/short_term.py` | 락 추가, conversation_ref 박기 |
| `service/memory/manager.py` | record_message 에 4개 hook 통합 (archive_conversation / append_daily_journal / archive_dm / bootstrap_entity) |
| `service/memory/dedupe_strategy.py` | 5000자 캡 유지 (정보 손실 없음 — conversations/ 가 SoT). conversation_ref 만 metadata 에 박힘 |
| `service/memory/structured_writer.py` | `VALID_CATEGORIES` 에 `conversations`, `compactions` 추가, `linked_from` frontmatter 동기화 hook |
| `service/memory/index.py` | conversations/ 인덱싱, vault_map 빌더, batch dirty queue |
| `service/memory/entity_bootstrap.py` | Stats/Notes 마커, Recent conversations 섹션 |
| `service/executor/agent_session.py` | LLMSummaryCompactor wiring, role별 compaction 임계, max_compactions 가드 |
| `service/executor/agent_session_manager.py` | path A 부착 블록 제거 |
| `tools/built_in/memory_tools.py` | response schema 통일 (snippet 첫 줄만) |
| `tools/built_in/memory_inspect_tools.py` | conversations/ 카테고리 인지, conversation_ref 따라가기 |
| `prompts/templates/memory_ladder.md` | **신규** |
| `prompts/{worker,developer,researcher,planner,vtuber}.md` | ladder import |

### Backend (geny-executor)
| 파일 | 변경 |
|---|---|
| `memory/retriever.py` (GenyMemoryRetriever) | 6레이어 → 4레이어, relevant_turns·vault_map 신설 |
| `memory/provider.py` | `record_compaction` 인터페이스 추가 |
| `memory/providers/file/provider.py` | record_compaction 구현, conversations/compactions 카테고리 인지 |
| `memory/providers/file/layout.py` | `NOTE_CATEGORIES` 에 `conversations`, `compactions` 추가 |
| `stages/s02_context/artifact/default/strategies.py` | ProgressiveDisclosureStrategy placeholder 보강 |

### Frontend (Geny)
| 파일 | 변경 |
|---|---|
| `components/obsidian/ObsidianTabs.tsx` | "Conversation" 탭 추가 |
| `components/obsidian/ConversationView.tsx` | **신규** — Notes/Stream sub-view 토글 |
| `components/tabs/memory/StreamTab.tsx` | sessionId props 표준화 (재사용 위해) |
| `components/obsidian/RightPanel.tsx` | STM Entries 클릭 → Conversation 점프 |
| `components/tabs/MemoryTab.tsx` | conversations/, compactions/ 카테고리 트리 노드 |
| `components/obsidian/SearchPanel.tsx` | category 필터에 conversations 추가 |
| `components/knowledge-graph/UnifiedGraphView.tsx` | conversations/ 노드의 색상·표시 정책 (대량) |

---

## 6. Risk & Migration

### 6.1 Risk
| 위험 | 발생 시점 | 완화 |
|---|---|---|
| **conversations/ 디스크 사용량 폭증** | PR2 직후 — 매 turn 1 파일 | 평균 turn 2KB · 일 100 turn = 200KB/day · 1년 = 73MB. 1세션 단위로는 허용. 다세션·다년 시 Phase 8 archive |
| **conversations/ 파일 수 폭증으로 _index.json 갱신 느려짐** | PR2 직후 | dirty queue + 1초 debounce + batch save (PR9 선행 작업으로 흡수) |
| **Obsidian 데스크톱이 conversations/<date>/ 트리에서 느려짐** | 운영 중 | daily 서브폴더로 이미 분할됨. 1일당 ~100 파일 수준이면 Obsidian 정상 동작 |
| **wikilink 과다로 _index.json link_graph 폭증** | PR4 이후 | conversations → dms / daily / entities 의 3-방향 link 만 표준 — 그래프 차수 일정. UnifiedGraphView 는 conversations 노드 기본 hide + filter on demand |
| **LLMSummaryCompactor 비용 폭증** | PR7 직후 | role별 임계 + max_compactions/session=5 |
| **frontmatter linked_from batch 가 git diff 폭발** | PR15 | batch 5분 + git ignore 옵션 (운영 vault 가 git 관리되면 hooks 이탈) |
| **Path A 폐기 후 agent 가 MEMORY.md 본문 못 찾음** | PR11 | Vault Map 에 MEMORY.md 의 첫 200자 + ladder doc 의 명시적 instruction |
| **Sub-Worker 가 paired VTuber LTM 못 봐서 task 실패** | PR10 후 | Phase 7 정책 결정 전까지 옵션 플래그로 path A 잔존 가능 (rollout gate) |
| **conversations/ 파일명 충돌** (같은 초에 2 turn) | 드물지만 가능 | event_id_8 충돌 시 event_id_12 로 확장 fallback (collision 시점에 detect) |

### 6.2 Migration

**기존 운영 세션 호환성:**
- conversations/, dms/, compactions/ 가 없어도 쓰기 path 가 자동 생성
- entities/<id>.md 는 첫 stats 갱신 시 자동 마커 삽입
- STM jsonl 의 옛 라인 (conversation_ref 없음) 은 retriever 가 그대로 무시 — recent_turns 는 STM 에서, full body 가 필요하면 도구가 STM 라인의 ts·event_id 로 검색 fallback
- 일관성 reconcile 도구 옵션: `migrate_legacy_session(sid)` — 기존 STM jsonl 의 모든 라인을 conversations/ 로 백필 (옵션, 명시적 호출)

**진행 중 세션 영향:**
- PR 머지 후 다음 record_message 부터 새 동작
- 진행 중 세션의 STM 라인은 그대로 — conversations/ 에는 PR 머지 후 turn 만 들어감 (이전 turn 은 백필 안 함, 옵션)

### 6.3 Rollout 게이트
- PR1~3 머지 후 1주 운영 → conversations/ 디스크 사용량 모니터, STM 락 안정성 측정
- PR4~6 머지 후 1주 → DM/daily 인덱스 정확성, Conversation 뷰 UX 검증
- PR7~8 머지 후 2주 → compaction 비용 측정 + 신규 세션의 검색 가능성 검증
- PR9~14 머지 후 1주 → progressive disclosure 도구 호출 trace (agent 가 진짜로 search → read 체인을 쓰는지)
- PR15~16 → 정합성
- PR17~18 → 정책

---

## 7. 검증 가능한 성공 기준

| # | 기준 | 측정 방법 |
|---|---|---|
| 1 | 모든 turn 이 conversations/ 에 1 파일로 보존 | Phase 0 시나리오 후 `find memory/conversations/ -name "*.md" \| wc -l` == STM jsonl 라인 수 |
| 2 | 5000자 초과 turn 의 본문 100% 보존 | Phase 0 fixture 의 긴 응답 turn → conversations/ 파일의 content_chars frontmatter 가 원본 길이와 일치 |
| 3 | DM 1턴 → dms/<cp>/<date>.md 자동 생성 + wikilink 정확 | 파일 존재 + frontmatter event_ids 일치 + 본문 wikilink 가 실제 conversations/ 파일을 가리킴 |
| 4 | Compaction 1회 → 새 세션이 그 결과를 memory_search 로 찾을 수 있음 | 50턴 시뮬레이션 후 신규 세션 → `memory_search("이전 세션", category="compactions")` |
| 5 | Vault Map 만 시스템 프롬프트에 들어감 (MEMORY.md 본문 X) | system prompt dump 의 길이·내용 비교 |
| 6 | Worker agent 가 memory_status → memory_search → memory_read chain 자발 호출 | LLM trace 에 시퀀스 등장 |
| 7 | Obsidian 데스크톱이 memory/ 폴더 그대로 vault 로 열림, conversations/ 트리·dms/ 트리 가시 | 수동 검증 + linked_from 패널이 채워짐 + 그래프에서 conversations ↔ dms ↔ entities 삼각관계 시각화 |
| 8 | 동시 record_message 100개 → STM 100라인 + conversations/ 100파일 (깨진 0) | 동시성 테스트 |
| 9 | conversations/ 의 frontmatter 13키 round-trip 무손실 | parse → render → parse 동등성 unit test |
| 10 | importance 휴리스틱이 8 케이스에서 의도대로 분류 | unit test |

---

## 8. 후속 검토 항목

1. **운영 환경에서 vector_memory 가 실제 켜지는가?** Phase 0 fixture 작성 시 함께 점검. `initialize_vector_memory()` 호출 path 가 미상이면 PR 분리.
2. **conversations/ 의 vector indexing 임계 (200자) 검증** — 짧은 ack 라인이 검색 노이즈인지, 정작 짧지만 의미 있는 라인이 누락되는 건 아닌지 운영 trace 측정.
3. **DM 의 자정 경계** — 한 대화가 23:59 ↔ 00:01 에 걸치면 dms/ 가 두 파일로 갈리는데, UI 에서 묶어 보여줄 필요 (Phase 5 옵션).
4. **`memory_link` 도구가 wikilink 본문 삽입 + frontmatter `links_to` 동기화 두 경로 모두 통일되는가?** Phase 6 에서 정리.
5. **`build_memory_context_async` 의 dead 여부 재확인** — Phase 4 에서 정리.
6. **Sub-Worker 가 VTuber 의 system prompt 일부를 받는 wiring 이 다른 곳에 숨어 있는가?** PersonaProvider.append_context, set_static_override 추적 필요.
7. **카테고리 우선순위가 retrieval / 도구 응답에서 일관되는가** — vault_map 표시 순서 / memory_status 카테고리 정렬 / memory_search 동점 시 tie-break 등.
8. **conversations/ 의 사람 직접 편집 정책** — Obsidian 에서 사람이 conversation 본문을 수정하면 SoT 가 변하는데, 이를 허용할지 `read-only` 마커를 둘지.

---

## Appendix A — 단일 페이지 다이어그램

```
                     ┌──────────────────┐
                     │  Agent Prompt    │
                     │ (Static Layer)   │
                     │                  │
                     │ • Persona        │
                     │ • Tools          │
                     │ • Memory Ladder  │  ← prompts/templates/memory_ladder.md
                     │ • Vault Map      │  ← _vault_map.json (~500 chars)
                     └────────┬─────────┘
                              │
                  every turn  ▼
                     ┌──────────────────┐
                     │  s02 Context     │  ← LLMSummaryCompactor
                     │  (Dynamic Layer) │  ← compaction → memory/compactions/...
                     │                  │
                     │ • recent_turns   │  (STM 에서)
                     │ • relevant_turns │  (STM keyword/vector)
                     │ • session_summary│
                     │ • vault_map      │
                     │ • (no bodies)    │
                     └────────┬─────────┘
                              │
            on demand only    ▼
            ┌────────┬────────┬────────┬────────┐
            │ search │  read  │  with  │  event │      ← Tool calls
            │  list  │  link  │  write │artifact│        (Progressive
            │ status │ distill│  …     │   …    │         Disclosure)
            └────────┴────────┴────────┴────────┘
                              │
                  reads from  ▼
            ┌─────────────────────────────────────────────────────────┐
            │       memory/  (Obsidian vault)                          │
            │                                                          │
            │  ★ LEAF (source of truth) ★                              │
            │  • conversations/<date>/<id>.md  ← 1 turn 1 file        │
            │                                                          │
            │  INDEX (no body, only wikilinks)                         │
            │  • dms/<cp>/<date>.md            ← per-counterpart day  │
            │  • <YYYY-MM-DD>.md               ← daily journal        │
            │  • entities/<id>.md              ← Stats / Notes split  │
            │                                                          │
            │  DERIVED                                                 │
            │  • insights/<slug>.md            ← LLM distill          │
            │                                                          │
            │  CURATED (manual)                                        │
            │  • MEMORY.md, topics/, projects/, daily/                │
            │                                                          │
            │  ARTIFACT                                                │
            │  • compactions/<sid>__<ts>.md                            │
            │                                                          │
            │  SYSTEM                                                  │
            │  • _index.json, _vault_map.json                          │
            └─────────────────────────────────────────────────────────┘
                              ▲
                  writes from │
            ┌─────────────────────────────────────────────────────────┐
            │  record_message (single writer)                          │
            │     ├ STM jsonl append (캡 유지, fast mirror)            │
            │     ├ ★ conversations/ 1 turn 1 file (SoT) ★            │
            │     ├ daily journal 인덱스 갱신                          │
            │     ├ dms/ 인덱스 갱신 (kind 한정)                       │
            │     └ entity_bootstrap (Stats / Recent conv 섹션)        │
            │                                                          │
            │  s02 compactor                                           │
            │     └ memory/compactions/<sid>__<ts>.md                  │
            │                                                          │
            │  명시적 도구 (memory_write / memory_distill)             │
            │     ├ topics/, projects/, insights/, …                   │
            │     └ MEMORY.md                                          │
            └─────────────────────────────────────────────────────────┘
```

---

## Appendix B — "한 줄 약속"

> **모든 turn 은 `memory/conversations/` 에 1 파일 1 turn 으로 영구 보존된다. 어떤 캡, 어떤 트렁케이트, 어떤 compaction 도 그 본문을 건드리지 않는다.**
>
> **다른 모든 카테고리 — `dms/`, `daily journal`, `entities/`, `insights/`, `compactions/`, `MEMORY.md`, `topics/` — 는 그 leaf SoT 를 가리키는 인덱스, 또는 그 위에 사람·LLM 이 쌓은 derived/curated layer 다.**
>
> **시스템 프롬프트엔 본문이 더 이상 자동으로 들어가지 않는다. 들어가는 것은 "지도" 와 "최근" 뿐이다. Agent 가 필요할 때 도구로 펼친다.**
>
> **Obsidian 데스크톱은 그 vault 를 그대로 읽는다. 두 표면이 동일 데이터를 다른 각도로 보여준다 — Stream 은 빠른 타임라인, Notes 는 깊은 본문.**

---

## Appendix C — v1 → v2 변경 요약 (참고용)

| v1 | v2 | 이유 |
|---|---|---|
| 5000자 cap **제거** | 5000자 cap **유지** | conversations/ 가 SoT 라 STM 캡 무관해짐. STM 은 fast mirror 역할만. |
| 긴 응답 → `insights/<slug>.md` | 모든 turn → `conversations/<date>/<id>.md` | "긴 것만" 이 아니라 "전부" leaf 보존. insights/ 는 derived 영역으로 의미 순화. |
| `dms/` 본문에 turn 블록 누적 | `dms/` 는 wikilink 인덱스만 | 본문 중복 제거. SoT 단일화. |
| `record_execution` 자동 호출 (긴 응답 시) | `record_execution` 안 부름 — conversation_archiver 가 SoT, insights 는 별도 reflection 사이클 | 경로 단순화. record_execution 은 deprecated 후보. |
| Phase 1 PR 2개 | Phase 1 PR 3개 (인프라/쓰기/락 분리) | 변경 폭이 커서 reviewable 하게 쪼갬 |
| Phase 2 PR 3개 | Phase 2 PR 3개 (dm/daily 통합 + 뷰 + fallback) | dm + daily 가 같은 패턴이라 한 PR 에 묶음 |
| 카테고리 표 X | 카테고리 매트릭스 § 1.5 | SoT/Index/Derived/Curated/Artifact 5분류로 의미 명료화 |
| `_index.json` 갱신 정책 모호 | dirty queue + 1초 debounce + 5분 batch | conversations/ 폭증 대응 |
| 다이어그램의 vault 박스 5줄 | 5분류로 정리 | 카테고리 매트릭스와 일관 |
