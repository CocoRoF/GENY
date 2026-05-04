# Embedding 최종 흐름 보고서 — geny-executor + Geny

> 작성: 2026-05-04 · 범위: PR #655 → #661 + 본 PR (Phase 2) 머지 후 상태
> 자매 문서: [MEMORY_PROVIDER_UNIFICATION_PLAN.md](../planning/MEMORY_PROVIDER_UNIFICATION_PLAN.md), [MEMORY_DUAL_ENGINE_AUDIT.md](./MEMORY_DUAL_ENGINE_AUDIT.md)

---

## 0. 한 줄 요약

embedding은 **단 한 곳** — `geny-executor`의 `EmbeddingClient` — 에서만 발생한다. Geny는 자체 embedding 코드를 모두 삭제했고, `service.memory.vector_memory`는 executor `MemoryProvider.vector()` handle을 감싸는 **thin adapter** 역할만 한다. `faiss-cpu` 의존성은 제거됐다 (executor의 file vector store는 pure-Python).

OpenAI / Voyage / Google 키 입력은 Geny의 LTMConfig (settings UI) → `provider_bridge.build_memory_provider_config(...)` → executor `MemoryProviderFactory.build(config)` → `EmbeddingClient.embed(texts)` → 외부 HTTP. 이게 유일한 path.

---

## 1. 책임 분담 (지금 시점, 단일 path)

```
┌─────────────────────────────────────────────────────────────────┐
│ Geny (비즈니스 layer)                                            │
│  ─ LTMConfig: 사용자 UI → embedding_provider/model/api_key       │
│  ─ provider_bridge: LTMConfig + storage_path + username          │
│       → executor MemoryProviderFactory config dict                │
│  ─ AgentSession._init_memory_provider: 매 세션 boot 시 build      │
│  ─ ConversationArchiver / DmArchiver / CurationEngine             │
│       → 노트 비즈니스 로직 (counterpart-aware rollup,             │
│         5-stage LLM curation 등) 보유                              │
│  ─ vector_memory (thin adapter): mgr.vector_memory.search()       │
│       → provider.vector().search() 변환 호출                       │
└─────────────────────────────────────────────────────────────────┘
                           ↑ uses ↓
┌─────────────────────────────────────────────────────────────────┐
│ geny-executor 1.16.0+ (일반화 + 인터페이스)                       │
│  ─ MemoryProviderFactory: config → provider tree                 │
│  ─ CompositeMemoryProvider: 4-axis routing                       │
│       └─ scope_providers={session, user}                         │
│       └─ curated()/global_() 자동 wrapper (Phase 2d)             │
│  ─ FileMemoryProvider: 단일 root, layout, ensure                 │
│       └─ STM/LTM/Notes/Vector/Index 5 layer                       │
│       └─ NotesHandle.write에 auto-vector 인덱싱 hook              │
│  ─ EmbeddingClient (4 backend):                                  │
│       └─ openai (text-embedding-3-small/large/ada-002)            │
│       └─ voyage (voyage-3 family)                                │
│       └─ google (text-embedding-004 / embedding-001)              │
│       └─ local (SHA-256 deterministic, 테스트용)                  │
│  ─ _FileVectorStore: pure-Python cosine, no FAISS / no numpy      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Embedding 호출 path — 한 번만 일어난다

### 2.1 사용자가 키 입력

[ltm_config.py:294-303](../../backend/service/config/sub_config/general/ltm_config.py#L294-L303):

```python
ConfigField(
    name="embedding_api_key",
    field_type=FieldType.PASSWORD,
    apply_change=env_sync("LTM_EMBEDDING_API_KEY"),
)
```

UI → 저장 시 두 곳에 set: settings.json + `os.environ["LTM_EMBEDDING_API_KEY"]`. 즉시 반영, 재시작 불필요.

### 2.2 세션 boot — provider 구성

[provider_bridge.py:_embedding_config](../../backend/service/memory/provider_bridge.py)

```python
api_key = config.embedding_api_key or os.environ["LTM_EMBEDDING_API_KEY"] \
                                  or os.environ["OPENAI_API_KEY"]   # provider별 fallback chain
return {"provider": "openai", "model": "text-embedding-3-small", "api_key": api_key}
```

[provider_bridge.py:build_memory_provider](../../backend/service/memory/provider_bridge.py)이 composite config 생성 → `MemoryProviderFactory.build(config)` 호출 → executor가 `EmbeddingClient` 생성 ([factory.py:_build_embedding](../../../geny-executor/src/geny_executor/memory/factory.py)).

### 2.3 사용자 첫 메시지 — 매 turn embedding 호출 path

```
broadcast 도착
  ↓
GenyMemoryRetriever (executor 측 legacy adapter, Stage 2 Context의 retriever slot)
  ↓ mgr.vector_memory.search(query, top_k=6)
service.memory.vector_memory.VectorMemoryManager.search()        ← Geny thin adapter
  ↓ provider.vector().search(query, top_k=6)
