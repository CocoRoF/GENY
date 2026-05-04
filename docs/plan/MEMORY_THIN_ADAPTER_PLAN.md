# 메모리 시스템 Thin Adapter 전환 계획 v2

> 작성: 2026-05-04 · 사이클: Geny 메모리 layer 의 stage 18 이중 트레일 정리.
> v2 갱신: 사용자 확정 — executor 는 메모리 코어 + 자동화 전략 모두 제공. Geny 는 비즈니스만. 마이그레이션 무시.
> 진단 근거: 본 사이클의 STM/LTM/`_index.json` 충돌 보고 + 직전 사이클의 `docs/_archive/analysis/CURRENT_MEMORY_STATE_AUDIT.md`.

---

## 0. 확정 사항

1. **경로 A 채택** — GenyDedupeStrategy 트레일 폐기. executor 의 `_drive_provider` 가 STM/LTM/index 단일 쓰기 경로.
2. **executor = 메모리 코어 인프라 + 자동화 전략의 권위**:
   - STM / LTM / Notes / Vector / Index 의 CRUD
   - Embedding pipeline (OpenAI/Voyage/Google/local 단일 경로 — 이미 동작)
   - LTM-on-vector 검색 (LTMHandle.search 가 embedding 활용)
   - Auto-summarize (stage 19 Summarizer 인프라 — 이미 존재)
   - Auto-reflect (stage 18 ReflectiveStrategy + ReflectionResolver — 이미 존재)
   - Auto-promote / Compaction
   - Pinned facts 주입 (retriever 측 _load_pinned_facts)
   - Vault map 렌더 (prompt-injectable markdown — executor 로 이전)
3. **Geny = 추가 비즈니스만**:
   - agent ↔ agent DM bundle (`memory/dms/<cp>/<date>.md` — 2-level 카운터파트 디렉토리)
   - counterpart-aware conversation bucket router (`<sid>__user__<title>.md` / `<sid>__dm__<cp>.md` / `<sid>__reflection.md` / `<sid>__system.md`)
   - InteractionEvent metadata enrichment (kind/direction/counterpart_id/payload 첨부)
   - pin policy hook (어떤 메모리를 critical 카테고리로 승급할지 결정 — 카테고리 자체는 executor NotesHandle 표준 카테고리)
   - per-user vault (`_user_opsidian/<username>/`, agent 비공유)
   - VTuber LOGS panel 이벤트 emit
   - curated_knowledge / global_memory 의 비즈니스 hook
4. **마이그레이션 무시** — 기존 디스크 데이터 / DB 스키마 / file format 호환성 신경 쓰지 않음. 깔끔한 모델로 갈아엎기.
5. **executor extensibility 원칙** — 모든 stage I/O dataclass 에 `metadata: Dict[str, Any]` extension 필드. executor 는 store/pass-through 만, 절대 해석 안 함. Geny prefix `geny.*` 사용.

---

## 1. 책임 경계 매트릭스

