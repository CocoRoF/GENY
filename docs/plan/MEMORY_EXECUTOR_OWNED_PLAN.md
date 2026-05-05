# 메모리 시스템 — geny-executor 권위 일원화 plan

> 작성: 2026-05-05 · 사용자 철학 확정 직후.
>
> **사용자 결정**: geny-executor 가 강력한 메모리 로직을 stage 2 (불러오기) 와
> stage 18 (저장) 에서 **완벽하게 보유**한다. Geny 는 그 로직을 받아 쓰면서
> 필요 시 hook 으로 커스텀한다.
>
> **버려지는 것**: thin adapter 파일 (Geny 의 `short_term.py`, `long_term.py`,
> `index.py`, `structured_writer.py`, `conversation_archiver.py`,
> `dm_archiver.py`, `vector_memory.py`, `frontmatter.py`,
> `compaction_archiver.py`, `provider_bridge.py` 의 builder 외 모두).
> sync ↔ async bridge 의 cross-loop bug 도 함께.
>
> 본 문서는 **부품 카탈로그 + 보강 항목 + Geny 사용법** 의 단일 base plan.
> 다른 plan 들 (`MEMORY_THIN_ADAPTER_PLAN.md`, `P0~P3`) 은 본 plan 으로 대체.

---

## 0. 사용자 철학 (인용 그대로)

> "geny-executor 에 메모리 로직을 편입시키고 그것을 이용하도록 하자.
>  geny-executor 는 단기메모리, 장기메모리, 체계화된 문서 정리(index 를
>  이용한 계층적 구조), 점진적 공개(Progressive disclosure) 철학을 받아줄
>  수 있는 도구, 임베딩을 통한 검색, 그래프를 통한 검색 등 **강력한
>  메모리 로직을 Stage 2 와 stage 18 (저장 및 불러오기) 에서 완벽하게
>  이미 구현하고 있어야** 해.
>  그것을 geny 에서 받아와서 사용하면서, 만약 필요하다면 커스텀을 하는
>  방식으로 진행하는거고"

→ executor = 메모리 코어 (강력 + 완전한 read/write/index/embedding/graph),
   Geny = 호스트 비즈니스 (DM bundle, pin policy, VTuber LOGS, per-user vault) 만.

---

## 1. 책임 경계 매트릭스 (확정)

| 영역 | executor 가 보유 | Geny 가 보유 |
|---|---|---|
| **STM (단기 메모리)** | `transcripts/session.jsonl` jsonl append + `recent(n)` / `search(text)` / `truncate(keep_last)` / `append_event(name, data)` | (없음 — 모든 STM 호출은 provider.stm() 직접) |
| **LTM (장기 메모리)** | `MEMORY.md` main + `<YYYY-MM-DD>.md` dated + `<topic>.md` topic + `append(text, heading)` + `search(query)` + `read_main()` | (없음) |
| **Notes (구조화 노트)** | category 기반 markdown CRUD (`write` / `read` / `update` / `delete` / `link` / `list` / `load_pinned`) + frontmatter 직렬화 + wikilink 추출 + auto-vector 인덱싱 | (없음) |
| **Index (계층적 구조)** | flat root `_index.json` (executor 가 주도하는 단일 cache) + `list_categories()` + `snapshot()` + per-category sub-index sidecar (executor 신규) + vault_map 빌더/렌더 | (없음) |
| **Vector 검색 (임베딩)** | `VectorHandle.index()` / `search(text, top_k, threshold)` / `reindex()` + EmbeddingClient (OpenAI/Voyage/Google/local) | (없음) |
| **Graph 검색 (wikilink)** | `IndexHandle.graph() → NoteGraph` + 신규 `NoteGraph.neighbours/k_hop/connected_component` 헬퍼 | (없음) |
| **Progressive Disclosure** | 신규: 카테고리 → 노트 목록 → 노트 본문 → 섹션 의 4단 read API | (없음) |
| **Reflection / Auto-promote** | `provider.reflect(ctx)` + `MemoryHooks.should_*` policy callbacks + `promote()` cross-scope 이동 | (없음) |
| **Composite scope routing** | `CompositeMemoryProvider`: layer × scope (SESSION / USER / GLOBAL) routing | (없음) |
| **DM bundle bucket router** | (없음) | `MemoryHooks.after_record_turn` 콜백 안에서 Geny 가 dm 메시지 → `dms/<cp>/<date>.md` 로 ingest |
| **Conversation bucket router** | (없음) | 동일 콜백에서 Geny 가 user / system / dm / reflection 별 `conversations/<sid>__<bucket>.md` 로 분류 |
| **Pin policy** | (없음) | `MemoryHooks.should_auto_promote` 에 Geny 가 정책 주입 (importance + tag + category) |
| **VTuber LOGS panel emit** | (없음) | 동일 콜백에서 Geny 가 broadcast envelope 에 emit |
| **Per-user vault** | (없음) | Geny 가 user-scope 용 별도 `MemoryProvider` 구성, composite 의 `scope_providers[USER]` 로 등록 |
| **transcripts/summary.md** | 신규: stage 19 Summarizer 가 자동 생성 | (호출 폐기) |
| **Prompt logging (P3)** | 신규: `SessionLogger` 표면이 아닌 stage 출력 hook 으로 prompt body 캡처 | Geny 가 그것을 broadcast 로 forward |