geny_executor.memory.providers.file.vector_store._FileVectorStore.search()
  ↓ self._client.embed([query])
geny_executor.memory.embedding.openai.OpenAIEmbeddingClient.embed()
  ↓ async openai.embeddings.create(input=[query], model="text-embedding-3-small")
HTTPS → api.openai.com/v1/embeddings
```

embedding은 **한 번**만 호출. legacy `service.memory.embedding`이 직접 httpx로 OpenAI 치는 path는 **없어짐** (모듈 자체 삭제).

### 2.4 노트 쓰기 — 자동 vector indexing

`StructuredMemoryWriter.write_note(...)` → 디스크에 .md 작성 + `event_emitter.emit_memory_event(note_written)` (PR #657 hook).

Phase 3 후엔 노트 쓰기 path도 NotesHandle.write로 통합되어 — `_FilesystemNotesStore.write` 안의 `vector_indexer` callback이 자동 호출 (executor PR #177 auto-vector 기능). 그 callback이 `_FileVectorStore.index(ref, body)` → `EmbeddingClient.embed([body])`.

이번 Phase 2는 archive layer 포팅을 안 했으므로 — 자동 vector indexing은 아직 record_execution path에서만 발화 (`SessionMemoryManager.record_execution` → `self._vmm.index_text(...)`). 매 turn 1회.

---

## 3. 디스크 레이아웃 — 단일 source of truth

```
<storage>/sessions/<sid>/                    ← per-session (SESSION scope)
├── transcripts/                              ← STMHandle: jsonl
├── memory/                                   ← LTMHandle / NotesHandle
│   ├── conversations/  daily/  insights/    ← NOTE_CATEGORIES (executor layout)
│   ├── critical/       projects/  topics/
│   ├── dms/            compactions/  root/
│   └── _index.json                           ← IndexHandle
├── vectordb/                                 ← VectorHandle (file backend)
│   ├── index.bin                             ← packed float32 (pure-Python cosine)
│   └── metadata.json                         ← row metadata
├── checkpoints/                              ← s20 persist (executor stage)
└── _shared/                                  ← shared folder symlink

