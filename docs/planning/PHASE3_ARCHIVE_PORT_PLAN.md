# Phase 3 — Archive Layer Port Plan (vault writes → NotesHandle)

> 작성: 2026-05-04 · 범위: `service/memory/{structured_writer,frontmatter,index,compaction_archiver,conversation_archiver,dm_archiver,curation_engine,curated_knowledge,user_opsidian}.py` (5,329줄)
> 선행: Phase 1 (PR #661, dead adapters), Phase 2 (PR #662, FAISS/embedding cut). 두 phase 끝나서 **embedding 흐름 단일화 완료**. Phase 3는 disk-write/index 관리 layer를 executor `MemoryProvider`의 `NotesHandle` / `IndexHandle` 위로 옮기는 작업.

---

## 0. 한 줄 진단

5,329줄, 14개 모듈, ~30 caller가 얽힌 archive 레이어. 단일 PR로 안전한 cut over 불가능. **3개 PR로 분할**, 각 PR은 boot 가능 + test pass 상태로 머지.

핵심 결정:
- `record_message` (sync) → archive (sync) → disk (sync) chain을 **executor `NotesHandle.write` (async)** 로 옮기는 작업. **두 path 중 택일 필요**:
  - **Path A**: archive 함수들을 모두 `async`로 변환 + caller cascade (record_message → async, _astream_pipeline 호출 site 변경). 깔끔하지만 cascade 큼.
  - **Path B**: archive 함수들 sync 유지 + 내부에서 `_run_async_in_sync_call` thread-pool helper로 NotesHandle.write 호출. 매 write마다 thread spawn 비용 (~수ms), caller 영향 0.
- 권장: **Path B**. caller cascade 회피 + 검증 가능 + 다음 cycle에서 Path A로 promote 가능. 비용은 측정 가능 (turn 당 5-10 write × ~3ms = 15-30ms per turn — Anthropic API call (1-3초) 대비 무시 가능).

---

## 1. 모듈별 cut over 계획

### 1.1 [PR-3a] `structured_writer.py` thin adapter 변환 (~600줄 → ~200줄)

**현재**: `write_note` / `update_note` / `delete_note` / `link_notes` / `read_note` / `list_notes` 자체 디스크 쓰기 + frontmatter render + wikilink 추출 + linked_from propagation + DB dual-write.

**변환 후**:
```python
class StructuredMemoryWriter:
    def __init__(self, memory_dir, index, *, session_id="", memory_provider=None):
        self._memory_dir = Path(memory_dir)
        self._index = index   # legacy index_manager — Phase 3b에서 정리
        self._session_id = session_id
        self._provider = memory_provider

    def set_memory_provider(self, provider): self._provider = provider

    def write_note(self, title, content, *, category, tags, importance, source, links) -> Optional[str]:
        if self._provider is None:
            return None  # provider 필수 — boot 시점부터 set됨
        from geny_executor.memory.provider import NoteDraft, Importance, Scope
        from service.memory.event_emitter import emit_memory_event
        draft = NoteDraft(
            title=title, body=content, category=category,
            tags=list(tags or []),
            importance=Importance(importance),
            scope=Scope.SESSION,
            frontmatter={"source": source} if source else {},
        )
        meta = _run_async_in_sync_call(self._provider.notes().write(draft))
        emit_memory_event(self._session_id, event_type="note_written", ...)
        return meta.ref.filename
```

→ frontmatter / wikilink / linked_from / dedup 모두 executor가 처리. 자체 코드 ~400줄 dead.

**Risk**: thread spawn 비용. **검증**: turn-time 측정 (실측 필요).

**삭제 가능**:
- `_write_to_disk` / `_load_note` / `_propagate_linked_from` / `_make_filepath` / `_deduplicate` / `_db_write` (DB write는 `record_log_entry` 등 별도 path 유지)
- `frontmatter.py` 전체 (NoteDraft.frontmatter dict로 충분)

### 1.2 [PR-3b] `index.py` IndexHandle 적응 (~960줄 → ~200줄)

**현재**: `MemoryIndexManager` — `_index.json` 빌드/관리, 태그 카운트, vault map 렌더, 링크 그래프.

**문제**: executor `IndexHandle`은 `snapshot()` / `tag_counts()` / `graph()` / `rebuild()` 만 노출. Geny의 `render_vault_map()` / `index_files` 같은 풍부한 surface 부재.

**변환 후**:
- `MemoryIndexManager` 외부 surface 유지 (caller 30+).
- 내부: `provider.index().snapshot()` / `tag_counts()` / `graph()` 호출 + Geny 측 `render_vault_map` 같은 비즈니스 로직은 계속 자체 구현 (snapshot 결과 가공).
- `_index.json` 자체 쓰기 path 삭제 (executor가 관리).

**Risk**: dual-write 위험 (Geny + executor 둘 다 `_index.json` 쓰면 race). **해결**: Geny는 `_index_manager.index` 속성 read-only로 변환, write는 모두 executor에 위임.

### 1.3 [PR-3c] Archiver / Curation port + legacy modules 삭제 (~3,000줄)

`conversation_archiver.py` / `dm_archiver.py` / `compaction_archiver.py` / `curation_engine.py` / `curated_knowledge.py` / `user_opsidian.py`.

**대부분은 비즈니스 로직 유지** (counterpart-aware rollup, 5-stage LLM curation, importance heuristic). 디스크 쓰기 부분만 `provider.notes().write()` 로 redirect — PR-3a의 structured_writer가 이미 redirect하니 caller 변경 없음.

**삭제**:
- `frontmatter.py` (PR-3a에서 이미 dead)
- `compaction_archiver.py` 자체 — executor `record_compaction` API 사용
- `structured_writer.py`의 legacy 디스크 path 잔여 (PR-3a thin adapter만 남음)

**Curated/User Opsidian thin wrapper**:
```python
class CuratedKnowledgeManager:
    def __init__(self, username, ...):
        # provider 주입은 글로벌 manager에서 (boot 시)
        self._provider = ...
    def write_note(self, ...): return _run_async_in_sync_call(
        self._provider.curated().notes().write(NoteDraft(...))
    ).ref.filename
```

CuratedHandle은 PR #177에서 composite가 자동 wrapping하므로 native 작동.

---

## 2. PR 분할 + 검증 단계

| PR | 변경 범위 | 검증 |
|---|---|---|
| **PR-3a** | structured_writer thin adapter + `_run_async_in_sync_call` helper 모듈 + manager가 provider 주입 | 매 turn 노트 작성 OK + 디스크 layout 동일 + emit_memory_event 정상 + turn-time 측정 (<+50ms 목표) |
| **PR-3b** | index_manager IndexHandle 적응 + `_index.json` write 단일화 | `_index.json` race 없음 + retriever 의 vault_map / tag_counts 정상 |
| **PR-3c** | archive layer 잔여 정리 + frontmatter/compaction_archiver 삭제 + curated/user_opsidian thin wrapper | 모든 archive path 정상 + tests pass + faiss/embedding/structured_writer-internal dead code 0 |

각 PR 사이 사용자 검증: 일주일 운영 → 다음 PR.

---

## 3. Risk 분석

### 3.1 Sync→async cascade 비용
- PR-3a path B 채택 시 thread pool spawn × turn당 5-10회.
- `_run_async_in_sync_call` 구현 (knowledge_tools에 이미 있음): `concurrent.futures.ThreadPoolExecutor(max_workers=1)` per call.
- 측정 권장: PR-3a 머지 후 turn-time 비교. 목표: <+50ms.
- 만약 비용 큼 → Path A (caller cascade)로 promote. 비싸지만 일회성 작업.

### 3.2 `_index.json` dual-write
- Geny `_index_manager` + executor `_FileIndexStore` 둘 다 같은 `<root>/memory/_index.json`에 write 시도.
- PR-3a 머지 직후엔 두 코드 path 모두 활성 — race condition 가능.
- **해결**: PR-3a 안에서 Geny `_index_manager.update_file` 호출을 일시 stub로 (no-op). PR-3b에서 본격 IndexHandle 적응 + Geny side write 영구 제거.

### 3.3 Frontmatter schema 미세 차이
- Geny `build_default_metadata` vs executor `_note_to_frontmatter` 결과 비교 필요.
- 차이 발견 시 NoteDraft.frontmatter dict로 explicit 전달 (executor가 그것을 그대로 frontmatter에 박음).
- 검증: PR-3a 후 디스크의 .md 파일 frontmatter을 머지 전후 비교.

### 3.4 Wikilink + linked_from
- Geny: `extract_wikilinks` (regex) + `_propagate_linked_from` (best-effort).
- executor: 같은 정규식 + `_refresh_backlinks` (자동).
- 동작 동일 — 검증: 노트에 wikilink 박고 linked_from 자동 채워지는지.

### 3.5 DB dual-write (`record_log_entry`)
- Geny `_db_write` 는 executor와 무관한 PostgreSQL log table에 dual-write.
- `NotesHandle.write` 후 별도 호출로 유지 (PR-3a에서 split).

---

## 4. 진행 결정 사안

이 plan을 실행하려면:

**Q1**. Path A (async cascade) vs Path B (sync→async helper)?
- 권장 B. 30+ caller 변경 없음. thread 비용은 측정 후 Path A로 promote 옵션 유지.

**Q2**. PR-3a 단독 머지 후 운영 검증 vs PR-3a/b/c 한 사이클에 진행?
- 권장 분할. PR-3a만 머지 후 turn-time + frontmatter schema 검증, OK면 PR-3b 진행.

**Q3**. Phase 3 진행 시점?
- 권장 별도 cycle. embedding 부분은 Phase 1+2로 cut 완료. archive port는 Geny의 노트 layout/index가 안정된 후 (지금은 검증 데이터가 부족 — 실 운영 1주일 정도 후 권장).

---

## 5. 결론

**embedding 흐름 단일화는 Phase 1+2로 종결됐다** (PR #661, #662, EMBEDDING_FINAL_FLOW_REPORT.md).

archive layer port는 별도의 큰 작업이고, 단일 PR로는 안전 cut over 불가능. 본 plan은 PR-3a/b/c 3단계 분할로 안전 진행 경로를 정의. 각 단계는 boot 가능 + test pass 상태로 머지하며, 사이마다 운영 검증.

진행 결정은 Phase 1+2 운영 검증 (FAISS 사라짐 / OpenAI embedding 1-2회/turn 정상 / VTuber LOGS 메모리 이벤트 narrate) 완료 후, 사용자가 시작 명령하면 PR-3a부터.