---

## 2. geny-executor 정확 부품 카탈로그

### 2.1 Stage 2 — Context (불러오기)

위치: `src/geny_executor/stages/s02_context/`

| 부품 | 역할 |
|---|---|
| **ContextStage** | stage 본체. 3-slot: strategy + compactor + retriever |
| **strategy slot** | history 어떻게 쓸지: SimpleLoadStrategy / HybridStrategy / **ProgressiveDisclosureStrategy** (요약→세부 expand) |
| **compactor slot** | overflow 처리: TruncateCompactor / SummaryCompactor / LLMSummaryCompactor / SlidingWindowCompactor |
| **retriever slot** | 메모리 인입: NullRetriever / StaticRetriever / MCPResourceRetriever / **GenyMemoryRetriever** (legacy duck-type — §3.1 에서 generic 으로 교체) |
| **MemoryChunk** | 검색 결과 dataclass: key, content, source, relevance_score, metadata |

→ **Geny 가 직접 손대는 곳: 없음.** retriever slot 에 `MemoryAwareRetriever` (§3.1 신규) 를 끼우기만.

### 2.2 Stage 18 — Memory (저장)

위치: `src/geny_executor/stages/s18_memory/`

| 부품 | 역할 |
|---|---|
| **MemoryStage** | stage 본체. 2-slot: strategy + persistence. provider 가 attach 되면 매 turn `_drive_provider` 가 `provider.record_turn` / `record_execution` / `reflect` / `promote` 호출 |
| **strategy slot** | AppendOnlyStrategy / NoMemoryStrategy / ReflectiveStrategy (`needs_reflection` flag) / **StructuredReflectiveStrategy** (`PENDING_INSIGHTS_KEY` 큐 드레인) |
| **persistence slot** | InMemoryPersistence / FilePersistence / NullPersistence (legacy session.json — provider 와 별개. provider attach 시 NullPersistence 권장) |
| **Insight / coerce_insight / record_insight / INSIGHTS_KEY / PENDING_INSIGHTS_KEY** | 추출된 통찰의 표준 dataclass + state.metadata 큐 키 |

→ **Geny 가 직접 손대는 곳: 없음.** strategy 는 `StructuredReflectiveStrategy` 가 default.

### 2.3 메모리 코어 (`src/geny_executor/memory/`)