<storage>/_curated_knowledge/<username>/      ← per-user curated (USER scope)
├── memory/                                   ← CuratedHandle.notes()
│   └── insights/  topics/  projects/  ...
├── vectordb/                                 ← CuratedHandle.vector() (옵셔널)
│   ├── index.bin
│   └── metadata.json
└── _index.json
```

executor의 [`DirectoryLayout` constants](../../../geny-executor/src/geny_executor/memory/providers/file/layout.py)와 정확히 일치. 사용자가 본 **VTuber LOGS 패널의 스크린샷의 "User prefers to be called 사장님" 노트가 `critical/`에 정상 저장**되는 이유 — Geny의 `StructuredMemoryWriter`가 같은 layout 규약을 따르기 때문.

Phase 3가 끝나면 그 쓰기 path도 `provider.notes().write()` → executor가 디렉토리 결정. 외부 layout 변하지 않음.

---

## 4. 무엇이 사라졌나

### Phase 1 (PR #661)
- `service/memory_provider/adapters/{stm,ltm,notes,curated,vector}_adapter.py` 5개
- `service/memory_provider/adapters/__init__.py` + 빈 디렉토리
- `service/memory_provider/flags.py` (`legacy_*_enabled` + `snapshot()`)
- `manager.py` / `curated_knowledge.py` / `global_memory.py`의 14개 lazy-import try 블록
- `main.py`의 flag snapshot boot log
- 총 **-718줄**

### Phase 2 (이 PR)
- `service/memory/vector_store.py` — 자체 FAISS 구현체
- `service/memory/embedding.py` — 자체 httpx-based OpenAI/Voyage/Google client
- `service/memory/vector_memory.py` — 자체 FAISS 오케스트레이션 → **executor adapter로 재작성** (-650줄, +250줄)
- `pyproject.toml` / `requirements.txt`의 `faiss-cpu>=1.9.0` 의존성

→ Geny는 더 이상 embedding HTTP를 직접 치지 않는다. 모든 embedding 호출은 executor의 `EmbeddingClient` → openai SDK / Voyage REST / google SDK / SHA-256 hash로 흐른다.

---

## 5. 무엇이 아직 남아있나 (Phase 3 — 다음 사이클)

| 모듈 | 남은 이유 | 다음 작업 |
|---|---|---|
| `service/memory/structured_writer.py` | 5+ caller (archivers, curated, user_opsidian)의 sync 호출. NotesHandle은 async — cascade 큼 | thin adapter로 변환 (write_note 내부에서 NotesHandle.write를 sync→async helper로 호출) 또는 caller 전체 async 변환 |
| `service/memory/frontmatter.py` | structured_writer의 헬퍼 + 외부 caller 일부 | structured_writer thin 변환 후 dead → 삭제 |
| `service/memory/index.py` | `_index.json` 빌더 + retriever의 `mgr.index_manager.render_vault_map` 호출 | IndexHandle thin adapter |
| `service/memory/compaction_archiver.py` | s02 compactor가 호출 | executor `record_compaction` API로 redirect |
| `service/memory/conversation_archiver.py` | counterpart-aware rollup 비즈니스 로직 | **유지** (비즈니스). 디스크 호출만 NotesHandle로 |
| `service/memory/dm_archiver.py` | 동상 | 유지, NotesHandle |
| `service/memory/curation_engine.py` | 5-stage LLM pipeline 비즈니스 로직 | 유지, Stage 5 Store는 CuratedHandle.notes().write로 |
| `service/memory/curated_knowledge.py` | curated vault wrapper | thin adapter (CuratedHandle 위) |
| `service/memory/user_opsidian.py` | user vault wrapper | thin adapter |

Phase 3 작업 규모: 이 표 + 약 100개의 caller 정리. 단일 PR로는 너무 큼 — 별도 사이클 (PR 2~3개로 분할).

---

## 6. Embedding 흐름 vs LLM 흐름 — 분리 명확

| 측면 | Embedding (OpenAI text-embedding-3-small 등) | LLM (Anthropic Claude 등) |
|---|---|---|
| 호출 주체 | `geny_executor.memory.embedding.openai.OpenAIEmbeddingClient` | `geny_executor.stages.s06_api.AnthropicProvider` |
| 키 출처 | LTMConfig `embedding_api_key` (+ `LTM_EMBEDDING_API_KEY` env fallback + 표준 env (`OPENAI_API_KEY`) fallback) | APIConfig `anthropic_api_key` |
| 호출 시점 | `record_execution` 매 turn 1회 + 노트 write 시 자동 (Phase 3 이후) | 매 turn 1+회 (멀티턴 시 더) |
| HTTP | api.openai.com/v1/embeddings | api.anthropic.com/v1/messages |
| dim | provider별 (3-small=1536, 3-large=3072, voyage-3=1024, google-004=768, local=384 default) | N/A (텍스트 in/out) |
| Geny 코드 | provider_bridge에서 LTMConfig 읽고 dict 변환만 | APIConfig + `service.api_client` (별개) |

→ embedding과 LLM은 키 / 호출 / 비용 / dim 모두 분리된 채널. 사용자가 LTMConfig에서 OpenAI 키 입력 = embedding용. APIConfig의 Anthropic 키 = LLM용.

---

## 7. 검증 체크리스트 (사용자 환경)

다음 docker rebuild + 새 세션 시작 시:

- [ ] `pip show faiss-cpu` → "Package(s) not found" (의존성 제거 확인)
- [ ] `docker compose exec backend python -c "import faiss"` → ModuleNotFoundError
- [ ] `docker compose exec backend python -c "from service.memory.vector_memory import VectorMemoryManager; v = VectorMemoryManager('/tmp'); print(v.enabled)"` → `False` (provider 미연결 상태)
- [ ] backend 로그에서 `faiss.loader - Loading faiss` 라인 사라짐
- [ ] backend 로그에서 `VectorStore created` 라인 사라짐
- [ ] backend 로그에서 `VectorMemoryManager initialized: provider=openai` 라인 사라짐 — adapter는 init 메시지 없음
- [ ] embedding 호출은 여전히 매 turn 1~2회 (`POST https://api.openai.com/v1/embeddings`) — executor의 `EmbeddingClient`가 호출
- [ ] 노트 저장 정상 (`<storage>/sessions/<sid>/memory/critical/...md` 생성)
- [ ] `<storage>/sessions/<sid>/vectordb/index.bin` 생성 (executor file vector store, pure-Python format — magic bytes 비교 시 FAISS와 다름)

---

## 8. 끝나지 않은 일 (정직한 보고)

이번 두 PR로:
- ✅ Phase 1: dead adapter 5종 + flags 모듈 삭제
- ✅ Phase 2: 자체 FAISS / 자체 embedding 모듈 삭제, faiss-cpu 의존성 제거, vector_memory를 thin adapter로 재작성

남은 일:
- ⏳ **Phase 3**: archive layer (structured_writer / frontmatter / index / compaction_archiver / conversation_archiver / dm_archiver / curation_engine / curated_knowledge / user_opsidian) port. sync→async cascade 때문에 단일 PR로 안전하지 않음. **별도 사이클**.

→ embedding 자체는 **이미 단일 path**다 (Phase 2가 그 cut을 끝냄). Phase 3는 노트 쓰기 / 디렉토리 관리 layer를 executor의 NotesHandle로 옮기는 작업 — embedding과 무관.

**즉 사용자가 묻는 "embedding 관련된 것들"은 이번 사이클 끝**. Phase 3는 그 위의 vault / archive 비즈니스 로직 정리.