| 영역 | 현재 (이중 트레일 살아있는 상태) | 목표 (전환 후) |
|---|---|---|
| `transcripts/session.jsonl` 쓰기 | Geny ShortTermMemory + executor STMHandle 양쪽 동시 | **executor STMHandle 단독** |
| `transcripts/summary.md` 쓰기 | Geny ShortTermMemory.write_summary | **executor stage 19 Summarizer 자동** |
| `memory/<YYYY-MM-DD>.md` append | Geny LongTermMemory.write_dated + executor LTMHandle.write_dated | **executor LTMHandle 단독** |
| `memory/executions/<YYYY-MM-DD>.md` | Geny LongTermMemory.write_execution | **executor record_execution 자동** (insights/dated 카테고리로 통합) |
| `memory/topics/<slug>.md`, `memory/projects/<slug>.md`, etc. | structured_writer → NotesHandle (PR-3a 후) | **provider.notes() 직접** (structured_writer wrapper 폐기) |
| `memory/critical/` | Geny LongTermMemory.load_pinned | **executor NotesHandle.list(category="critical")** + executor 측 helper |
| `memory/insights/<title>.md` | executor record_execution 매 턴 자동 생성 | **executor record_execution 단독, Geny pin policy hook 으로 critical 승급 결정** |
| `memory/conversations/<sid>__<bucket>.md` | Geny ConversationArchiver | **Geny ConversationArchiver** (bucket-router 비즈니스, NotesHandle 위) |
| `memory/dms/<cp>/<date>.md` | Geny DmArchiver | **Geny DmArchiver** (agent-DM 비즈니스, 2-level subpath 직접 쓰기) |
| `memory/_index.json` 쓰기 | Geny MemoryIndexManager + executor `_FileIndexStore` 양쪽 | **executor `_FileIndexStore` 단독** |
| Vault map 렌더 (system prompt 주입) | Geny render_vault_map | **executor IndexHandle.render_vault_map** (Geny 가 hook 으로 customize) |
| `memory/_vault_map.json` 캐시 | Geny | **폐기** — 매 turn 즉시 렌더 (executor 측 in-memory snapshot 활용) |
| Embedding 호출 | Geny `vector_memory` thin adapter | **executor EmbeddingClient + VectorHandle 단독** (이미 완료) |
| Reflection LLM 호출 | Geny side or no-op | **executor ReflectiveStrategy + ReflectionResolver** |
| Compaction 결정 + 실행 | Geny persisting_compactor + CompactionArchiver vault | **executor record_compaction** (Geny pin policy 가 어떤 노트를 compact 할지만 결정) |
| DB dual-write (`session_memory_entries`) | Geny `_db_write` | **폐기** — disk 가 단일 진실 (DB 미러는 운영 분석용이었으나 executor 가 자기 SQL backend 보유 → 필요 시 SQL provider 로 전환) |
| Frontmatter 렌더 | Geny `frontmatter.py` + executor `file/frontmatter.py` 양쪽 | **executor `file/frontmatter.py` 단독**, Geny `frontmatter.py` 삭제 |
| InteractionEvent metadata | Geny dedupe_strategy 가 mgr.record_message 에 직접 흘림 | **state.metadata['_pending'] → Turn.from_state_message → Turn.metadata** (EXEC-1 수정 후) |

---

## 2. executor 측 작업 (geny-executor 레포)

### 2.1 EXEC-1: dataclass metadata 필드 + Turn.from_state_message

**의도**: 모든 stage I/O 가 임의 dict 를 round-trip 시킬 수 있게 한다. Geny 의 InteractionEvent metadata 가 `Turn.metadata` 로 자연스럽게 흐른다.

**대상 dataclass** (provider.py 직접 grep 결과 기준):

이미 보유: `Turn` (line 312), `ExecutionSummary` (344), `CostEvent` (184), `BackendInfo` (151), `MemoryChunk` (line 441 추정), 외 2 개.

신규 추가:
- `NoteRef` (line 119) — scope/category 외 라우팅 hint
- `NoteMeta` (216) — read/list 결과의 metadata 라운드트립
- `Note` (231) — full read 시 보존
- `NoteDraft` (261) — `frontmatter` 와 별도. `frontmatter` = disk YAML 직렬화, `metadata` = ephemeral routing/business hint
- `NotePatch` (277) — 동일
- `NoteGraph` (290)
- `RecordReceipt` (361)
- `Insight` (381)
- `ReflectionContext` (406)
- `RetrievalQuery` (429), `RetrievalResult`
- `MemorySnapshot`, `ReindexPlan`

**핵심 수정 — `Turn.from_state_message` (provider.py:325-330):**

현재:
```python
@classmethod
def from_state_message(cls, message: Mapping[str, Any]) -> "Turn":
    return cls(role=str(message.get("role", "user")), content=message.get("content", ""))
```

변경:
```python
@classmethod
def from_state_message(cls, message: Mapping[str, Any]) -> "Turn":
    raw_meta = message.get("metadata") or {}
    return cls(
        role=str(message.get("role", "user")),
        content=message.get("content", ""),
        metadata=dict(raw_meta) if isinstance(raw_meta, Mapping) else {},
    )
```