| 부품 | 위치 | 역할 |
|---|---|---|
| **MemoryProvider Protocol** | `provider.py` | 모든 provider 의 표준 표면 (7-handle + 5-cross-layer + lifecycle) |
| **STMHandle** | `provider.py` | append / append_event / recent / search / truncate |
| **LTMHandle** | `provider.py` | append / write_dated / write_topic / read_main / search |
| **NotesHandle** | `provider.py` | list / read / write / update / delete / link / graph / search / load_pinned |
| **VectorHandle** | `provider.py` | index / index_batch / search(top_k, threshold) / reindex / remove |
| **CuratedHandle** | `provider.py` | user_id 기반 user-scope notes/vector + promote_from_session |
| **GlobalHandle** | `provider.py` | session 간 공유 notes/vector + promote_from |
| **IndexHandle** | `provider.py` | snapshot / tag_counts / graph / rebuild / list_categories / build_vault_map / render_vault_map |
| **MemoryHooks** | `provider.py` | should_record_execution / should_reflect / should_auto_promote + after_record_turn / after_record_execution / after_note_write / after_note_update |
| **EphemeralMemoryProvider** | `providers/ephemeral.py` | 메모리 only |
| **FileMemoryProvider** | `providers/file/provider.py` | 디스크 (Geny 가 보는 형식) |
| **SQLMemoryProvider** | `providers/sql/provider.py` | sqlite/postgres |
| **CompositeMemoryProvider** | `composite/provider.py` | layer × scope routing — Geny 의 기본 |
| **EmbeddingClient (Protocol)** | `embedding/client.py` | OpenAI / Voyage / Google / local 4종 구현 |
| **GenyMemoryRetriever** | `memory/retriever.py` | **legacy duck-type retriever — §3.1 에서 generic 으로 재작성** |
| **GenyMemoryStrategy / ReflectionResolver** | `memory/strategy.py` | **legacy — §3.1 에서 generic 으로 재작성** |
| **NoteGraph** | `provider.py` | nodes + edges + neighbours(filename) helper |
| **NoteRef / NoteMeta / Note / NoteDraft / NotePatch** | `provider.py` | 노트 read/write 의 dataclass surface |

### 2.4 누락된 부품 (§3 에서 보강)

- ❌ Progressive disclosure 의 4단 expand API (카테고리 → 노트 → 섹션 → 라인 범위)
- ❌ Graph 쿼리 (k-hop / connected_component / linked_chain) — `NoteGraph.neighbours` 만 있음
- ❌ Stage 2 retriever 가 `MemoryProvider` Protocol 직접 사용 (현재는 Geny manager duck-type)
- ❌ Stage 18 strategy 가 `MemoryProvider` Protocol 직접 사용 (현재는 Geny manager duck-type)
- ❌ Stage 19 Summarizer 가 transcripts/summary.md 자동 생성 (현재 Geny 가 sync write)
- ❌ per-category sub-index sidecar (`<cat>/_index.json`) 와 root `_summary.json` 을 executor 가 주도 (현재 Geny 가 별도로 작성)
- ❌ `_FilesystemNotesStore._lock` / `_JSONLSTMStore._lock` / `_FileIndexStore._lock` 의 cross-loop 안전성

---

## 3. executor 측 보강 작업 (EXEC PR)

### EXEC-1: Stage 2 generic `MemoryAwareRetriever`

대상: `src/geny_executor/memory/retriever.py` 전면 재작성 (또는 별도 `src/geny_executor/memory/retriever_generic.py` 신설 후 `GenyMemoryRetriever` 폐기)

- 입력: `MemoryProvider` 만 (호스트 manager 의존성 제거)
- 출력: `List[MemoryChunk]`
- 6-layer 흐름:
  0. 최근 STM (`provider.stm().recent(n=recent_turns)`)
  1. session summary (`provider.ltm().read_main()` 의 첫 N자)
  2. pinned facts (`provider.notes().load_pinned(category="critical", max_chars=...)`)
  3. vault map (`provider.index().render_vault_map(category_descriptions=hooks.vault_descriptions)`)
  4. vector 검색 (`provider.vector().search(query, top_k, threshold)`)
  5. keyword 검색 (`provider.notes().search(query, ...)` + `provider.ltm().search`)
  6. backlink (graph().neighbours) 보강
