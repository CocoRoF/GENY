# FAISS / Embedding 통합 — Config·Wiring 심층 검토

> 작성: 2026-05-04 · 범위: Geny `service/memory/` (vector + curated) + LTMConfig + geny-executor `memory/embedding/`
> 자매 문서: [KNOWLEDGE_GRAPH_EXTRACTION_DEEP_DIVE.md](./KNOWLEDGE_GRAPH_EXTRACTION_DEEP_DIVE.md) — 그래프 추출 고도화 (P1으로 semantic edge 제안)
>
> 사용자 질문: "OpenAI embedding 모델을 config로 제대로 설정할 수 있는 환경인지" + "geny-executor가 이런 것들을 제대로 받아주는 환경인지". 이 둘을 코드로 추적해 답한다.

---

## 0. 한 줄 진단

**Config로 OpenAI embedding을 설정하는 인프라는 거의 완비**돼 있다 — `LTMConfig`에 provider/model/api_key/chunk/top_k 다 모여 있고, env_sync로 `LTM_EMBEDDING_API_KEY` 환경 변수와도 묶여 있고, `VectorMemoryManager.initialize()`가 정확히 그것을 읽어 `OpenAIEmbedding` 인스턴스를 만든다. **하지만 활성 경로가 한 쪽만 살아있다**: session memory vector는 `agent_session.py`에서 자동 init되지만, **CuratedKnowledgeManager.initialize_vector()를 호출하는 코드가 어디에도 없어** Curated vault의 FAISS는 영구 dormant 상태다 (`build_curated_context`도 호출자 없는 dead code). `KnowledgeSearch` built-in도 키워드 path만 쓴다.

**geny-executor는 자체 embedding 시스템을 보유**하지만 (`memory/embedding/{openai,voyage,google,local}.py`, openai SDK 기반), Geny가 그것을 활용하지 않고 자체 `service/memory/embedding.py` (httpx 직접) 평행 시스템을 운영한다. 두 시스템 사이 가교 (`memory_provider/adapters/vector_adapter.py`)는 stub 상태 (`return None`). 그래서 "geny-executor가 받아준다"의 답은 — **현재로선 받아줄 통로가 의도적으로 막혀 있고, Geny 측 embedding이 단독 운용 중**.

→ FAISS 엔진을 "제대로 작동"시키려면 새 embedding 인프라를 만들 게 아니라 **이미 있는 wiring 끊긴 곳 4개를 잇는 것**이 일이다.

---

## 1. 시스템 지형

### 1.1 두 개의 평행 embedding 시스템

| 시스템 | 위치 | API 호출 | 지원 provider | 사용처 |
|---|---|---|---|---|
| **Geny** (host-side) | [backend/service/memory/embedding.py](../../backend/service/memory/embedding.py) | `httpx.AsyncClient` 직접 호출 | openai / google / **anthropic→Voyage** (이름 혼선) | `VectorMemoryManager`, `CuratedKnowledgeManager` |
| **geny-executor** (lib-side) | [geny-executor/src/geny_executor/memory/embedding/](../../../geny-executor/src/geny_executor/memory/embedding/) | OpenAI SDK + Google SDK + Voyage REST | openai / voyage / google / **local (SHA-256)** | executor의 `MemoryProvider` (file / sql backend) |

