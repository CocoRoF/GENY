# Memory Provider 일원화 — Geny가 geny-executor의 인터페이스 위로 이동

> 작성: 2026-05-04 · 범위: Geny `service/memory/*` + geny-executor `memory/*` · **clean slate** (기존 세션 0개, backward compat 무시)
> 자매 문서: [FAISS_EMBEDDING_INTEGRATION_AUDIT.md](../analysis/FAISS_EMBEDDING_INTEGRATION_AUDIT.md) — 두 시스템이 평행 운영 중이라는 진단
>
> 사용자 철학: **"executor는 일반화된 로직과 확실한 인터페이스를 제공, Geny는 그것을 비즈니스로 사용"**. 이 원칙으로 보면 현재 Geny가 `service/memory/embedding.py` / `vector_memory.py` / `vector_store.py`를 자체 들고 있는 건 명백한 위반.

---

## 0. 한 줄 진단

geny-executor는 이미 [memory/provider.py](../../../geny-executor/src/geny_executor/memory/provider.py)에서 **완성된 MemoryProvider 인터페이스**를 제공한다 — 4-axis 모델(Layer×Capability×Backend×Scope), 7개 layer handle Protocol, 18개 dataclass, 4개 빌트인 provider(ephemeral/file/sql/composite), 4개 embedding backend(openai/voyage/google/local), config-기반 factory. **Geny가 자체 평행 시스템을 만들 이유가 없다**. 사용자 지시(clean slate + 철학 준수)에 따라 Geny의 memory layer를 **executor MemoryProvider 위로 옮기고 자체 vector/embedding 코드를 삭제**한다. Geny에 남는 건 **순수 비즈니스 로직 4개**(ConversationArchiver / DmArchiver / CurationEngine / 비즈니스 importance 정책)뿐이고, 그조차도 NotesHandle을 호출해 디스크에 닿는다.

---

## 1. 책임 경계선 — 누가 무엇을 소유하는가

```
┌─────────────────────────────────────────────────────────────────┐
│ Geny (비즈니스)                                                 │
│  ─ 대화/DM의 counterpart-aware rollup 변환 (어떤 turn을 어떻게  │
│    한 노트로 묶을지)                                            │
│  ─ Curation 5-stage LLM 파이프라인 (Triage→Analyze→Transform→  │
│    Enrich→Store) — 산출 노트의 형식·품질 정책                   │
│  ─ Importance 결정 정책 (kind/payload/files_written 시그널)     │
│  ─ vault 카테고리 명명·의미 (insights/topics/projects/...)      │
│  ─ Knowledge Graph extraction 정책 (semantic edge 임계값,       │
│    tag IDF, 메타 태그 denylist)                                 │
└─────────────────────────────────────────────────────────────────┘
                          ↑ uses ↓
┌─────────────────────────────────────────────────────────────────┐
│ geny-executor (일반화 + 인터페이스)                             │
│  ─ MemoryProvider Protocol (4-axis 모델)                        │
│  ─ 7개 Layer handle: STM/LTM/NOTES/VECTOR/CURATED/GLOBAL/INDEX │
│  ─ 4개 빌트인 provider: ephemeral / file / sql / composite      │
│  ─ 4개 embedding backend: openai/voyage/google/local            │
│  ─ Note·Turn·Insight·RetrievalQuery 등 dataclass                │
│  ─ EmbeddingDescriptor + ReindexPlan + compatibility check (C5) │
│  ─ 디렉토리 layout (Geny와 호환되는 NOTE_CATEGORIES 정의)       │
│  ─ MemoryProviderFactory: config dict → provider tree           │
│  ─ Frontmatter 직렬화 (NotesHandle.write 안에서)                │
│  ─ Wikilink 파싱 + 그래프 (NoteGraph)                           │
│  ─ Vector indexing + cosine search (file/sql)                   │
└─────────────────────────────────────────────────────────────────┘
```