- 모든 인입은 budget (`max_inject_chars`) 비례 분배
- importance boost (`critical=2.0`, `high=1.5`, …) 는 retriever 안에 박아둠
- legacy `GenyMemoryRetriever` 의 `mgr.load_pinned` / `mgr.read_note` / `mgr.vector_memory` 의존성 제거
- presets (`presets.py`) 도 동일 갱신

### EXEC-2: Stage 18 generic `ProviderDrivenStrategy`

대상: `src/geny_executor/memory/strategy.py` 재작성

- `GenyMemoryStrategy` 폐기 → `ProviderDrivenStrategy` 신설
- `provider.record_turn(turn)` / `record_execution(summary)` / `reflect(ctx)` / `promote(ref)` 만 호출
- Reflection 결과 → `MemoryHooks.should_auto_promote` 가 True 인 경우 `promote(ref, scope=USER)`
- `default_manifest` 에서 stage 18 strategy 기본값을 `ProviderDrivenStrategy` 로 교체

### EXEC-3: IndexHandle 의 4단 progressive disclosure

대상: `src/geny_executor/memory/provider.py` Protocol 확장 + 구현

```
IndexHandle:
    list_categories() -> List[CategoryEntry]    # L1: 카테고리 + file_count
    list_notes(category, *, limit, offset) -> List[NoteSummary]  # L2: 노트 목록 (요약 only)
    read_outline(filename) -> NoteOutline         # L3: 섹션 헤딩만 (markdown ## 트리)
    read_section(filename, heading) -> str        # L4: 단일 섹션 본문
```

- `NoteSummary` = filename + title + first paragraph + tags + char_count + modified
- `NoteOutline` = filename + List[OutlineNode(level, heading, line_start, line_end)]
- 호스트 (Geny LLM agent) 가 vault_map → list_notes → read_outline → read_section 으로 점진 expand 가능

### EXEC-4: Graph 쿼리 헬퍼

대상: `src/geny_executor/memory/provider.py` `NoteGraph` 확장

```
NoteGraph:
    neighbours(filename) -> List[str]            # 1-hop, 이미 존재
    k_hop(filename, k) -> List[str]              # 신규
    connected_component(filename) -> Set[str]    # 신규 (BFS closure)
    linked_chain(start, end) -> Optional[List[str]]  # 신규 (shortest path)
    notes_with_tag(tag) -> List[str]             # 신규 (tag 기반)
```

호스트 retriever 의 backlink 보강 (§EXEC-1 Layer 6) 에서 사용.

### EXEC-5: per-category sub-index + root summary 를 executor 가 주도

현재 Geny 가 `MemoryIndexManager.write_subindexes()` 로 작성 → cross-loop bug 로 빈 채. 권위 이동:

- `IndexHandle.write_hierarchical(...)` 신규 (또는 `snapshot()` 의 부산물로 자동 작성)
- root `_index.json` (flat dump) + `<cat>/_index.json` (per-category shard) + root `_summary.json` (folder tree overview) 모두 executor 가 atomic write
- `category_descriptions` 는 host 가 provider 빌드 시 주입 (`FileMemoryProvider(category_descriptions={...})`)
- Geny 의 `_CATEGORY_DESCRIPTIONS` 가 그곳으로 흘러감

→ Geny 측 `write_subindexes` / `write_root_summary` 폐기.

### EXEC-6: cross-loop safe locking

대상: `_FilesystemNotesStore._lock`, `_JSONLSTMStore._lock`, `_FileIndexStore._lock`

- 옵션 A: `asyncio.Lock` → `anyio.Lock` (loop-portable) 또는 자체 cross-loop wrapper
- 옵션 B: `asyncio.Lock` → `threading.Lock` + sync I/O (disk write 는 어차피 짧아 event loop 블락 무시 가능)
- → **옵션 B 권장**. async 위장만 풀고 sync 락. async 메서드는 그대로 두되 내부에서 `with self._lock:` (sync) 사용. 이러면 Geny 가 `run_coro_sync` 로 호출해도 worker thread loop 와 무관.