같은 OpenAI `text-embedding-3-small`을 두 시스템이 각자 호출. 차이:
- Geny: dependency 0개 (httpx만), 가벼움. 'anthropic' 키워드를 voyage로 매핑하는 약간 헷갈리는 naming ([embedding.py:227](../../backend/service/memory/embedding.py#L227)).
- executor: openai SDK 사용 → AsyncOpenAI 타입 안전성. `local` hash provider 보너스 (테스트/오프라인용).

**현재 Geny는 executor 쪽 embedding을 호출하지 않는다.** [vector_adapter.py:44-60](../../backend/service/memory_provider/adapters/vector_adapter.py#L44-L60)가 명시적으로 `return None` — provider-backed indexing은 follow-up PR로 미뤘고, legacy FAISS path가 authoritative.

### 1.2 세 개의 vault layer × FAISS 활용 현황

| Vault | manager | FAISS 사용 |
|---|---|---|
| **Session memory** (`{storage}/sessions/<sid>/memory/`) | `SessionMemoryManager` ([memory/manager.py](../../backend/service/memory/manager.py)) | ✅ 자동 init (`initialize_vector_memory`) |
| **Curated knowledge** (`{storage}/_curated_knowledge/<user>/`) | `CuratedKnowledgeManager` ([curated_knowledge.py](../../backend/service/memory/curated_knowledge.py)) | ❌ wiring 끊김 |
| **User Opsidian** (`{storage}/_user_opsidian/<user>/`) | `UserOpsidianManager` ([user_opsidian.py](../../backend/service/memory/user_opsidian.py)) | ❌ FAISS 미지원 (디자인상) |

User Opsidian이 FAISS 미지원인 건 design choice — raw 사용자 노트 layer라 검색은 키워드 충분, 의미 검색은 Curated로 promote된 후. 그래서 정말 필요한 것은 **Curated FAISS를 살리는 것**.

---

## 2. Config 흐름 — OpenAI 키가 LLM까지 가는 6단계

```
[1] 사용자 UI (Settings → Long-Term Memory 섹션)
       ↓ ConfigField (FieldType.PASSWORD, secure=True)
[2] Geny ConfigManager.save_config(LTMConfig)
       ↓ apply_change=env_sync("LTM_EMBEDDING_API_KEY")
[3] os.environ["LTM_EMBEDDING_API_KEY"] = "sk-..."
       ↓ + JSON 파일 영속화 (settings.json)
[4] Boot 후 ConfigManager.load_config(LTMConfig)
       ↓
[5] VectorMemoryManager.initialize() / CuratedKnowledgeManager.initialize_vector()
       ↓ get_embedding_provider("openai", "text-embedding-3-small", api_key=...)
[6] OpenAIEmbedding.embed_batch(texts) → POST https://api.openai.com/v1/embeddings
```

각 단계 코드 검증:

### [1]→[2] UI 폼 → ConfigManager
[ltm_config.py:294-303](../../backend/service/config/sub_config/general/ltm_config.py#L294-L303):
```python
ConfigField(
    name="embedding_api_key",
    field_type=FieldType.PASSWORD,
    placeholder="sk-… / AIza… / pa-…",
    secure=True,                                    # 마스킹된 응답
    apply_change=env_sync("LTM_EMBEDDING_API_KEY"), # 변경시 env 동기화
),
```
- `secure=True`: API GET 응답에서 마스킹 처리 (UI에 평문 노출 안 됨).
- `apply_change`: 폼 저장시 **즉시** `os.environ`에 반영 → 서버 재시작 없이 유효.
- 저장: settings.json (또는 DB). `_to_env_str` 통해 stringify.

### [2]→[3] env_sync 콜백
[env_utils.py:166-184](../../backend/service/config/sub_config/general/env_utils.py#L166-L184):
```python
def env_sync(env_key):
    def _apply(_old, new_value):
        os.environ[env_key] = _to_env_str(new_value)
    return _apply
```
- `.env` 파일은 **읽기 전용 fallback** (주석 명시). 저장은 settings.json만.
- 즉 키는 두 곳에 사는 셈: `settings.json` (영속) + `os.environ` (런타임 캐시).

### [3]→[4] Boot 시점 reload
[ltm_config.py:101-104](../../backend/service/config/sub_config/general/ltm_config.py#L101-L104):
```python
@classmethod
def get_default_instance(cls) -> "LTMConfig":
    defaults = read_env_defaults(cls._ENV_MAP, cls.__dataclass_fields__)
    return cls(**defaults)
```
`_ENV_MAP = {"embedding_api_key": "LTM_EMBEDDING_API_KEY"}` — 즉 **첫 부팅 시** 키가 settings.json에 없어도 `LTM_EMBEDDING_API_KEY` env를 읽어 default로 채움. 운영 환경에서 docker-compose env로 키를 박아두는 시나리오 OK.

### [4]→[5] config → provider 인스턴스
[vector_memory.py:100-124](../../backend/service/memory/vector_memory.py#L100-L124):
```python
config = self._load_config()
if config is None or not config.enabled: return False
api_key = config.embedding_api_key or os.environ.get("LTM_EMBEDDING_API_KEY", "")
if not api_key:
    logger.warning("VectorMemoryManager: no embedding API key configured")
    return False
self._provider = get_embedding_provider(
    provider_name=config.embedding_provider,
    model=config.embedding_model,
    api_key=api_key,
)
```
- config 값 우선 → env fallback → 둘 다 비면 disabled.
- silent fail: 로그만 남기고 disabled로 떨어짐. throw 안 함 → caller가 "vector 비활성"을 알 수 있어야 함.

### [5]→[6] OpenAI HTTP 호출
[embedding.py:79-106](../../backend/service/memory/embedding.py#L79-L106):
```python
async def embed_batch(self, texts):
    payload = {"input": batch, "model": self.model}
    headers = {"Authorization": f"Bearer {self.api_key}", ...}
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(_OPENAI_URL, json=payload, headers=headers)
        resp.raise_for_status()
        ...
```
- 60초 timeout, batch=96. 적절.
- 실패 시 `raise_for_status()` → 호출자에서 catch → `logger.warning + return 0` ([vector_memory.py:258-263](../../backend/service/memory/vector_memory.py#L258-L263)).

**결론**: 1~6 모든 단계가 정확히 작동한다. **OpenAI 키를 UI에서 입력하면 그 키가 OpenAI HTTP까지 흘러가고, embedding이 vector store에 들어간다 — session memory에 한해서는**.

---

## 3. 살아있는 path: Session Memory Vector ✓

Boot → 세션 생성 → vector init 자동:

```
AgentSession.revive() / build_pipeline()
   ↓
SessionMemoryManager.initialize_vector_memory()      # agent_session.py:822, 961
   ↓
VectorMemoryManager.initialize()                     # config 로드, provider 생성
   ↓
VectorMemoryManager.index_memory_files()             # 기존 .md 모두 청킹+임베딩
```

[agent_session.py:817-826](../../backend/service/executor/agent_session.py#L817-L826):
```python
if not self._memory_manager:
    self._init_memory()
    if self._memory_manager:
        try:
            await self._memory_manager.initialize_vector_memory()
        except Exception as ve:
            logger.debug(f"... Vector memory init skipped on revive: {ve}")
```

검증:
- LTMConfig.enabled=True + key 있음 + memory dir 존재 → ✅ session memory에 FAISS index 생성, `<storage>/sessions/<sid>/memory/_vector/` 아래.
- LTMConfig.enabled=False → silent skip, 키워드만 사용.

**이 path는 사용자가 LTMConfig.enabled=True + embedding_api_key=sk-... 만 설정하면 즉시 동작한다.**

---

## 4. 끊긴 path: Curated Knowledge Vector ❌

### 4.1 인프라는 모두 있음

[curated_knowledge.py:103-127 `initialize_vector()`](../../backend/service/memory/curated_knowledge.py#L103-L127):
```python
async def initialize_vector(self) -> bool:
    if self._vector is not None:
        return self._vector.enabled
    try:
        from service.memory.vector_memory import VectorMemoryManager
        self._vector = VectorMemoryManager(self.memory_dir)
        ok = await self._vector.initialize()
        return ok
    ...
```

[curated_knowledge.py:600-632 `build_curated_context()`](../../backend/service/memory/curated_knowledge.py#L600-L632):
```python
async def build_curated_context(self, query, *, max_chars=5000, top_k=5):
    if not self.vector_enabled or self._vector is None: return ""
    results = await self._vector.search(query, top_k=top_k)
    ...
    return XML-tagged chunks
```

→ vector init + semantic search + context block 빌더 다 코드로 존재.

### 4.2 호출자가 없다

```
$ grep -rn "initialize_vector\b" backend/  # 정의 외 호출
backend/service/memory/curated_knowledge.py:103  ← 정의 자체
backend/service/memory/curated_knowledge.py:221  ← docstring 언급
(no other call site)
```

```
$ grep -rn "build_curated_context\b" backend/
(no match — 호출자 0건)
```

즉 **만들어진 후 누구도 호출하지 않는 dead infrastructure**. session memory에는 [agent_session.py:822](../../backend/service/executor/agent_session.py#L822)가 있는데 curated에는 대응되는 line이 없음.

### 4.3 Knowledge Search 도구도 키워드만

[knowledge_tools.py:130-134](../../backend/tools/built_in/knowledge_tools.py#L130-L134) — agent가 호출하는 `KnowledgeSearch` built-in 도구:
```python
if config is None or not config.curated_knowledge_enabled:
    return []
curated, _ = _get_context_managers(session_id)
results = curated.search(query, max_results=max_results)  # ← keyword search만
```

`curated.search()` ([curated_knowledge.py:209-265](../../backend/service/memory/curated_knowledge.py#L209-L265))가 키워드 path. semantic search 분기 없음.

→ agent가 도구로 curated knowledge를 검색해도 **벡터 인덱스를 비껴간다**. FAISS는 떠 있어도 (만약 떴다면) 활용되지 않음.

---

## 5. geny-executor와의 관계

### 5.1 평행 embedding 시스템 — 미통합

executor는 `memory/embedding/` 아래 4개 client + factory + EmbeddingDescriptor 구조. EmbeddingDescriptor는 provider/model/dimension/metric/api_key_present를 들고 다닌다 — 즉 executor의 vector_store가 어떤 임베딩 모델로 인덱싱됐는지 자기 기술 가능.

executor의 `memory/providers/{file,sql}/vector_store.py`가 embedding client를 받아 인덱싱·검색. 즉 **executor의 LongTermMemory는 자체 vector store를 운용 가능**한 상태다.

### 5.2 Geny가 그것을 받지 않는다

[vector_adapter.py:44-60](../../backend/service/memory_provider/adapters/vector_adapter.py#L44-L60):
```python
async def try_index_text(session_id, text, source_file, *, replace=False):
    if legacy_vector_enabled():
        return None     # legacy(=Geny 자체) FAISS 사용
    _maybe_warn()
    return None         # 의도적으로 미구현 — provider path 막힘
```

주석에 명시:
> Today the adapter always declines (returns ``None``), keeping the legacy FAISS write path authoritative. ... Vector migration is the heaviest of the five layers — switching providers requires a re-embedding/migration pass over existing chunks. **This PR explicitly does not attempt that**.

즉 **의도적으로 분리** 상태. Geny가 자체 embedding으로 커버하고, executor의 embedding은 사용 안 함.

### 5.3 결론 — "executor가 받아주는가?"

- 받아줄 수 있게 만든 인프라(`vector_adapter`)는 있음.
- 그러나 **현재 코드는 의도적으로 그 path를 막아둠**.
- 막은 이유: 마이그레이션 비용 (기존 FAISS index의 재임베딩).
- **결론**: 지금은 안 받음. 받게 만들 수도 있지만 그건 더 큰 작업이고 **지금 목표(Curated FAISS 작동)에는 불필요**. Geny 자체 embedding 인프라가 이미 충분.

---

## 6. 활성화에 필요한 변경 (작은 것부터 큰 것 순)

목표: 사용자가 settings UI에서 OpenAI 키 + LTM enabled + Curated Knowledge enabled + Curated Vector enabled를 켜면 **즉시 Curated FAISS가 작동**하고 agent가 의미 검색을 활용한다.

### Change 1 — Curated init 트리거 wiring [P0, ~20줄]

**문제**: `CuratedKnowledgeManager.initialize_vector()`가 어디서도 호출 안 됨.

**수정**: `agent_session.py`의 vector_memory init 다음에 curated vector init도 같이 호출 (config 검사 포함). 또는 `get_curated_knowledge_manager(username)` 첫 호출 시 lazy init.

옵션 A — eager (boot 직후 background):
```python
# main.py boot lifecycle
@app.on_event("startup")
async def _bootstrap_curated_vector():
    config = LTMConfig.get_or_default()
    if not (config.enabled and config.curated_knowledge_enabled and config.curated_vector_enabled):
        return
    # 알려진 username 목록을 돌며 lazy 생성. 또는 첫 세션 attach 시점에.
    ...
```

옵션 B — lazy (agent_session 내에서):
```python
# agent_session.py:1462 근처
if curated_km is not None and config.curated_vector_enabled:
    try:
        await curated_km.initialize_vector()
    except Exception:
        logger.debug("Curated vector init skipped", exc_info=True)
```

권장: **B**. session attach 시점 트리거가 자연 — 사용자별 init 타이밍 분산되고, "이 사용자는 정말 curated를 쓸 것인가" 시점에 정확히 init.

### Change 2 — KnowledgeSearch에 vector path 추가 [P0, ~30줄]

**문제**: agent가 호출하는 도구가 키워드만 사용 → 인프라 살려놔도 활용 안 됨.

**수정**: [knowledge_tools.py:119-145](../../backend/tools/built_in/knowledge_tools.py#L119-L145)에 vector branch.

```python
async def execute(self, ...):
    config = LTMConfig.get_or_default()
    if not config.curated_knowledge_enabled:
        return []
    curated, _ = _get_context_managers(session_id)
    if curated is None: return []

    # NEW: vector path 우선
    if config.curated_vector_enabled and curated.vector_enabled:
        await curated.initialize_vector()  # idempotent
        v_results = await curated._vector.search(query, top_k=max_results)
        if v_results:
            return [_format_vector_result(r, curated) for r in v_results]

    # FALLBACK: 키워드
    return curated.search(query, max_results=max_results)
```

또는 `curated.search()` 자체에 vector branch를 넣어 caller가 모르는 통합 search로 만드는 게 더 깔끔.

권장: **`CuratedKnowledgeManager.search()` 내부에 hybrid 패스 추가**. 외부 API 변하지 않음.

### Change 3 — index_memory_files에 curated path [P0, ~10줄]

**문제**: vector init까지 됐어도 노트를 인덱싱해야 검색 가능. session memory는 `index_memory_files()`가 자동 호출 ([manager.py:264](../../backend/service/memory/manager.py#L264)). curated 쪽은 이 호출이 없음.

**수정**: `CuratedKnowledgeManager.initialize_vector()` 안에서 init 성공 후 `await self._vector.index_memory_files()` 자동 호출. 단 — `VectorMemoryManager.index_memory_files()`는 `<storage_path>/memory/*.md`를 스캔하는데, curated는 디렉토리 구조가 다름 (`<storage_path>/_curated_knowledge/<user>/{topics,decisions,...}/*.md`). 즉 path 차이 처리 필요.

[vector_memory.py:180](../../backend/service/memory/vector_memory.py#L180):
```python
memory_dir = Path(self._storage_path) / "memory"
```

→ curated에서는 `self._storage_path = curated_memory_dir` (curated_knowledge.py:114 `VectorMemoryManager(self.memory_dir)`), 즉 self._storage_path가 이미 `_curated_knowledge/<user>/`를 가리킨다. 그런데 그 아래 `memory/` 서브디렉토리가 없으니 `md_files = []` → 인덱싱 0건.

**수정 옵션**:
- A. `VectorMemoryManager.index_memory_files()`에 `subdir: str = "memory"` 인자 추가, curated에서 `subdir=""` 또는 `"."` 전달.
- B. curated 전용 indexing 메서드를 `CuratedKnowledgeManager`에 두고 `_vector.index_text()`를 노트별 호출.

권장: **A**. `index_memory_files(subdir=...)` 한 줄 변경으로 양쪽 다 작동.

### Change 4 — LTM_EMBEDDING_API_KEY → OPENAI_API_KEY 자동 폴백 (선택) [P2, ~10줄]

**현 상태**: 사용자가 LLM call용 OpenAI 키를 이미 ANTHROPIC_API_KEY/별도 OpenAI 키로 박아뒀더라도, embedding은 별도 `LTM_EMBEDDING_API_KEY` 키가 필요. 즉 **두 곳에 같은 OpenAI 키를 입력**해야 하는 UX.

**수정**: [vector_memory.py:108-117](../../backend/service/memory/vector_memory.py#L108-L117)에 추가 fallback chain.
```python
api_key = config.embedding_api_key
if not api_key:
    api_key = os.environ.get("LTM_EMBEDDING_API_KEY", "")
if not api_key and config.embedding_provider == "openai":
    api_key = os.environ.get("OPENAI_API_KEY", "")    # NEW
if not api_key:
    ... disabled
```

provider별로 표준 env에 fallback (openai → OPENAI_API_KEY, voyage → VOYAGE_API_KEY, google → GOOGLE_API_KEY). 사용자가 LLM 키 한 번만 설정하면 embedding도 같이 작동.

### Change 5 — 'anthropic' → 'voyage' 이름 명료화 (선택) [P3, ~30줄]

[embedding.py:227 `_PROVIDER_MAP`](../../backend/service/memory/embedding.py#L227):
```python
_PROVIDER_MAP = {
    "openai": OpenAIEmbedding,
    "google": GoogleEmbedding,
    "anthropic": VoyageEmbedding,    # ← Anthropic은 Voyage AI 파트너인데 이 매핑이 헷갈림
}
```

LTMConfig UI에서 "Anthropic (Voyage)"로 라벨링하지만 실제 string id가 'anthropic' — 사용자가 settings.json을 직접 보면 "왜 anthropic인데 Voyage 키 넣어야 하지?" 혼란. executor는 'voyage'라는 정직한 id 사용 ([executor registry.py:20](../../../geny-executor/src/geny_executor/memory/embedding/registry.py#L20)).

**수정**: provider id를 'voyage'로 통일하고 'anthropic'은 backward-compat alias로. settings.json에 저장된 기존 'anthropic' 값은 마이그레이션 필요.

→ 작은 작업이지만 user-visible string 변화라 backward compat 처리 필요. P3로 미룸.

---

## 7. 우선순위 + PR 사이클

| PR | 내용 | 변경 범위 | 효과 |
|---|---|---|---|
| **PR-1** | Change 1 (curated init wiring) + Change 2 (KnowledgeSearch vector path) + Change 3 (index_memory_files subdir 인자) | 3 파일, ~60줄 | Curated FAISS가 처음으로 실제 동작. KnowledgeSearch가 semantic 결과 반환. |
| **PR-2** | Change 4 (provider별 표준 env fallback) | 1 파일, ~10줄 | UX 단순화 — 키 한 번만 입력 |
| **PR-3** | (선택) Change 5 (anthropic→voyage rename + 마이그레이션) | 4-5 파일 | 명료성 향상, 사용자 노출 string 일관성 |

PR-1 머지 후 검증해야 할 시나리오:
1. settings UI에서 LTM 활성화 + provider=openai + model=text-embedding-3-small + api_key 입력
2. Curated Knowledge enabled + Curated Vector enabled 체크
3. 사용자 vault에 노트가 어느 정도 있는 상태에서 세션 시작
4. agent가 KnowledgeSearch 도구를 호출 → semantic 결과 (점수 포함) 반환되는지 확인
5. `<storage>/_curated_knowledge/<user>/_vector/` 디렉토리에 FAISS index 파일 생성 확인
6. OpenAI dashboard에서 embeddings API 호출 빈도 + 비용 확인

---

## 8. 한계 / 미해결 (이번 사이클 범위 밖)

1. **executor embedding과의 통합** — 두 시스템 평행 운영. 통합하려면 vector_adapter 본 구현 + 마이그레이션 스크립트 필요. 현재 분량으로 **별도 cycle**.
2. **embedding 모델 변경 시 재인덱싱** — 1536 → 3072 (3-small → 3-large)로 바꾸면 기존 인덱스 dimension mismatch. `EmbeddingDescriptor`처럼 인덱스에 모델 메타를 박고 mismatch 시 자동 reindex / 경고 발생 시키는 로직이 Geny 쪽엔 없음. 사용자가 모델 변경 후 _vector/ 디렉토리를 수동 삭제해야 함.
3. **임베딩 비용 통제** — `auto_curation_max_notes_per_run` 같은 cap은 있지만 embedding token budget cap은 없음. 큰 vault 처음 인덱싱 시 갑작스런 OpenAI 비용 발생 가능.
4. **rate limit 대응** — `httpx.AsyncClient(timeout=60.0)`만 있고 retry/backoff 없음. OpenAI rate limit 시 단일 batch 실패하고 그 batch만 logger.warning + return 0. 부분 인덱싱이 silent로 발생.

이 4개는 Curated FAISS가 실제로 돌기 시작한 이후 (PR-1 머지 후) 운영 데이터로 우선순위 정해 후속 사이클에서 처리.

---

## 9. 결론

**"OpenAI embedding을 config로 설정 가능한가"** — **Yes**. LTMConfig에 다 들어 있고, 5단계 흐름 (UI → settings.json → env → load → provider) 다 동작. 키 입력 한 번이면 끝.

**"geny-executor가 받아주는가"** — **현재로선 의도적으로 안 받음**. Geny가 자체 embedding으로 운용. executor 통합은 별도 큰 작업이고 현 목표에 불필요.

**"FAISS 엔진을 제대로 작동시키려면"** — 새로 짤 게 없다. 이미 있는 인프라를 이으면 된다. PR-1 (~60줄, 3 파일)이면 Curated FAISS가 처음으로 실제로 돌고 agent의 KnowledgeSearch가 의미 검색을 활용한다. 이 단계가 끝나야 [KNOWLEDGE_GRAPH_EXTRACTION_DEEP_DIVE.md](./KNOWLEDGE_GRAPH_EXTRACTION_DEEP_DIVE.md)의 P1 (semantic edge)가 의미를 갖는다 — 인덱스가 비어 있으면 semantic edge도 못 만들 테니.

**다음 동작**: PR-1 진행 여부 결정. (Change 1+2+3 묶음, ~60줄, 단일 PR로 처리 가능.)
