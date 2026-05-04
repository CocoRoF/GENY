# 현재 Memory Layer 상태 정확 진단

> 작성: 2026-05-04 · PR #656~#667 머지 후 Geny `service/memory/*` 실측 inventory.
> 본 문서는 **이전 EMBEDDING_FINAL_FLOW_REPORT의 잘못된 결론을 정정**한다.

---

## 0. 잘못된 결론 정정

이전 보고서에서 conversation/dm rollup의 NotesHandle 변환 실패 이유를 "**executor의 NotePatch가 replace-only이므로 partial-update API 추가가 필요**"로 결론 냈다. **이것은 처음 정한 철학을 위반한 잘못된 분석**이다.

처음 합의한 철학:
- **geny-executor**: 일반화된 인터페이스 (`NotesHandle.read` / `write` / `update` / `delete`) 제공
- **Geny**: 그 인터페이스 위에서 비즈니스 로직 구현

매 turn rollup의 atomic-append은 **Geny 비즈니스 로직**이지 executor가 떠안을 일이 아니다. Geny가 `NotesHandle.read(filename) → frontmatter/body mutate → NotesHandle.update(filename, NotePatch(body=newbody))` 패턴을 직접 구현하면 된다. read+write 2x I/O 비용은 Geny 비즈니스의 cost일 뿐 — executor 측 API를 늘리는 핑계가 될 수 없다.

**즉 이전 보고서의 "executor에 partial-update API 추가" 제안은 폐기**. 모든 잔여 cut은 Geny 측 작업.

---

## 1. 현재 자체 디스크 쓰기 코드 inventory

| 모듈 | 줄수 | 디스크 직접 쓰기? | 비즈니스 로직 vs 인프라 |
|---|---|---|---|
| `conversation_archiver.py` | 1,404 | ✅ `_atomic_write` 매 turn | **비즈니스** (counterpart-aware bucket, H2 anchor append, importance_max aggregation) |
| `dm_archiver.py` | 320 | ✅ `abs_path.write_text` 매 DM | **비즈니스** (per-cp-per-day rollup, turn_count aggregation) |
| `structured_writer.py` | 942 | 일부 (`_write_via_disk` legacy fallback) | provider path 우선, fallback 잔존 |
| `compaction_archiver.py` | 197 | audit copy만 (vault는 NotesHandle) | provider path ✅, audit는 transcripts/ namespace |
| `frontmatter.py` | 289 | render/parse YAML helpers | **인프라** (executor `NoteDraft.frontmatter` dict + `_note_to_frontmatter`로 대체 가능) |
| `index.py` | 961 | `_index.json` / `_vault_map.json` | **인프라** (executor `IndexHandle` + `NotesHandle.list` 위에서 빌드 가능) |
| `long_term.py` | 779 | LTM `MEMORY.md` / 일별 파일 | **인프라** (executor `LTMHandle.append` / `write_dated`로 대체 가능) |
| `short_term.py` | 597 | `session.jsonl` / `summary.md` | **인프라** (executor `STMHandle.append`로 대체 가능) |
| `migrator.py` | ? | 1회성 마이그 | 별개 |

비즈니스 로직 (Geny가 책임): **2개** (conversation, dm rollup)
인프라 (executor 인터페이스 사용해서 제거 가능): **5개** (frontmatter, index, long_term, short_term, structured_writer 잔여)

---

## 2. Embedding 흐름 — 단일 path 확정 ✅

이건 종결. Geny에 자체 httpx OpenAI / FAISS / 자체 vector store 코드 0줄. 모든 embedding 호출은 executor `EmbeddingClient`에서.

```
LTMConfig (UI) → provider_bridge → MemoryProviderFactory.build()
   → CompositeMemoryProvider
       └─ providers["session"]: FileMemoryProvider(embedding=OpenAIEmbeddingClient)
           └─ _FileVectorStore.search/index → EmbeddingClient.embed → HTTPS
```

매 turn embedding 호출은 executor 한 곳에서 1-2회. 검증 완료.

---

## 3. Note 디스크 쓰기 흐름 — 80% NotesHandle 통합 (자체 atomic-append 2건 잔존)