**Namespace 규약**: `geny.interaction.*`, `geny.bucket`, `geny.importance` 등 dot-notation. executor 는 절대 해석 안 함, 단지 직렬화/역직렬화.

### 2.2 EXEC-2: MemoryHooks 확장 — `after_*` 콜백

`MemoryHooks` 에 generic post-write callback chain 추가:
```python
@dataclass
class MemoryHooks:
    # 기존
    should_record_execution: Callable[[PipelineState], bool] = ...
    should_reflect: Callable[[PipelineState], bool] = ...
    should_auto_promote: Callable[[Insight], bool] = ...
    # 신규
    after_record_turn: Optional[Callable[[Turn, RecordReceipt], Awaitable[None]]] = None
    after_record_execution: Optional[Callable[[ExecutionSummary, RecordReceipt], Awaitable[None]]] = None
    after_note_write: Optional[Callable[[NoteMeta], Awaitable[None]]] = None
    after_note_update: Optional[Callable[[NoteMeta], Awaitable[None]]] = None
```

`FileMemoryProvider.record_turn` / `record_execution` / `notes.write` / `notes.update` 가 hook 트리거. fire-and-forget asyncio task 로 wrap (메모리 주 경로 블록 방지).

**용도**: Geny 의 ConversationArchiver / DmArchiver / VTuber LOGS emit / pin policy 결정 → 모두 hook 에 등록. AgentSession 이 stage 18 외부에서 archive 호출하던 path 폐기.

### 2.3 EXEC-3: `_refresh_backlinks` 확장자 mismatch 버그

현재 `link_map` 키는 wikilink target ("target") 인데 cache 키는 filename ("target.md") — `target.links_in` 이 항상 빈 채로 남는다.

수정 (notes_store.py:340-349):
```python
def _refresh_backlinks(self) -> None:
    link_map: Dict[str, List[str]] = {}
    for fname, note in self._cache.items():
        for tgt in note.links_out:
            # Normalize: try both "target" and "target.md" forms
            candidates = {tgt, f"{tgt}.md"} if not tgt.endswith(".md") else {tgt}
            for cand in candidates:
                if cand in self._cache:
                    link_map.setdefault(cand, []).append(fname)
                    break
        ...
    for fname, note in self._cache.items():
        note.links_in = list(dict.fromkeys(link_map.get(fname, [])))
```

### 2.4 EXEC-4: PinnedHandle (또는 NotesHandle helper) — pinned facts 주입 일반화

retriever 의 `_load_pinned_facts` 가 현재 어떻게 동작하는지 점검 (executor retriever.py 측). 이미 NotesHandle.list(category="critical") 위에서 동작하면 추가 작업 0. 아니면:

- 옵션 A: NotesHandle 에 `load_pinned(*, max_chars: int) -> str` helper 추가. NotesHandle.list(category="critical") + 본문 합치기.
- 옵션 B: 별도 `PinnedHandle` 인터페이스 신규 — 미래에 critical 외에도 always-inject 카테고리가 늘어날 가능성 감안.

→ **옵션 A 채택**. 인터페이스 inflation 회피.

### 2.5 EXEC-5: IndexHandle.render_vault_map — prompt-injectable markdown

현재 retriever (executor retriever.py:417-420) 가 `mgr.index_manager.render_vault_map()` 호출. mgr 은 host 객체 (Geny SessionMemoryManager) 라 duck-type 으로 의존.

전환:
- `IndexHandle` 에 `render_vault_map(*, recent_limit: int = 5, top_tags: int = 10, char_limit: int = 200) -> str` 추가.
- 디폴트 형식 (categories summary + top tags + recent notes preview) 은 executor 에 내장.
- Geny 가 customize 하고 싶으면 `MemoryHooks.render_vault_map_override` (선택) 콜백 등록.

retriever 변경: `idx_mgr.render_vault_map()` 대신 `provider.index().render_vault_map()` 호출.

### 2.6 EXEC-6: STMHandle.append_event

executor STM 이 `Turn` 만 모델링 → `add_event` 가 갈 곳이 없다. 추가:

