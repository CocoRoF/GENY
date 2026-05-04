# Memory Engine 이중 운영 감사 보고서

> 작성: 2026-05-04 · 범위: Geny `service/memory/*` + `service/memory_provider/*` + `agent_session` ↔ executor `MemoryProvider`
> 사용자 검증 환경 로그 기반 (PR #655~#660 머지 후)

---

## 0. 한 줄 진단

executor `MemoryProvider` (composite + 자동 벡터 인덱싱) **wiring은 완료**되어 boot 시 정상 init된다 (`MemoryProvider initialized: composite`, `flushed N pending memory event(s)`). 그러나 **legacy 자체 시스템 (`vector_memory` + `vector_store` + `embedding`)이 여전히 평행 운영**되고 있고, executor의 stage 2 retriever (`geny_executor.memory.retriever.GenyMemoryRetriever`)가 `mgr.vector_memory.search()`를 직접 호출하므로 vector retrieval은 **legacy path에서만 동작**한다. 즉 OpenAI embedding이 매 turn에 두 번 호출되고, 디스크에 두 vector index가 동시 존재하며, VTuber LOGS 메모리 이벤트는 trigger 등 외부 broadcast가 cursor를 먼저 advance시키면 (legacy retrieval 호출 시점에 새 hook이 발화하지 않으니) 빈 응답으로 보인다.

**결론**: 새 path는 살아있지만 legacy path를 끄지 않은 상태. demolition을 해야만 새 path가 단독 운영되고 VTuber LOGS도 자연스럽게 채워진다.

---

## 1. 사용자 검증 환경에서 실제 관찰된 동작

### 1.1 Boot 로그 (정상)

```
service.executor.agent_session - MemoryProvider initialized: composite
faiss.loader - Loading faiss with AVX2 support.
service.memory.vector_store - VectorStore created: empty index, dim=1536 at <sid>/vectordb
service.memory.vector_memory - VectorMemoryManager initialized: provider=openai model=text-embedding-3-small dim=1536 chunks=1024/256 top_k=6
service.memory.curated_knowledge - CuratedKnowledgeManager initialized for 'gkfua00'
service.executor.agent_session_manager - 📝 Session logger created
service.executor.agent_session_manager - flushed 1 pending memory event(s) into session logger
```

→ **두 system이 모두 init**: executor composite + legacy `VectorMemoryManager`. 둘 다 OpenAI 1536 dim 모델 사용.

### 1.2 매 Turn 동작

```
httpx - POST https://api.openai.com/v1/embeddings 200 OK    ← 매 turn 1회 (legacy retrieve)
geny_executor.memory.retriever - geny_retriever: loaded N chunks for session ...
... LLM 호출 ...
service.memory.structured_writer - StructuredMemoryWriter: created critical/...md
service.memory.structured_writer - StructuredMemoryWriter: created insights/...md
service.memory.curated_knowledge - CuratedKnowledgeManager: wrote note '...' (source=promoted)
service.memory.manager - record_execution: #N (M chars) → executions/
httpx - POST https://api.openai.com/v1/embeddings 200 OK    ← 매 turn 추가 (legacy record)
```

→ legacy path가 모든 retrieval/write/index 담당. 새 path는 `provider.curated()` handle만 살아있고 실제로 호출되는 surface는 KnowledgeSearch tool path 한 곳뿐 (LLM이 명시 호출한 경우).

### 1.3 디스크 layout

```
<sid>/
├── transcripts/                       ← STM (jsonl)
├── memory/                            ← LTM (markdown)
│   ├── conversations/
│   ├── daily/
│   ├── insights/
│   ├── critical/                      ← pin_callback (legacy)
│   └── _index.json
├── vectordb/                          ← legacy FAISS index
│   ├── index.faiss
│   └── metadata.json
├── checkpoints/                       ← executor s20 persist
└── _vector/ (or vectordb)             ← executor file vector store, executor.vector().index() 시
```

⚠️ executor의 file vector store 경로가 legacy와 충돌 가능성 있음 (둘 다 `vectordb/` 사용). 확인 필요 — 단 현재 executor의 vector layer는 호출되지 않으므로 충돌 미발생.

---

## 2. 두 system 책임 분담 — 무엇이 무엇을 하는가

| 작업 | Legacy (살아있음) | Executor MemoryProvider (살아있지만 미사용) |
|---|---|---|
| Stage 2 context retrieval | ✅ `GenyMemoryRetriever.mgr.vector_memory.search` | ❌ provider.retrieve() 호출되지 않음 |
| Note 쓰기 (insights/critical/daily) | ✅ `StructuredMemoryWriter` | ❌ provider.notes().write() 호출되지 않음 |
| Vector indexing (record_execution) | ✅ `VectorMemoryManager.index_text` | ❌ auto-vector hook 미발화 |
| Curated 큐레이션 promote | ✅ `CuratedKnowledgeManager.promote_from_session` | ❌ provider.curated().promote_from_session() 미호출 |
| `knowledge_search` tool | ✅ legacy keyword fallback | ✅ executor.memory_provider 사용 가능 (PR #656) |
| Memory event channel (VTuber LOGS) | hook 박힘 (PR #657 #658) — 발화 정상 | hook 박힘 — provider_initialized 1건 발화 |

→ **legacy가 80% 일을 하고 있고, executor는 wiring만 살아있음**.

---

## 3. VTuber LOGS 비어있는 진짜 원인

진단 로그:
```
[Broadcast:004884ef] session=a6186b47: 0 memory events this turn (agent=live, cursor=91)
[Broadcast:004884ef] session=a6186b47: 0 memory events this turn (agent=live, cursor=168)
```

cursor=91, 168 → cache에 entries는 쌓이지만 `LogLevel.MEMORY` 필터 0개. backend 로그에 `flushed 1 pending memory event(s)` 떴으니 cache에 1개는 있어야 함. 가능성:

1. **첫 사용자 메시지 *전*에 trigger broadcast가 cursor를 91로 advance** — VTuber 세션의 thinking_trigger / idle event / sub-worker init 같은 것이 chat_controller broadcast handler로 흘러서 첫 chat 메시지 시점엔 cursor가 이미 91. 그 사이의 boot event 1개가 trigger broadcast 응답에 들어갔으나 frontend가 trigger broadcast 응답을 처리하지 않거나, frontend bundle이 아직 갱신 안 됐거나.

2. **frontend bundle이 PR #656/#657/#660 코드 미반영** — `docker compose build frontend` 안 했으면 `VTuberChatPanel`의 `addLog` 호출 자체가 들어가지 않음.

3. (낮은 가능성) cache trim 로직 — 단 91 < 300 maxlen이라 evict 안 됨.

→ 1번 가능성 가장 높음. demolition 이후 retriever / archiver / vector indexing이 **새 path**로 가면 매 turn에 각 활동이 `record_memory_event` 호출 → 매번 새 events 발화 → cursor advance 불 일치 무관.

---

## 4. Cleanup 가능 (이번 사이클 — 안전)

### 4.1 `service/memory_provider/adapters/` 전체 = dead code

5개 adapter (`stm`, `ltm`, `notes`, `curated`, `vector`) 모두 명시적 stub:

```python
def try_X(...) -> Optional[Y]:
    if legacy_X_enabled():
        return None
    _maybe_warn()
    return None
```

즉 어떤 입력이 와도 `None` 반환. caller (manager.py / curated_knowledge.py / global_memory.py)의 lazy import 패턴:

```python
try:
    from service.memory_provider.adapters.X_adapter import try_X
    result = try_X(...)
    if result is not None:
        handled = True
except Exception:
    ...
if not handled:
    legacy_path()  # 항상 여기로 옴
```

→ **adapter 삭제 + caller lazy import 줄 제거 = 동작 변화 0**. 이번 PR에서 안전 삭제.

### 4.2 `service/memory_provider/flags.py`의 `legacy_X_enabled` 함수들

adapter 삭제 후 호출처 없음. dead. 삭제.

### 4.3 단순 cleanup 외 다른 부분

- `vector_memory.py` 삭제 = `manager.py:202` `self._vmm = VectorMemoryManager(...)` + retriever의 `mgr.vector_memory.search` 의존성 cascade. 별도 PR (Phase 2).
- `vector_store.py` / `embedding.py` 삭제 = vector_memory.py 의존성. Phase 2.
- `structured_writer.py` 삭제 = manager.py / curated_knowledge.py / user_opsidian.py 의존성. Phase 3 (archiver port 동반).
- `faiss-cpu` dep 제거 = vector_store.py 사용 끝난 후. Phase 2.

---

## 5. Phase 2 (다음 사이클) — 진짜 demolition

### 5.1 retriever를 새 path로 redirect

가장 결정적인 변경. `service/memory/vector_memory.py`를 **executor MemoryProvider thin adapter**로 재작성:

```python
class VectorMemoryManager:
    """Thin adapter — delegates every call to the session's
    executor MemoryProvider.vector() handle."""
    def __init__(self, storage_path, *, session_id="", memory_provider=None):
        self._provider = memory_provider
    @property
    def enabled(self) -> bool:
        return self._provider is not None and self._provider.vector() is not None
    async def search(self, query, top_k=6) -> List[VectorSearchResult]:
        vh = self._provider.vector()
        chunks = await vh.search(query, top_k=top_k)
        # convert MemoryChunk → legacy VectorSearchResult shape
        return [...]
    async def index_text(self, text, source_file, *, replace=False) -> int:
        vh = self._provider.vector()
        ref = NoteRef(filename=source_file, scope=Scope.SESSION)
        return await vh.index(ref, text)
    ...
```

retriever (`geny_executor.memory.retriever`) 는 외부 라이브러리 코드라 변경 못함 — 따라서 `mgr.vector_memory` 인터페이스를 그대로 두고 내부만 swap.

### 5.2 자체 모듈 3개 삭제

`service/memory/embedding.py`, `vector_store.py`는 thin adapter로 변환된 vector_memory.py가 더 이상 import하지 않으니 삭제 가능. `pip` 의존성 `faiss-cpu` 제거.

### 5.3 archive layer port (Phase 3)

`conversation_archiver` / `dm_archiver` / `curation_engine` → `provider.notes().write(NoteDraft(...))`로 port. 자체 `structured_writer.py` / `frontmatter.py` / `index.py` / `compaction_archiver.py` 삭제. 이게 진짜 demolition. **별도 PR / 별도 사이클**.

---

## 6. 이번 PR 범위 (안전, ~10 파일)

| 작업 | 파일 |
|---|---|
| 5개 adapter 삭제 | `service/memory_provider/adapters/{stm,ltm,notes,curated,vector}_adapter.py` |
| flags 정리 | `service/memory_provider/flags.py`의 `legacy_X_enabled` 5개 함수 제거 |
| caller lazy import 정리 | `service/memory/manager.py` (9곳), `curated_knowledge.py` (3곳), `global_memory.py` (3곳) |
| 테스트 정리 | adapter 관련 테스트 (있다면) |
| 동작 변화 | **0** (adapters always returned None) |

이게 검증된 안전한 1단계 demolition. 이후 Phase 2 (retriever swap + vector_memory 모듈 삭제 + faiss 제거)는 별도 PR로 진행.