**핵심 원칙**:
- Geny는 **노트/턴의 모양**을 정한다. 디스크에 무엇이 어떻게 저장될지는 모른다.
- executor는 **저장과 검색**을 담당한다. 노트가 무슨 의미인지는 모른다.
- 둘 사이 통로는 NotesHandle / VectorHandle / STMHandle 등 Protocol뿐.

---

## 2. 삭제 / 유지 / 신규 — 파일 단위

### 2.1 [DELETE] Geny에서 완전히 사라지는 것

| 파일 | 사유 | executor 대체물 |
|---|---|---|
| [service/memory/embedding.py](../../backend/service/memory/embedding.py) | 자체 httpx 호출, 'anthropic'→Voyage 헷갈리는 매핑 | [memory/embedding/{openai,voyage,google,local}.py](../../../geny-executor/src/geny_executor/memory/embedding/) |
| [service/memory/vector_store.py](../../backend/service/memory/vector_store.py) | FAISS-cpu 직접 사용 | [memory/providers/file/vector_store.py](../../../geny-executor/src/geny_executor/memory/providers/file/vector_store.py) (pure-Python) 또는 sql/pgvector |
| [service/memory/vector_memory.py](../../backend/service/memory/vector_memory.py) | FAISS 오케스트레이션 | `MemoryProvider.vector()` |
| [service/memory_provider/adapters/vector_adapter.py](../../backend/service/memory_provider/adapters/vector_adapter.py) | 의도적 stub (`return None`) | 더 이상 어댑터 필요 없음, executor 직접 사용 |
| [service/memory/index.py](../../backend/service/memory/index.py) | `_index.json` rebuild + 링크 해석 | `MemoryProvider.index()` (IndexHandle) |
| [service/memory/structured_writer.py](../../backend/service/memory/structured_writer.py) | 노트 write/update + 백링크 전파 + DB dual-write | `NotesHandle.write/update/delete/link` |
| [service/memory/frontmatter.py](../../backend/service/memory/frontmatter.py) | YAML frontmatter render + wikilink regex | executor의 NotesHandle이 frontmatter를 dict로 노출 — Geny에서 직접 파싱 불필요 |
| [service/memory/compaction_archiver.py](../../backend/service/memory/compaction_archiver.py) | Compaction snapshot 직접 쓰기 | `MemoryProvider.record_compaction(...)` (s02 compactor stage가 직접 호출) |

**의존성 변경**: `pyproject.toml`에서 `faiss-cpu>=1.9.0` 제거. file provider는 pure-Python, sql provider는 sqlite-vss / pgvector로 처리.

### 2.2 [PORT, slim] 비즈니스 로직만 남기고 executor handle 호출로 전환

| 파일 | 변경 |
|---|---|
| [service/memory/conversation_archiver.py](../../backend/service/memory/conversation_archiver.py) | counterpart-aware rollup 로직 유지. 디스크 쓰기는 `notes_handle.write(NoteDraft(...))` / `notes_handle.update(filename, NotePatch(append_body=...))`로. `compute_importance()`도 비즈니스라 유지. |
| [service/memory/dm_archiver.py](../../backend/service/memory/dm_archiver.py) | DM 번들 변환 유지. 디스크 쓰기는 NotesHandle. |
| [service/memory/curation_engine.py](../../backend/service/memory/curation_engine.py) | 5-stage LLM pipeline 그대로. Stage 5 Store는 `curated_handle.notes().write(...)` 또는 (Phase 2d 미구현 시) `notes_handle.write(scope=USER)`로. |
| [service/memory/curated_knowledge.py](../../backend/service/memory/curated_knowledge.py) | thin wrapper로 격하 — `provider.curated().notes()` / `provider.curated().vector()` 호출 + 비즈니스 helper(promote 정책 등). search 자체는 handle이 함. |
| [service/memory/user_opsidian.py](../../backend/service/memory/user_opsidian.py) | thin wrapper — `provider_for_user(username).notes()`. graph도 `index().graph()` 호출. |
| [service/memory/manager.py](../../backend/service/memory/manager.py) | `SessionMemoryManager`는 `MemoryProviderFactory.build(...)`로 provider를 만들고 그것을 보유. record_message는 `provider.record_turn`, retrieval은 `provider.retrieve(RetrievalQuery)`. |