### EXEC-7: Stage 19 Summarizer → transcripts/summary.md 자동

현재 Stage 19 가 summary 를 어떻게 쓰는지 점검 후 `transcripts/summary.md` 작성을 stage 19 로 이전. Geny `auto_flush` 의 `_stm.write_summary(summary_text)` 호출 폐기.

### EXEC-8: 누락된 retriever 전체 hook surface

Stage 2 의 `MemoryAwareRetriever` 가 호스트 정책을 받기 위해:

```
MemoryHooks:
    # 기존
    should_record_execution / should_reflect / should_auto_promote
    after_record_turn / after_record_execution / after_note_write / after_note_update
    # 신규
    vault_descriptions: Dict[str, str]                  # 카테고리 라벨
    importance_boost: Dict[str, float]                  # 검색 가중치
    layer_budget_ratio: Dict[str, float]                # 6-layer 별 char budget 분배
    pin_category: str = "critical"                       # load_pinned 카테고리 명
```

→ 호스트 (Geny) 가 provider 빌드 시 `set_hooks(hooks)` 한 번으로 모든 정책 주입.

### EXEC PR 의존 그래프

```
EXEC-6 (cross-loop lock fix) ──── 독립, 우선 머지
EXEC-3 (progressive disclosure)   독립
EXEC-4 (graph queries)            독립
EXEC-8 (hook surface 확장) ───── EXEC-1 / EXEC-2 전제
EXEC-1 (generic retriever) ─┬── Geny PR 1 전제
EXEC-2 (generic strategy) ──┘
EXEC-5 (hierarchical index) ──── EXEC-3 활용
EXEC-7 (stage 19 summary)        독립
```

→ executor release: 1.19.0 (EXEC-6 hotfix), 1.20.0 (나머지).

---

## 4. Geny 측 작업 (GENY PR)

### GENY-1: `AgentSession` 이 단일 entry point

현재: `_init_memory_provider` + `_install_memory_hooks` + `_attach_provider_to_pipeline_stages` 로 provider 빌드 + hook 설치 + 스테이지 attach. 이미 단일 진입점.

추가: provider 빌드 시 host hook 주입 일원화

```
hooks = MemoryHooks(
    after_record_turn=geny_dispatch_turn,        # bucket router + DM bundle + LOGS
    after_note_write=geny_after_note_write,      # nothing? (executor 가 sub-index 자동)
    should_auto_promote=geny_pin_policy,         # importance + tag 기반
    vault_descriptions=GENY_CATEGORY_DESCRIPTIONS,
    importance_boost={"critical": 2.0, ...},
    layer_budget_ratio={"stm": 0.2, "vault": 0.1, "vector": 0.4, ...},
    pin_category="critical",
)
provider = build_memory_provider(..., hooks=hooks)
```

### GENY-2: thin adapter 일괄 폐기

다음 파일/클래스 **삭제**:

| 파일 | 이유 |
|---|---|
| `service/memory/short_term.py` | provider.stm() 직접 사용 |
| `service/memory/long_term.py` | provider.ltm() / provider.notes().load_pinned() |
| `service/memory/index.py` | provider.index() / executor 가 sub-index 자동 |
| `service/memory/structured_writer.py` | provider.notes().write() |
| `service/memory/conversation_archiver.py` | hook 안에서 provider.notes().write() 직접 |
| `service/memory/dm_archiver.py` | hook 안에서 provider.notes().write() 직접 |
| `service/memory/vector_memory.py` | provider.vector() 직접 |
| `service/memory/frontmatter.py` | executor `file/frontmatter.py` 가 주관 |
| `service/memory/compaction_archiver.py` | hook 안 또는 폐기 |
| `service/memory/sync_async_bridge.py` | run_coro_sync 자체가 cross-loop bug 의 도화선 → §GENY-3 |
| `service/memory/dedupe_strategy.py` | metadata stamp 만 남고 strategy 자체는 ProviderDrivenStrategy 로 |
| `service/memory/manager.py` `SessionMemoryManager` | provider 가 모든 read/write 권위 → 호환 wrapper 만 남기거나 폐기 |