```python
@runtime_checkable
class STMHandle(Protocol):
    async def append(self, turn: Turn) -> None: ...
    async def append_event(self, name: str, data: Dict[str, Any], *, metadata: Optional[Dict[str, Any]] = None) -> None: ...
    async def recent(self, n: int = 20) -> List[Turn]: ...
    async def search(self, text: str, *, limit: int = 10) -> List[Turn]: ...
    async def truncate(self, *, keep_last: int) -> int: ...
```

`_JSONLSTMStore.append_event` 구현: jsonl 에 `{"type": "event", "event": name, "ts": iso, "data": data, "metadata": metadata}` 라인 append.

### 2.7 EXEC-7 (선택): SqlMemoryProvider 점검

현재 SQL provider 가 STM/LTM/Notes 모두 받는지 확인. 받으면 Geny 가 SQL backend 채택 시 별도 DB 코드 불필요 (DB dual-write 자동 폐기). 받지 않으면 보류 — Geny 측 GENY-8 에서 DB dual-write 코드만 삭제하고 단일 disk 진실로.

### 2.8 EXEC PR 의존성

```
EXEC-1 (metadata 필드 + Turn.from_state_message) ─┬─→ GENY-1 / GENY-2 시작 가능
EXEC-2 (after_* hooks) ──────────────────────────┘
EXEC-3 (refresh_backlinks 버그) ─── 독립
EXEC-4 (load_pinned helper) ─────── GENY-3 전제
EXEC-5 (render_vault_map) ────────── GENY-4 전제
EXEC-6 (append_event) ─────────────── GENY-1 전제
EXEC-7 (SQL provider 점검) ─────── 선택
```

---

## 3. Geny 측 작업

마이그레이션 무시 → 기존 short_term/long_term/index/structured_writer 자체를 **삭제** 가능. 호출자만 provider 직접 호출로 변경.

### 3.1 GENY-1: ShortTermMemory 폐기

- `short_term.py` (597줄) 완전 삭제
- `manager.record_message(role, content, metadata=...)` → 직접 `provider.stm().append(Turn(role, content, metadata={"geny.interaction.*": ...}))` (run_coro_sync via)
- `manager.record_event(event, data)` → `provider.stm().append_event(event, data)`
- `manager.get_recent_messages(n)` → `provider.stm().recent(n)` 결과 변환
- `manager.search_stm(query)` → `provider.stm().search(query)`
- `write_summary` 폐기 — stage 19 Summarizer 가 자동 생성 (현재 Geny 가 명시적으로 write_summary 호출하는 곳 없는지 확인 필요)
- DB dual-write (db_stm_*) 함수 호출 제거

**의존**: EXEC-1, EXEC-6.

### 3.2 GENY-2: GenyDedupeStrategy 폐기 + state.metadata pending stamp 단순화

- `dedupe_strategy.py` 삭제
- `AgentSession._invoke_pipeline` 에서 `state.metadata['_pending_message_metadata']` stamp 하던 곳 → `state.messages` 의 마지막 메시지에 `metadata` 키 직접 첨부 (Turn.from_state_message 가 picks up)
- stage 18 strategy slot = `NoMemoryStrategy()`
- `default_manifest.py` 에서 strategy_configs 의 GenyDedupeStrategy 등록 제거

**검증**: 매 user/assistant 메시지가 jsonl 에 정확히 1 회 append, metadata 가 jsonl 라인의 `metadata` 필드에 보존.

**의존**: GENY-1.

### 3.3 GENY-3: LongTermMemory 폐기

- `long_term.py` (779줄) 완전 삭제
- `manager.append_to_ltm(text, heading=...)` → `provider.ltm().append(text, heading)`
- `manager.write_dated(text)` → `provider.ltm().write_dated(text)`
- `manager.write_topic(slug, text)` → `provider.ltm().write_topic(slug, text)`
- `manager.read_main()` → `provider.ltm().read_main()`
- `manager.search_ltm(query)` → `provider.ltm().search(query)` 결과 어댑터
- **`write_execution` 폐기** — executor `record_execution` 이 stage 18 의 `_drive_provider` 에서 자동 호출됨. Geny 의 `manager.record_execution` (manager.py:713) 도 폐기 — 동일 작업을 executor 가 이미 수행.
- **`load_pinned` 폐기** — `provider.notes().load_pinned(max_chars=N)` 호출 (EXEC-4 helper 사용)