### 통합됨 ✅
- `StructuredMemoryWriter.write_note` → `provider.notes().write(NoteDraft)` (PR #664)
- `StructuredMemoryWriter.update_note` → `provider.notes().update(NotePatch)` (PR #665)
- `StructuredMemoryWriter.delete_note` → `provider.notes().delete` (PR #665)
- `StructuredMemoryWriter.link_notes` → `provider.notes().update(append_body=...)` (PR #665)
- `CompactionArchiver` vault → `provider.notes().write` (PR #666). audit copy는 `transcripts/compactions/` (NotesHandle 외부).

### 자체 디스크 path 잔존 ❌
- **`ConversationArchiver.archive`**: 매 turn `_atomic_write(target_abs, full)` — counterpart-bucket 별 rollup 파일에 H2 anchor 추가 + frontmatter 누적 (turn_count, importance_max, kinds union, event_ids append). 비즈니스 로직.
- **`DmArchiver._append_locked`**: per-cp-per-day index 파일에 `abs_path.write_text(full_text)` — turn_count / importance_max 누적. 비즈니스 로직.
- **`StructuredMemoryWriter._write_via_disk`**: provider 미연결 시 fallback path. 보통 unreachable이지만 코드는 존재.

---

## 4. 진짜 잔여 cut over path (executor 확장 0, Geny 비즈니스 작업만)

### 4.1 ConversationArchiver port

**현재**:
```python
def archive(self, role, content, metadata):
    # ... bucket 결정 + frontmatter 빌드 ...
    new_body = _append_turn_block(existing_body, eid8, turn_block)
    full = render_frontmatter(new_meta, new_body)
    _atomic_write(Path(target_abs), full)
```

**변환 후**:
```python
def archive(self, role, content, metadata):
    # ... bucket 결정 ...
    notes = self._provider.notes()
    existing = run_coro_sync(notes.read(target_filename))
    if existing is None:
        # 새 rollup 파일
        new_body = _build_initial_body(eid8, turn_block)
        new_meta = _build_initial_frontmatter(...)
        run_coro_sync(notes.write(NoteDraft(
            title=..., body=new_body, category="conversations",
            filename=target_filename,
            frontmatter=new_meta,
        )))
    else:
        # 기존 rollup에 H2 append
        new_body = _append_turn_block(existing.body, eid8, turn_block)
        new_meta = _merge_frontmatter(existing.frontmatter, role, content, metadata)
        run_coro_sync(notes.update(target_filename, NotePatch(
            body=new_body,
            frontmatter=new_meta,  # NotePatch.frontmatter는 replace지만 caller가 merge 결과 제공
        )))
```

→ 매 turn read + write 발생 (2x I/O). **이게 비즈니스 cost**다. atomic 보장은 NotesHandle.update가 _lock 안에서 처리.

### 4.2 DmArchiver port

동일 패턴: `notes.read` → `_merge` → `notes.update`. ConversationArchiver보다 단순 (frontmatter 누적만).

### 4.3 frontmatter.py 정리

`render_frontmatter` / `parse_frontmatter`는 archive 측에서 read 후 mutate에 필요하지만 — `NotesHandle.read`가 반환하는 `Note` 객체가 이미 `frontmatter: Dict[str, Any]` 분리 제공. parse 직접 호출 불필요. write 시도 `NoteDraft.frontmatter` dict로 전달 → executor가 render. → frontmatter.py **삭제 가능**.

`build_default_metadata` / `extract_wikilinks` / `resolve_wikilink` — caller 검토 후 비즈니스인지 인프라인지 판단. extract_wikilinks는 executor도 자체 정규식 보유. `_resolve_wikilink`도 executor IndexHandle.graph로 대체.

### 4.4 index.py 정리

`MemoryIndexManager.update_file` / `remove_file` / `tag_count` / `render_vault_map` 등. caller 다수.

대체: 
- `update_file` / `remove_file` → 호출 자체 삭제 (NotesHandle.write가 자체 cache 갱신)
- `tag_count` → `provider.index().tag_counts()` 또는 `notes.list()` 위에서 빌드
- `render_vault_map` → 비즈니스 (Geny가 어떻게 vault map을 prompt에 주입할지 결정) — `notes.list()` 결과로 자체 빌드. 호출 path는 그대로 두되 내부 implementation 변환.

### 4.5 long_term.py / short_term.py 정리

`LTMHandle.append` / `write_dated` / `read_main` / `search` ↔ `LongTermMemory` 인터페이스 유사. swap 가능.
`STMHandle.append` / `recent` / `truncate` ↔ `ShortTermMemory` 인터페이스 유사. swap 가능.

### 4.6 structured_writer 정리

PR-3a/b 후 provider path 우선 + legacy `_write_via_disk` 잔존. provider가 모든 환경에서 init되니 legacy path unreachable. 삭제 가능.

frontmatter / index / long_term / short_term을 모두 NotesHandle / IndexHandle / STMHandle / LTMHandle로 옮기면 → structured_writer 자체도 단순 wrapper. 결국 `provider.notes()` 직접 호출 path로 caller 정리 가능 → **structured_writer 자체도 삭제 후보**.

---

## 5. 진짜 끝까지 가는 cycle 계획 (executor 확장 0)

| PR | 범위 | 줄수 변동 |
|---|---|---|
| **PR-3d** | structured_writer `_write_via_disk` legacy 잔여 삭제 + provider 필수화 | -200줄 |
| **PR-3e** | ConversationArchiver port (read+update 패턴) | -100줄 (자체 atomic_write helper 삭제) |
| **PR-3f** | DmArchiver port | -50줄 |
| **PR-3g** | frontmatter.py 삭제 + 모든 caller가 `Note.frontmatter` dict 사용 | -289줄 |
| **PR-3h** | index.py thin adapter (IndexHandle + NotesHandle.list 위) | -700줄 |
| **PR-3i** | long_term/short_term port to LTMHandle/STMHandle | -800줄 |
| **PR-3j** | structured_writer 자체 삭제 (caller가 provider.notes() 직접) | -942줄 |

**누적 -3,000줄 추가 cleanup 가능**. executor 확장 0. 모든 작업은 Geny가 인터페이스 사용해 비즈니스 로직 다시 빌드.

각 PR은 단일 응답으로 안전 진행 가능 (caller 영향 평가 + 점진 cut). 단 한 cycle에 다 못 끝남 — PR 마다 검증 필요.

---

## 6. 진단 — 진짜 끝까지 가려면

이전 사이클의 실수: archive layer mismatch 보고 "executor API 확장"으로 결론. 옳은 결론은 "Geny가 read+write 패턴으로 비즈니스 로직 다시 빌드".

**현재 상태 한 줄**: embedding은 끝, note 단순 write는 끝, atomic-append rollup 2개 + 인프라 모듈 5개 (frontmatter/index/long_term/short_term/structured_writer 잔여)는 Geny 측 작업으로 NotesHandle/IndexHandle/STMHandle/LTMHandle 위로 옮길 수 있음.

진행 결정은 사용자. 다음 응답에서 PR-3d부터 시작할지, 또는 운영 검증 후 단계별 진행할지.