→ controller (`memory_controller.py`) 가 `mm.list_notes()` 등을 부르는 곳은 `agent.memory_provider.notes().list()` 등으로 직접 변환. async 변환 필요 (§GENY-3).

### GENY-3: controller / FastAPI 측 async 일원화

- `/api/agents/{id}/memory/*` 엔드포인트가 이미 `async def` 인 곳은 `await provider.X()` 직접 호출.
- 동기 헬퍼 (`get_recent`, `list_notes` 등) 가 sync 인 곳은 `async def` 로 시그니처 변경 (FastAPI 가 둘 다 받음).
- `run_coro_sync` 호출 모두 제거. 남는 sync 진입점 (예: VTuber HTTP poller 의 thread) 만 `asyncio.run_coroutine_threadsafe(coro, main_loop)` 사용 (main loop 핸들 보관).
- **결과**: cross-loop bug 자연 소거. EXEC-6 의 lock 변경과 합쳐 안전.

### GENY-4: hook 안의 비즈니스 (DM bundle / conversation router / VTuber LOGS)

현재 `_on_record_turn` 안에서 `mgr._maybe_archive_conversation` / `_maybe_archive_dm` 호출 (manager 경유). 이걸 풀어 hook 안에서 직접 provider 사용:

```
async def geny_dispatch_turn(turn, receipt):
    # 1. bucket 분류
    bucket = classify_bucket(turn.role, turn.metadata)
    # 2. conversation rollup (Geny 비즈니스)
    if bucket in ("user", "system", "dm", "reflection"):
        await provider.notes().write(NoteDraft(
            category="conversations",
            filename=f"{session_id}__{bucket}.md",
            body=...,
            metadata={"geny.bucket": bucket, ...},
        ))
    # 3. DM bundle (Geny 비즈니스)
    if bucket == "dm" and turn.metadata.get("counterpart_id"):
        await provider.notes().write(NoteDraft(
            category="dms",
            filename=f"{counterpart}/{date}.md",  # 2-level subpath
            ...
        ))
    # 4. VTuber LOGS emit (Geny 비즈니스)
    if vtuber_session:
        broadcast_session_log_entry(turn)
```

→ Geny 의 `manager._maybe_archive_*` 메서드는 hook 콜백 안 closure 함수 또는 `service/hooks/geny_memory_hooks.py` 단일 파일로 모음. archiver 클래스 폐기.

### GENY-5: 운영 검증 + bug fix

- session.jsonl 에 user/assistant/dm 모두 기록 확인
- `memory/<cat>/*.md` 가 실제 노트로 채워짐 + sub-index shard 가 file_count > 0
- Opsidian sidebar 가 빈 카테고리도 노출
- vault map 이 비어있지 않음
- prompt 주입 (pinned facts + vault map) 이 system prompt 에 보임 (P3 prompt logging 으로 verify — §EXEC 외 별도)
- VTuber LOGS panel 에 모든 종류 이벤트 forward

### GENY PR 의존

```
EXEC-6 머지 → GENY hotfix 우선 (cross-loop bug 즉시 해결)
EXEC-1+EXEC-2+EXEC-8 머지 → GENY-1 (단일 entry hook 주입)
EXEC-5 머지 → GENY-2 (index.py 폐기)
EXEC-3+EXEC-4 머지 → tools (memory_search_filter 등) 가 progressive read API 채택
모두 머지 후 → GENY-2 / GENY-3 / GENY-4 (thin adapter 일괄 폐기)
GENY-5 (검증) 마지막
```

---

## 5. Cross-loop bug 처치 — 순서