### 2.3 [KEEP] 순수 비즈니스 로직

| 파일 | 이유 |
|---|---|
| [service/memory/curation_engine.py](../../backend/service/memory/curation_engine.py) | LLM prompt + 5-stage 정책. executor가 모를 영역. |
| [service/memory/curation_scheduler.py](../../backend/service/memory/curation_scheduler.py) | 정책 (자동 트리거 cron). |
| [service/memory/dedupe_strategy.py](../../backend/service/memory/dedupe_strategy.py) | dedupe 정책 (전제: 살아 있다면 — 내용 미확인). |
| [service/memory/pin_policy.py](../../backend/service/memory/pin_policy.py) | 동상. |
| `service/memory/types.py`, `interaction_event.py`, `host_memory_tools_block.py` | Geny 스키마 / system prompt block. |

### 2.4 [NEW in executor] Phase 2d 마무리 — Geny가 의존하는 부분

executor의 file/sql provider에서 아직 미구현인 부분 — **Geny가 cut over하려면 이게 먼저 끝나야 한다**:

| 빠진 것 | 어디 |
|---|---|
| `CuratedHandle` (file + sql) | [providers/file/provider.py:143](../../../geny-executor/src/geny_executor/memory/providers/file/provider.py#L143) `return None` |
| `GlobalHandle` (file + sql) | [providers/file/provider.py:146](../../../geny-executor/src/geny_executor/memory/providers/file/provider.py#L146) `return None` |
| `promote_from_session` 구현 | CuratedHandle Protocol에 정의됐지만 구현 미완 |

**선택지 A**: Geny PR을 막기 전에 executor에서 Phase 2d 먼저 머지. 정도(正道).
**선택지 B**: Geny가 임시로 NotesHandle (Scope.USER + 별도 root 경로)로 curated를 표현 → executor Phase 2d 후 swap. 빠르지만 두 번 작업.

권장 **A**. Phase 2d는 file provider 기준 ~150~200줄 + 테스트. SQL은 더 큼. 일단 file provider만 완성해도 Geny cut over 가능.

---

## 3. config 통합 — 사용자가 보는 settings

### 3.1 LTMConfig 폐기 / 재설계

[ltm_config.py](../../backend/service/config/sub_config/general/ltm_config.py)의 모든 필드를 executor의 [MemoryProviderFactory](../../../geny-executor/src/geny_executor/memory/factory.py) 입력 dict로 매핑:

```python
# 기존 LTMConfig 필드 → MemoryProviderFactory config
{
    "provider": "composite",
    "session_id": <sid>,
    "scope": "session",
    "providers": {
        "session_main": {
            "provider": "file",
            "root": "<storage>/sessions/<sid>",
            "embedding": {
                "provider": "openai",
                "model": "text-embedding-3-small",
                "api_key": <from-secrets>,
            },
        },
        "user_curated": {
            "provider": "file",                         # 또는 "sql"
            "root": "<storage>/_curated_knowledge/<user>",
            "embedding": { ...same as above... },
            "scope": "user",
        },
    },
    "layers": {
        "stm": "session_main", "ltm": "session_main",
        "notes": "session_main", "vector": "session_main",
        "index": "session_main",
    },
    "scope_providers": {
        "user": "user_curated",        # provider.curated() / scope=USER 라우팅
    },
}
```

LTMConfig가 사용자에게 보이는 것은 그대로 유지 (UI는 변하지 않음 — provider/model/api_key/chunk/top_k):
- 사용자는 여전히 "OpenAI text-embedding-3-small + 키"를 입력.
- 그 입력이 LTMConfig가 아닌 `MemoryProviderConfig` (또는 같은 이름 유지)로 저장.
- 부팅 시 `ConfigManager` → `MemoryProviderFactory.build(config)` → `agent_session`이 받음.

### 3.2 LLM 키와의 통합 (사용자 요청 — 이전 사이클 P2)

`embedding.provider == "openai"`이고 키가 비면 `OPENAI_API_KEY` env 자동 fallback. provider별 표준 env. — **이번 통합 PR에 같이 들어감**(작은 추가).

---

## 4. Pipeline / agent_session wiring

### 4.1 현재 (제거 대상)

[agent_session.py:817-826](../../backend/service/executor/agent_session.py#L817-L826):
```python
# Geny 자체 SessionMemoryManager + VectorMemoryManager 생성
self._init_memory()
await self._memory_manager.initialize_vector_memory()
```

### 4.2 cut over 후

```python
# config → MemoryProvider 생성 (executor)
from geny_executor.memory.factory import MemoryProviderFactory

config = build_memory_config(
    storage_path=self.storage_path,
    username=self._owner_username,
    session_id=self._session_id,
    settings=load_memory_settings(),     # Geny config UI에서 온 dict
)
self._memory_provider = MemoryProviderFactory().build(config)
await self._memory_provider.initialize()
```

그리고 `Pipeline.attach_runtime`에 그것을 넘김:

```python
self._pipeline.attach_runtime(
    memory_provider=self._memory_provider,    # executor가 stage들에게 자동 라우팅
    ...
)
```

Stage 2 (context), Stage 18 (memory), Stage 19 (summarize), Stage 20 (persist)이 그 provider를 받아 `record_turn / retrieve / record_execution` 호출 — Geny 코드 한 줄 안 들어감.

### 4.3 Geny의 ConversationArchiver / DmArchiver의 위치

이건 Stage 18 외부에서 **이벤트 핸들러로 트리거**되는 비즈니스 transform이다 — Geny가 매 턴/매 DM event에 대해 호출. 디스크 쓰기 시점에 `provider.notes().write(...)` 또는 `provider.notes().update(filename, NotePatch(append_body=...))`로 위임.

즉:
```
event (turn / dm / compaction)
  ↓
Geny ConversationArchiver.archive(event)        # counterpart-bucket 결정, importance 계산
  ↓ NoteDraft(category="conversations", body=..., importance=..., ...)
  ↓
provider.notes().write(draft)                   # 또는 update(filename, patch)
  ↓
[file provider] 디스크 쓰기 + 백링크 전파 + 인덱스 갱신 + (선택) vector indexing
```

vector indexing은 NotesHandle.write 안에서 자동으로 일어나야 하나? 또는 명시적 `provider.vector().index(ref, body)` 호출인가?

→ 현재 executor의 file provider는 **수동**: `record_execution`에서 명시적 `vector.index()` 호출 ([provider.py:179](../../../geny-executor/src/geny_executor/memory/providers/file/provider.py#L179)). NotesHandle.write는 vector를 안 건드림.

선택:
- A. NotesHandle.write에 `auto_vector: bool = True` 옵션 추가 (executor 변경)
- B. Geny ConversationArchiver가 write 후 명시적으로 vector.index 호출
- 권장 **A** — "디스크에 들어가면 자동으로 검색 가능해진다"는 사용자 직관적 모델. executor 측 작은 변경.

---

## 5. 구체 PR 분할

기존 세션 0개라 destructive cut. 그러나 각 PR이 boot 가능하게 유지.

### PR-1 — executor 측 Phase 2d 완성 (CuratedHandle / GlobalHandle / NotesHandle.auto_vector)

**저장소**: `geny-executor`

| 작업 | 변경 |
|---|---|
| `providers/file/curated_store.py` 신규 | NotesHandle 위에 user_id 스코핑한 wrapper. promote_from_session 구현 |
| `providers/file/global_store.py` 신규 | NotesHandle 위에 cross-session scoping |
| `providers/file/provider.py` | `curated()` / `global_()` 가 더 이상 None 안 반환 |
| `provider.py` Protocol | `NotesHandle.write` 시그니처에 `auto_vector: bool = True` 추가 (선택) |
| 테스트 | `test_curated_handle_*`, `test_global_handle_*` |
| 버전 | minor bump (1.15.0 → 1.16.0) |

**Note**: SQL provider의 Phase 2d는 후속 PR로 분리 가능. file provider만 있으면 Geny cut over 가능.

### PR-2 — Geny 측 dependency 추가 + 자체 vector/embedding 삭제

**저장소**: `Geny`

| 작업 | 변경 |
|---|---|
| `pyproject.toml` | `geny-executor>=1.16.0` (PR-1의 새 버전), `faiss-cpu` 제거, `geny-executor[openai]` extra 활성 |
| 삭제 | `service/memory/{embedding,vector_store,vector_memory,index,structured_writer,frontmatter,compaction_archiver}.py` (§2.1 표) |
| 삭제 | `service/memory_provider/adapters/vector_adapter.py` |
| 삭제 | docs `MEMORY.md` / `MEMORY_KO.md`의 FAISS 직접 사용 묘사 갱신 |
| 새 helper | `service/memory/provider_factory.py` — `LTMConfig + storage_path → executor MemoryProviderFactory config dict` |

이 PR은 backend가 **boot 가능 상태**여야 한다. 즉 archiver / curation_engine은 PR-3에서 손대고, PR-2는 인프라만 swap. 그 중간에 archiver들은 임시로 `NotImplementedError` 또는 NotesHandle 직접 호출하는 stub.

### PR-3 — archiver / curation / manager port

| 작업 | 변경 |
|---|---|
| `conversation_archiver.py` | 디스크 호출 부분을 `provider.notes()` API로 |
| `dm_archiver.py` | 동상 |
| `curation_engine.py` Stage 5 | `curated.notes().write` 또는 fallback `notes().write(scope=USER)` |
| `curated_knowledge.py` | thin wrapper로 격하 (`provider.curated()` 위임) |
| `user_opsidian.py` | thin wrapper |
| `manager.py` SessionMemoryManager | provider 보유, record_turn / retrieve 위임 |
| `agent_session.py` | `_init_memory` 단순화 — provider 빌드 + attach_runtime |
| 테스트 | 기존 테스트들이 stub provider로 돌아가게 |

### PR-4 — knowledge_tools에 vector path + Curated FAISS 활성화 트리거

이전 사이클의 [FAISS_EMBEDDING_INTEGRATION_AUDIT.md](../analysis/FAISS_EMBEDDING_INTEGRATION_AUDIT.md) 의 PR-1 의제. cut over 끝나면 자연스럽게 묶여 들어옴 — `provider.curated().vector().search(...)` 호출이 그 핵심. KnowledgeSearch built-in tool도 그 path 사용.

### PR-5 — provider 표준 env fallback (작은 cleanup)

LTM_EMBEDDING_API_KEY가 비고 provider=openai이면 OPENAI_API_KEY로 fallback. embedding 빌드 시점에 처리.

---

## 6. 검증 / acceptance criteria

cut over가 끝났음을 확인하는 invariant들:

- [ ] `grep -r "import faiss\|faiss\." Geny/backend/` → 0 hit
- [ ] `grep -r "from service.memory.embedding\|VectorMemoryManager\|SessionVectorStore" Geny/backend/` → 0 hit
- [ ] `pip install -e .` 후 `python -c "import faiss"` → ModuleNotFoundError (의존성 떨어짐)
- [ ] 새 세션 만들기 → 디스크 layout이 executor의 `DirectoryLayout` 형식과 일치
- [ ] 사용자가 settings에서 OpenAI 키 + provider=openai + model=text-embedding-3-small 입력 → `MemoryDescriptor.embedding`이 그것으로 채워짐
- [ ] curated_handle 사용 — `provider.curated().notes().write(NoteDraft(...))`로 노트 들어감
- [ ] embedding swap (3-small → 3-large) 시도 → `MemoryDescriptor.compatibility_check`가 ReindexPlan 반환, UI에 reindex 확인 다이얼로그 (또는 CLI 메시지) 노출
- [ ] `provider.retrieve(RetrievalQuery(text=..., layers={NOTES, VECTOR}))` 호출 → 두 layer 통합 결과 + cost event

---

## 7. 위험 / 미해결

1. **executor `NotesHandle.write`의 자동 vector indexing** — Phase 2d 작업 시 결정. 자동(opt-out)인가 수동(opt-in)인가? 권장: 자동. 사용자가 "노트가 들어가면 검색됨"이 자연스럽다.
2. **embedding swap 시 reindex 정책** — `ReindexPlan.requires_explicit_approval=True`라 자동 reindex 안 일어남. UI에서 "재인덱싱하시겠습니까?" 확인 흐름이 필요. 이번 cut over에 포함할지 후속 사이클로 미룰지 결정.
3. **FAISS-cpu 제거의 backwards compat** — clean slate라 무관. 단 docker image 재빌드 시 dep set 변경 (이미지 슬림해짐).
4. **Geny의 ConversationArchiver의 H2 anchor rollup 형식** — executor의 `NotesHandle.update(NotePatch(append_body=...))`가 H2 anchor 단위 append를 native로 지원하는지? 안 하면 `read → 본문 mutate → write` 풀 round-trip 필요. 미세하지만 atomic write 보장 측면 확인 필요.
5. **executor의 `compute_importance` 등가물 부재** — Geny의 rule-based importance 결정은 비즈니스 정책이라 executor엔 없음. NoteDraft 만들 때 Geny가 importance를 직접 채워 넣음 — 인터페이스상 문제 없음.
6. **Composite provider에서 user-scope 라우팅** — `scope_providers={"user": "user_curated"}`가 의도대로 동작하는지 테스트 케이스 필요. Geny에서 "user-scoped 노트를 쓰면 user_curated provider로 라우팅"이 핵심 invariant.

---

## 8. 결정 사안 (사용자에게 묻는 것)

이 plan을 실행하려면 다음 결정이 필요:

**Q1**. executor Phase 2d (CuratedHandle/GlobalHandle, file provider 한정)부터 진행 — 동의?
- (a) Yes, file provider만 Phase 2d 마무리 → Geny cut over.
- (b) SQL provider도 같이.
- (c) Geny 임시 wrapper로 시작, executor Phase 2d는 백로그 (선택지 B).

**Q2**. NotesHandle.write의 auto_vector 정책
- (a) 자동 인덱싱 (write가 곧 검색 가능). 권장.
- (b) 수동 — Geny가 명시적으로 `vector.index()` 호출.

**Q3**. provider 선택 — file vs sql 어디부터?
- Geny는 이미 PostgreSQL 사용 중 (`psycopg[binary]` 의존). 그래서:
- (a) 처음부터 sql provider — pgvector 활용, 멀티 호스트 친화.
- (b) file provider 먼저, 운영 데이터로 검증 후 sql로 swap.
- 권장 **(b)** — 짧은 첫 사이클 + clean slate라 file로 시작해도 데이터 잃을 게 없음.

**Q4**. 단일 큰 PR vs 5개 분할
- Plan §5는 5개로 쪼갬. 단일 PR로 다 진행하면 risk가 크지만 cycle은 빠름. clean slate라 single big PR도 사실상 안전.
- 권장: **§5 분할 유지** — 머지 후 boot/test 가능성을 단계별로 보장. 첫 PR-1 (executor)이 가장 무겁고, PR-2~5는 점진.

답 주면 바로 PR-1부터 시작.