**의존**: EXEC-1, EXEC-4.

### 3.4 GENY-4: MemoryIndexManager 폐기 + vault_map executor 위임

- `index.py` (961줄) 완전 삭제
- `frontmatter.py` (289줄) 완전 삭제 — `parse_frontmatter` / `render_frontmatter` / `build_default_metadata` / `extract_wikilinks` / `resolve_wikilink` 모두 caller 가 사라지면 dead
- `_vault_map.json` 캐시 파일 폐기
- retriever 의 `mgr.index_manager.render_vault_map()` 호출 경로 → `provider.index().render_vault_map()` 직접
- `manager.index_manager` property 폐기
- `MemoryFileInfo` dataclass 도 삭제 — caller 가 executor 의 `NoteMeta` 직접 사용

**의존**: EXEC-5.

### 3.5 GENY-5: ConversationArchiver — bucket-router 비즈니스만 보존

핵심 비즈니스 로직 (kind → bucket 분류 + bucket 별 filename 결정 + frontmatter 누적) 유지. 다만:

- 호출 트리거를 stage 18 외부 호출 (AgentSession.\_invoke\_pipeline 직접 호출) → `MemoryHooks.after_record_turn` 콜백으로 이동
- conversation_archiver.py 1474줄 → 비즈니스 핵심만 남기고 ~500줄로 축소 (frontmatter render / atomic_write helper / migration 코드 등 모두 삭제)
- `target_rel = f"conversations/{sid}__{bucket}.md"` 형식 유지
- NotesHandle 호출은 PR #671 패턴 (bare filename) 유지

**의존**: EXEC-2.

### 3.6 GENY-6: DmArchiver 정리

비즈니스 (counterpart-aware 디렉토리) 유지, 직접 디스크 쓰기 유지 (2-level subpath, executor 미지원). 다만:

- 호출 트리거를 `after_record_turn` hook 으로 이동 (현재 AgentSession 가 직접 호출)
- 죽은 코드 정리 (set_memory_provider 잔재 등 — PR #671 에서 일부 정리됨)

**의존**: EXEC-2.

### 3.7 GENY-7: structured_writer 폐기

- `structured_writer.py` (885줄) 완전 삭제
- caller (memory_tools / memory_controller / curated_knowledge / user_opsidian / migrator 등) 모두 `provider.notes()` 직접 호출
- DB dual-write `_db_write` 메서드 삭제 (디스크가 단일 진실)
- `_propagate_linked_from` 삭제 — executor `_refresh_backlinks` 가 EXEC-3 후 정상 동작

**의존**: EXEC-1, EXEC-3.

### 3.8 GENY-8: DB dual-write 일괄 제거

- `manager._db_write`, `db_stm_*`, `db_ltm_*` 호출 모두 삭제
- `service/database/memory_db_helper.py` 의 메모리 관련 함수 삭제
- `session_memory_entries` 테이블은 schema 만 남김 (운영자가 별도 분석 도구로 접근 시) 또는 삭제 — 사용자 결정

**의존**: GENY-1, GENY-3, GENY-7 (DB write 호출자 모두 정리된 후).

### 3.9 GENY-9: memory_llm.py / persisting_compactor.py / curation_engine.py 검토

각 파일이 executor 의 reflection / compaction / curation 인프라 위로 이전 가능한지 점검:

- **memory_llm.py**: Geny 가 메모리 관련 LLM 직접 호출하는 곳. executor 의 `ReflectionResolver` 또는 host LLM client 로 통합.
- **persisting_compactor.py** (97줄): s02 컴팩터의 메모리 측 hook. executor `record_compaction` 에 위임 가능.
- **curation_engine.py** (598줄), **curation_scheduler.py** (157줄): 큐레이션 루틴. executor 의 promote / curated provider 위로 이전 가능 여부 검토.

이 PR 은 조사 + 결정 단계. 결과에 따라 GENY-9a / 9b / 9c 분리.

### 3.10 GENY-10: 죽은 코드 일괄 정리

- 위 작업 후 `service/memory/` 디렉토리에서 import 안 되는 모듈 삭제
- `MemoryEntry` / `MemorySearchResult` / `MemorySource` 같은 Geny 자체 dataclass 가 잔존 caller 와 함께 제거 가능한지 점검 (executor `MemoryChunk` / `NoteMeta` 로 일원화)
- `provider_bridge.py` 단순화 — wiring 만 남김
- `migrator.py` (254줄) 삭제 — 마이그레이션 무시 결정에 따라

---

## 4. PR 시퀀스 + 의존성

```
EXEC-1 (metadata 필드 + Turn.from_state_message) ─┐
EXEC-2 (after_* hooks) ───────────────────────────┤
EXEC-3 (refresh_backlinks)                        │
EXEC-4 (load_pinned helper) ──────────────────────┤
EXEC-5 (render_vault_map) ────────────────────────┤
EXEC-6 (append_event) ────────────────────────────┘
                                                   │
                                                   ↓
                                        ┌── GENY-1 (STM thin)
                                        ├── GENY-2 (DedupeStrategy 폐기)
                                        ├── GENY-3 (LTM thin + write_execution 폐기)
                                        ├── GENY-4 (Index thin + frontmatter.py 삭제)
                                        ├── GENY-5 (Conv archiver hook)
                                        ├── GENY-6 (DM archiver hook)
                                        ├── GENY-7 (structured_writer 폐기)
                                        ├── GENY-8 (DB dual-write 제거)
                                        ├── GENY-9 (memory_llm / compactor / curation 검토)
                                        └── GENY-10 (잔여 죽은 코드)
```

순서:
1. EXEC-1, EXEC-2, EXEC-3 (executor 코어 PR 3개) — 병렬 가능
2. EXEC-4, EXEC-5, EXEC-6 (executor 인터페이스 확장 PR 3개) — 병렬 가능
3. GENY-1 → GENY-2 (STM 정리 — 순차)
4. GENY-3, GENY-4 (LTM + Index — 병렬 가능)
5. GENY-5, GENY-6, GENY-7 (archive + structured_writer — 병렬 가능)
6. GENY-8 (DB dual-write — 위 모두 후)
7. GENY-9, GENY-10 (조사 + 잔여 정리)

각 PR 은 단일 응답으로 완결, 회귀 시 단독 revert 가능.

---

## 5. 추정 코드 변동

| 영역 | +라인 | -라인 |
|---|---|---|
| EXEC-1~6 | +500 | -50 |
| GENY-1~2 (STM) | +50 | -700 (short_term.py + dedupe_strategy.py) |
| GENY-3 (LTM) | +50 | -1200 (long_term.py + record_execution + write_execution path 등) |
| GENY-4 (Index + frontmatter) | +50 | -1250 (index.py + frontmatter.py) |
| GENY-5 (Conv archiver) | +0 | -900 (conversation_archiver.py 축소) |
| GENY-6 (DM archiver) | +20 | -50 |
| GENY-7 (structured_writer) | +200 | -900 |
| GENY-8 (DB dual-write) | 0 | -300 |
| GENY-9, GENY-10 | TBD | TBD |

**예상 순 변동**: executor +450 / Geny +370 / -5300 ≈ **순 -4480 줄**.

---

## 6. 검증 계획

### 6.1 단위 테스트 (executor)

- EXEC-1: 모든 dataclass 의 metadata round-trip
- EXEC-1 (Turn.from_state_message): message["metadata"] 가 Turn.metadata 로 보존
- EXEC-2: 매 record_turn / record_execution / notes.write 후 콜백 호출 (Turn + RecordReceipt 인자 검증)
- EXEC-3: source 노트가 `[[target]]` 가질 때 target.links_in == ["source"] (cache + as_meta + graph 모두)
- EXEC-4: load_pinned(max_chars=N) 가 critical 노트 본문 합쳐서 반환, char limit 적용
- EXEC-5: render_vault_map() 마크다운 출력 — recent / top tags / categories 섹션 포함
- EXEC-6: append_event 라인 형식 (`{"type":"event","event":...,"data":...}`) 확인

### 6.2 통합 테스트 (Geny)

각 GENY-N 머지 후:
1. session.jsonl 라인 수 == 메시지 수 (이중 쓰기 X)
2. 매 라인의 metadata 필드에 InteractionEvent 키 보존
3. memory/critical /, topics/, projects/, insights/, conversations/, dms/ 모두 Opsidian 파일 패널에 보임
4. memory_pin / memory_write / memory_search / memory_list 도구 정상 동작
5. `_index.json` 이 executor 포맷 (`"files": {...}`)
6. retriever 의 vault_map 주입이 system prompt 의 `# Vault Map` 섹션에 들어감
7. memory/dms/<cp>/<date>.md 가 DM kind 메시지마다 정확히 누적
8. memory/conversations/<sid>__user__<title>.md 가 user_chat 마다 누적, `<sid>__dm__<cp>.md` / `<sid>__reflection.md` / `<sid>__system.md` 도 각각

### 6.3 운영 검증 (사용자)

각 PR 머지 후 docker rebuild → VTuber 세션 1회 → 위 8 항목 체크. 회귀 발견 시 단독 revert.

---

## 7. 마이그레이션 — 무시

**확정**: 기존 디스크 데이터 / DB 데이터 / file format 호환성 신경 쓰지 않음. 새 세션부터 새 포맷.

- 기존 세션 디렉토리는 그대로 두되, executor 가 부팅 시 자기 포맷으로 재해석. 호환되는 부분은 재사용, 안 되는 부분은 무시 (기존 동작과 동일 — file provider 의 `_ensure_loaded` 가 이미 self-healing).
- DB의 `session_memory_entries` 테이블 — Geny 가 더 이상 쓰지 않음. 기존 row 는 운영 분석 용도로 보존하거나 운영자가 따로 정리.
- `migrator.py` (254줄) 삭제 — 더 이상 마이그 안 함.

---

## 8. 미해결 질문 (사용자 결정 대상)

1. **`session_memory_entries` 테이블 처리** — Geny 가 더 이상 쓰지 않을 때 (a) 테이블 schema 만 남기고 row 보존 / (b) 테이블 자체 drop / (c) 그대로 (운영자 선택).
2. **VTuber LOGS panel emit** — 현재 `event_emitter.py` 가 manager 측에서 emit. EXEC-2 의 hook 으로 옮길지 (이중 trigger 방지) / 그대로 둘지.
3. **MemoryHooks.after_record_turn 의 동기 vs 비동기** — Geny 비즈니스 로직이 무거우면 (예: ConversationArchiver 의 bucket router + NotesHandle.update 2x I/O) 동기 hook 이 stage 18 을 블록. → fire-and-forget asyncio task 가 디폴트, Geny 가 명시적으로 await 필요한 경우만 sync.
4. **executor SQL provider 채택 여부** — 현재 file provider 만 쓰고 있음. SQL provider 채택은 별도 운영 결정 (Postgres 인스턴스 가동 등). 본 plan 은 file provider 기준.
5. **render_vault_map 의 customize 메커니즘** — Geny 가 vault map 형식에 추가 정보 주입하고 싶을 때 (예: VTuber persona 스탯) executor hook 으로 처리할지 / Geny 가 후처리할지.

---

## 9. 다음 액션

1. 사용자가 plan v2 승인.
2. EXEC-1, EXEC-2, EXEC-3 PR 시작 (geny-executor 레포). 병렬 가능.
3. 위 3 PR 머지 후 EXEC-4, EXEC-5, EXEC-6 PR.
4. EXEC PR 모두 머지 → Geny 레포 GENY-1 부터 시작. 의존성 그래프 따라 진행.
5. 매 PR 머지 후 docker rebuild → 사용자 검증 → 다음 PR.

각 PR 은 직전 사이클의 PR-3a~3i 와 같은 cadence (단일 응답 완결, 회귀 시 단독 revert) 유지.