1. **EXEC-6 (executor lock 변경)** 먼저 머지. 이것 하나로 운영 stuck 즉시 해소.
2. **GENY-3 (run_coro_sync 제거)** 가 그 다음. async 일원화로 root cause 자체 소거.
3. **나머지 thin adapter 폐기** (GENY-2/4) 는 그 위에서.

→ 운영자가 "씨발 또 빈 인덱스" 를 다시 안 보게 하려면 **EXEC-6 머지 후 docker rebuild** 만으로도 충분.

---

## 6. PR 시퀀스 (구체)

```
[Sprint 1 — 운영 정상화]
  PR-A1: executor EXEC-6 (cross-loop lock fix)             → 1.19.0 release
  PR-A2: Geny requirements bump >=1.19.0 + smoke           → 운영 정상 확인

[Sprint 2 — 강력한 stage 2/18 일원화]
  PR-B1: executor EXEC-1 + EXEC-2 + EXEC-8 (generic retriever / strategy / hooks 확장)
  PR-B2: executor EXEC-3 + EXEC-4 (progressive disclosure + graph queries)
  PR-B3: executor EXEC-5 + EXEC-7 (hierarchical index 권위 + stage 19 summary)
  PR-B4: executor 1.20.0 release
  PR-C1: Geny GENY-1 (단일 hook 주입)
  PR-C2: Geny GENY-2 (thin adapter 일괄 폐기 — short_term/long_term/index/structured_writer/vector_memory/frontmatter/compaction_archiver/conversation_archiver/dm_archiver/sync_async_bridge)
  PR-C3: Geny GENY-3 (controller async 일원화)
  PR-C4: Geny GENY-4 (hook 안의 Geny 비즈니스 함수)

[Sprint 3 — 검증 + 마무리]
  PR-D1: Geny GENY-5 (운영 검증 + 잔여 bug)
  PR-D2: P3 prompt logging (필요 시 별도 plan 후속)
```

---

## 7. 검증 체크리스트 (Sprint 2 끝나고)

운영자 화면에서 직접 확인할 항목:

- [ ] `<storage>/transcripts/session.jsonl` 에 user / assistant / dm 라인 모두 기록 (적어도 5+ 줄)
- [ ] `<storage>/memory/<cat>/_index.json` 의 `file_count` 가 실제 노트 수와 일치 (insights/topics/critical/conversations/dms/executions/daily/projects/compactions)
- [ ] `<storage>/memory/_index.json` 의 `total_files` > 0 + `files` dict 채워짐
- [ ] `<storage>/memory/_summary.json` 의 categories 가 실제 폴더 + 빈 폴더 모두 나옴
- [ ] `<storage>/memory/_vault_map.json` 의 `rendered` 가 `## Vault Map` 한 줄이 아니라 실제 카테고리 + 태그 + recent 포함
- [ ] Opsidian sidebar: topics / insights / projects / dms / conversations / compactions 모두 노출 (빈 폴더는 `(0)` 회색 dim)
- [ ] Opsidian sidebar 에서 한 카테고리 클릭 → 노트 목록 (sub-index shard 의 `files` 가 경유) → 한 노트 클릭 → outline → section 점진 expand (progressive disclosure)
- [ ] graph view: `[[link]]` 로 연결된 노트들 사이에 edge 표시
- [ ] vector search: 한국어 쿼리 → 비-동명 노트도 의미 검색 결과
- [ ] critical 노트가 system prompt 의 "Pinned Facts" 섹션에 매 turn 주입 (prompt logging tab 으로 검증)
- [ ] VTuber LOGS panel 에 STM append / note write / reflection / promote 이벤트 모두 forward
- [ ] `pytest backend/tests/service/memory/` 전 항목 green
- [ ] `pytest backend/tests/integration/test_memory_v2_baseline.py` green

---

## 8. 미해결 결정사항 — **사용자 답 확정 (2026-05-05)**

| # | 질문 | 사용자 답 | 적용 |
|---|---|---|---|
| **D1** | stage 19 Summarizer 의 `transcripts/summary.md` 생성 시점 | **session 종료 시점에 한번 통째로** | EXEC-7: stage 19 가 session-close 이벤트에 한 번만 전체 요약 생성. 매 turn 추가 X |
| **D2** | per-user vault root | **같은 디스크 유지** (Opsidian vault 라 어차피) | composite `scope_providers[USER]` = `FileMemoryProvider(root=<storage>/_user_opsidian/<username>)` |
| **D3** | DM bundle subpath | **`dms/<counterpart>/<date>.md` 2-level 그대로** | hook 안의 Geny 비즈니스에서 그대로 |
| **D4** | event_id / linked_event_id 같은 일반화 가능 필드 | **executor 를 확장해서 optional 필드로 처리. 일반화 어려운 것만 metadata** | EXEC-9 신설: `NoteRef` / `NoteMeta` / `NoteDraft` 에 `event_id?, linked_event_id?, kind?, direction?, counterpart_id?, counterpart_role?` optional 필드 추가. `metadata` dict 는 그 외 호스트 자유 영역 |
| **D5** | legacy `GenyMemoryRetriever` / `GenyMemoryStrategy` | **즉시 폐기** | EXEC-1/2 가 generic 으로 교체하면서 legacy 클래스 삭제. import 호환 alias 도 X |
| **D6** | sub-index sidecar 갱신 cadence | **바로바로 갱신, 효과적 로직으로 효용성 높이기** | EXEC-5: 매 note write 후 즉시. **단, 영향받은 카테고리 1개의 shard 만 부분 갱신** (전체 rebuild X). incremental write |
| **D7** | embedding provider 기본값 / extras 분리 | **executor 의 `[cron, openai]` extras 제거 → 단일 install. Geny 도 단순 `geny-executor` 만** | EXEC-10 신설: `pyproject.toml` 의 `[project.optional-dependencies]` 폐기, 모든 deps 를 `dependencies` 로 통합. Geny `pyproject.toml` / `requirements.txt` 의 `geny-executor[web,cron,openai]` → `geny-executor` 로 단순화 |

→ 본 절은 **확정**. Sprint 1 PR-A1 부터 위 결정대로 진행.

---

## 9. 본 plan 이 폐기하는 기존 plan / 분석

- `MEMORY_THIN_ADAPTER_PLAN.md` v2 — 권위 배치 (executor) 자체는 유지하지만 thin adapter 패턴 폐기. §0.2 의 plan 자체는 본 plan 이 흡수.
- `P0_FIX_HOOK_AND_ATTACH_REGRESSION.md` — 이미 머지 완료 (#684, #685). 이력 보관.
- `P1_OPERATOR_VALIDATION_CHECKLIST.md` — §7 으로 흡수.
- `P2_INDEX_HIERARCHY_AND_SIDEBAR.md` — §EXEC-5 + Geny 사이드바 GENY-5 로 흡수. Geny 측 `write_subindexes` 자체 폐기.
- `P3_PROMPT_LOGGING_AND_LOG_FORWARDING.md` — Sprint 3 별도 PR-D2.
- `MEMORY_REGRESSION_AFTER_PATH_A.md` (분석) — 회귀 진단 자체는 유효, 본 plan 의 §5 / §EXEC-6 가 처방.
- `MEMORY_DIRECTION_AUDIT_2026-05-05.md` (분석) — 본 plan 의 출발점.

---

## 10. 다음 액션

1. 사용자 본 plan 검토 + §8 (D1~D7) 답.
2. PR-A1 (EXEC-6 cross-loop lock fix) executor 측에서 즉시 작업 → 1.19.0 release.
3. PR-A2 Geny requirements bump → docker rebuild → 운영 정상 1차 확인 (session.jsonl 채워짐).
4. Sprint 2 의 PR-B1~B4 (executor) → PR-C1~C4 (Geny) 순.
5. 매 PR 머지 후 §7 체크리스트 일부 항목씩 검증.
