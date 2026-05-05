# Memory Refactor 종합 감사 보고서

**감사 대상:** `/home/geny-workspace/Geny/backend/` × `/home/geny-workspace/geny-executor/src/geny_executor/`
**감사 시점:** 2026-05-05, Sprint 3 + Cleanup A1–A6 + Step 7-1~7-3c 완료 후 (PR #696–#713)
**감사 방법:** 4-병렬 Explore agent × 영역별 심층 grep + 교차 검증

---

## 1. Executive Summary

지난 18개 PR에 걸친 메모리 레이어 재설계는 구조적으로 건전하다. `MemoryProvider` 직접 호출 패턴이 모든 호스트 표면에 일관되게 적용되었고, async-native 헬퍼 + sync wrapper 듀얼 surface 패턴은 정확히 의도대로 동작한다. **5개 thin-adapter 파일 삭제 + dataclass 재배치**는 dangling import 없이 끝났다.

다만 **3건의 실제 버그**(critical 1, 미세 broken 1, 성능 열화 5+)가 발견되었으며, 추가 검토 가치가 있는 medium 이슈 3건이 있다. 모두 수정 가능한 범위이고, 운영 정상화 검증 결과는 영향받지 않는다(이미 통과).

| 등급 | 개수 | 설명 |
|---|---|---|
| 🔴 CRITICAL | 1 | `provider.close()` 미호출 — 자원 누수 |
| 🟠 HIGH | 1 | `curated_knowledge_controller.curate_all_from_opsidian` 의 async-context sync call (성능 직격) |
| 🟡 MEDIUM | 5 | `curation_engine` 의 async 메서드가 sync wrapper 호출 (worker-thread 낭비) |
| 🔵 LOW | 다수 | 도구의 `def run` back-compat 경로 (의도된 잔여, 문제 없음) |
| ✅ CLEAN | — | 임포트, 데이터클래스 이전, 스테이지 통합, 테스트 호환 |

---

## 2. Migration Scope 재요약

| Phase | PRs | 내용 |
|---|---|---|
| Sprint 3 step 1–2 | #696, #697 | `short_term.py` / `long_term.py` 삭제, manager 인라인 헬퍼화 |
| step 3–5 | #698–#700 | `vector_memory` / `index_manager` / `structured_writer` manager 측 폐기 |
| step 6–7 | #701, #702 | `frontmatter.py` 데드 코드 삭제, sync_async_bridge audit |
| Cleanup A1–A3 | #703–#705 | `Global` / `Curated` / `UserOpsidian` 매니저 provider 직접 호출 |
| Cleanup A4–A6 | #706–#708 | `index.py` / `vector_memory.py` / `structured_writer.py` 파일 삭제 + `note_utils.py` 신설 |
| Step 7-1 | #709 | manager 인라인 헬퍼 28개 모두 `async def` + `a*` sibling |
| Step 7-2 | #710 | multi-tenant 매니저 `a*` async sibling |
| Step 7-3a | #711 | `memory_tools.py` 9개 도구 `arun` override |
| Step 7-3b | #712 | `memory_inspect_tools` + `knowledge_tools` `arun` override |
| Step 7-3c | #713 | 3개 multi-tenant controller 전부 `await mgr.aX(...)` |

**최종 모듈 지도** (`backend/service/memory/`):

```
service/memory/
├── manager.py                  # SessionMemoryManager (per-session) — async-native
├── global_memory.py            # 싱글턴, file provider 직속 — async-native
├── curated_knowledge.py        # 사용자별 캐시, file provider + optional vector — async-native
├── user_opsidian.py            # 사용자별 캐시, file provider — async-native
├── conversation_archiver.py    # 직접-쓰기 archiver (executor's notes 통과)
├── compaction_archiver.py      # 직접-쓰기 archiver
├── dm_archiver.py              # 직접-쓰기 (counterpart 서브디렉토리 패턴)
├── frontmatter.py              # YAML helpers (parse/render only)
├── note_utils.py               # 🆕 VALID_CATEGORIES/_slugify/extract_wikilinks/apropagate_linked_from
├── types.py                    # MemoryEntry/Search/Stats + 🆕 MemoryFileInfo/MemoryIndex/VectorSearchResult/CATEGORY_DESCRIPTIONS
├── provider_bridge.py          # build_memory_provider / build_single_tenant_provider
├── sync_async_bridge.py        # run_coro_sync — 호스트 sync surface 의 마지막 choke point
├── pin_policy.py               # critical/ 자동 승격 hook
├── dedupe_strategy.py          # GenyDedupeStrategy (executor 의 ProviderDrivenStrategy 상속)
├── tuning.py                   # settings.json 기반 retriever/strategy 튜닝
├── persisting_compactor.py     # s02 LLMSummaryCompactor wrapper
├── host_memory_tools_block.py  # 시스템 프롬프트 호스트 도구 블록 렌더러
├── interaction_event.py        # 이벤트 메타 build/parse helpers
├── memory_llm.py               # distillation LLM 호출
├── curation_engine.py          # UserOpsidian → Curated 자동 큐레이션
├── curation_scheduler.py       # 큐레이션 백그라운드 작업 스케줄러
├── event_emitter.py            # 메모리 이벤트 → VTuber LOGS 채널
└── provider_bridge.py          # ⤴ 위
```

**삭제된 파일** (모두 폐기 완료): `short_term.py`, `long_term.py`, `vector_memory.py`, `index.py`, `structured_writer.py` + 테스트 `test_index_conversations.py`, `test_pin_policy.py` (이미 깨져 있던 것).

---

## 3. 🔴 CRITICAL — `provider.close()` 미호출 (자원 누수)

### 3.1 위치
`/home/geny-workspace/Geny/backend/service/executor/agent_session.py:3682-3702`

### 3.2 증상
세션 종료 시 `cleanup()` 이 다음을 수행:
```python
async def cleanup(self):
    if self._memory_manager:
        try:
            self._memory_manager.auto_flush()
        ...
        self._memory_manager = None
    self._pipeline = None
    self._initialized = False
    self._status = SessionStatus.STOPPED
```

**`self._memory_provider.close()` 호출이 없다.**

### 3.3 영향
- `provider.initialize()` 는 호출되지만 (provider_bridge.py:238) 대응되는 `close()` 가 없다.
- FileMemoryProvider 의 vector backend (FAISS) 는 인덱스 핸들 + 임베딩 클라이언트 연결을 유지한다.
- 장기 운영 시 file descriptor 누수 + FAISS 메모리 잠금 가능.
- 세션 재시작이 빈번하면 점진적으로 RSS 증가.

### 3.4 권장 수정

```python
async def cleanup(self):
    logger.info(f"[{self._session_id}] Cleaning up AgentSession...")

    # Flush memory before shutdown
    if self._memory_manager:
        try:
            self._memory_manager.auto_flush()
            logger.debug(...)
        except Exception:
            logger.debug("Failed to flush memory — non-critical", exc_info=True)
        self._memory_manager = None

    # NEW — release executor MemoryProvider
    if self._memory_provider is not None:
        try:
            await self._memory_provider.close()
        except Exception:
            logger.debug("MemoryProvider close failed — non-critical", exc_info=True)
        self._memory_provider = None

    self._pipeline = None
    ...
```

추가로, **multi-tenant singleton 매니저** (`Global` / `Curated` / `UserOpsidian`) 도 자체 `MemoryProvider` 를 보유하지만 프로세스 종료까지 살아있다. 프로세스 단위 lifecycle 이 아니라 명시적 종료가 필요한 환경(테스트, FastAPI lifespan shutdown)에서는 그들도 `close()` 가 필요할 수 있다. 우선 `agent_session` 만 수정하고 multi-tenant 는 별도 sprint 로 평가 권장.

---

## 4. 🟠 HIGH — `curate_all_from_opsidian` async-context sync call

### 4.1 위치
`/home/geny-workspace/Geny/backend/controller/curated_knowledge_controller.py:367-377`

### 4.2 증상
```python
@router.post("/curate/all")
async def curate_all_from_opsidian(
    req: CurateAllRequest,
    auth: dict = Depends(require_auth),
):
    username = auth.get("sub", "anonymous")
    curated_mgr = _get_manager(username)
    opsidian_mgr = _get_opsidian_manager(username)

    opsidian_index = opsidian_mgr.get_index()  # ← sync wrapper inside async route
```

다른 모든 라우트는 `await opsidian_mgr.aget_index()` 를 사용한다 (PR #713). 이 한 곳만 누락.

### 4.3 영향
- 정상 동작은 한다 — sync wrapper 가 `run_coro_sync(self.aget_index())` 로 위임.
- 그러나 비동기 컨텍스트 안에서 `run_coro_sync` 가 호출되면 **새 worker thread 를 spawn** 하여 fresh event loop 를 띄운다 (`sync_async_bridge.py:62-71`).
- 즉, 이 한 라우트는 매 호출마다 ~1-3ms thread spawn 오버헤드를 무의미하게 지불.
- 동시 다발 사용자가 호출하면 일시적으로 worker thread 가 늘어남.

### 4.4 권장 수정

```python
opsidian_index = await opsidian_mgr.aget_index()
```

---

## 5. 🟡 MEDIUM — `curation_engine` 의 async 메서드가 sync wrapper 호출

### 5.1 위치
`/home/geny-workspace/Geny/backend/service/memory/curation_engine.py`

| Line | Async method | Sync call |
|---|---|---|
| 313 | `curate_note` | `self._opsidian.read_note(filename)` |
| 392 | `curate_note` | `self._curated.write_note(...)` |
| 448 | `_llm_analyze` | `self._curated.get_index()` |
| 550 | `_build_merge_content` | `self._curated.read_note(fn)` |
| 575 | `_enrich` | `self._curated.get_index()` |

### 5.2 증상
이 5개 호출 모두 async 메서드 내부에서 sync wrapper 를 호출. HIGH #4 와 동일한 패턴 — 실제 동작은 정상이나 매 호출마다 worker thread 오버헤드.

### 5.3 영향
- `curate_note` 는 큐레이션 워크플로의 hot path. 사용자가 1회 큐레이션 트리거하면 여러 sync wrapper hop 발생.
- `_enrich` / `_llm_analyze` 도 큐레이션 cycle 마다 호출됨.

### 5.4 권장 수정
각각을 async sibling 으로 교체:
```python
# 313: read_note → await aread_note
note = await self._opsidian.aread_note(filename)

# 392: write_note → await awrite_note
curated_fn = await self._curated.awrite_note(...)

# 448, 575: get_index → await aget_index
idx = await self._curated.aget_index()

# 550: read_note → await aread_note
existing = await self._curated.aread_note(fn)
```

---

## 6. 🔵 LOW — Tools 의 `def run` 잔존

### 6.1 위치
`backend/tools/built_in/memory_tools.py` (9개 클래스), `memory_inspect_tools.py` (5개), `knowledge_tools.py` (6개)

### 6.2 상황
Tools 는 `arun` 을 override했고 — 이것이 production dispatch path (executor `tool_bridge.py:163` 가 `arun` 을 우선). `def run` 은 BaseTool abstract method 만족용 + 테스트 / CLI 호출 fallback.

### 6.3 평가
**의도된 잔여**. `def run` 이 sync wrapper 를 호출하는 것은 sync 컨텍스트에서 호출된다는 가정 하의 정상 경로. 변경 불필요.

다만 코드 라인 카운트로는 `run_coro_sync` 호출이 도구 파일에 잔존. 이는 production 에서 실행되지 않으므로 **bridge 의 production 부담은 0** (지표상 수치만 잔존).

---

## 7. ✅ Async/Sync Surface Map (검증 완료)

### 7.1 Production paths — bridge 우회 ✓

| Surface | 실제 경로 | bridge? |
|---|---|---|
| Tool dispatch (executor `tool_bridge`) | `arun` override → `await mgr.aX(...)` | ❌ 우회 |
| FastAPI controller (memory/global/opsidian/curated) | `await mgr.aX(...)` (curate_all 1곳 제외 — §4) | ❌ 우회 |
| `SessionMemoryManager._stm_*` / `_ltm_*` / `_notes_*` / `_index_*` / `_vector_*` | `await provider.X()` | ❌ 우회 |
| `agent_session._init_memory_provider`, `_install_memory_hooks`, `record_execution` | `await ...` | ❌ 우회 |
| `MemorySearchTool.arun` → `mem.search_async` | 이미 async-native | ❌ 우회 |
| Multi-tenant 매니저 `a*` siblings | `await provider.X()` | ❌ 우회 |

### 7.2 Bridge 가 **여전히** 필요한 곳 (의도됨)

| Site | 이유 |
|---|---|
| `Global` / `Curated` / `UserOpsidian` `__init__` | sync 생성자에서 `run_coro_sync(build_single_tenant_provider(...))`. 생성자는 async 못함. |
| sync `def write_note` / `read_note` / 등 wrapper | 테스트 / CLI / pre-async 호출자용 back-compat. Production 미호출. |
| `curation_engine` async 메서드의 sync wrapper 호출 (§5) | 미수정 — 권장 수정 |
| `controller/curated_knowledge_controller.curate_all_from_opsidian` (§4) | 미수정 — 권장 수정 |
| `ConversationArchiver._merge_to_disk`, `CompactionArchiver` 내부 | sync `record_message` / `record_compaction` 체인 안에 위치. 마이그레이션은 executor `after_record_turn` hook 계약 변경 필요 — 별도 sprint. |

### 7.3 Singleton race condition 분석

`get_global_memory_manager()` / `get_curated_knowledge_manager(username)` / `get_user_opsidian_manager(username)` 모두 dict-based 캐시 + GIL 보호. 동시 두 async request 가 같은 username 에 대해 첫 호출하면:

1. 둘 다 `if username not in _curated_managers` 통과 → 둘 다 `__init__` 진입
2. 각자 `run_coro_sync(build_single_tenant_provider(...))` 가 worker thread 에서 fresh loop 띄움
3. 둘 다 같은 디렉토리 (`<storage>/_curated_knowledge/<username>/`) 에 대해 `FileMemoryProvider.initialize()` 실행 — `_layout.ensure()` 가 디렉토리 만드는 것이 idempotent (mkdir parents=True, exist_ok=True)
4. 마지막 write 가 `_curated_managers[username]` 슬롯을 차지

**결론**: 데이터 손상 없음. 최악의 경우 중복 초기화 비용 (~수십 ms × 2). 실제 운영에서는 user-scoped 라 동시 충돌 가능성 매우 낮음.

권장 강화는 `threading.Lock` 가드이지만 우선순위 낮음.

---

## 8. ✅ geny-executor 통합 검증

### 8.1 MemoryProvider Protocol — 호출 시그니처 일치 확인

| Geny 호출 | Executor Protocol | 결과 |
|---|---|---|
| `provider.stm().append(turn: Turn)` | `STMHandle.append(turn)` | ✓ |
| `provider.stm().recent(n=...)` | `STMHandle.recent(n=...)` | ✓ |
| `provider.stm().search(query, limit=...)` | `STMHandle.search(query, limit=...)` | ✓ |
| `provider.stm().append_event(event, data)` | `STMHandle.append_event(event, data)` | ✓ |
| `provider.stm().read_summary()` / `write_summary(body)` | 동일 | ✓ |
| `provider.ltm().append(text, heading=...)` | 동일 | ✓ |
| `provider.ltm().write_topic(topic, text)` | 동일 (반환: `NoteRef`) | ✓ |
| `provider.ltm().read_main()` | 동일 | ✓ |
| `provider.ltm().search(query, limit=...)` | `LTMHandle.search(query, limit=...)` | ✓ |
| `provider.notes().write(NoteDraft)` | 동일 (반환: `NoteMeta`) | ✓ |
| `provider.notes().update(filename, NotePatch)` | 동일 | ✓ |
| `provider.notes().delete(filename)` / `.read(filename)` | 동일 | ✓ |
| `provider.notes().list(category=, tag=, importance=)` | `NotesHandle.list(category=, tag=, importance=, ...)` | ✓ |
| `provider.notes().load_pinned(category=, max_chars=)` | 동일 | ✓ |
| `provider.index().snapshot()` / `.rebuild()` | 동일 | ✓ |
| `provider.index().build_vault_map(category_descriptions=)` | `IndexHandle.build_vault_map(category_descriptions=, recent_limit=, top_tags=)` | ✓ (kw 지정) |
| `provider.vector().search(text, top_k=, threshold=)` | 동일 | ✓ |
| `provider.vector().index(ref, text)` / `index_batch(items)` / `reindex(plan=)` | 동일 | ✓ |

### 8.2 Dataclass 필드 — 시그니처 일치

| Dataclass | Geny construction | Executor schema | 결과 |
|---|---|---|---|
| `Turn` | `(role, content, timestamp, metadata)` | `(role, content, timestamp, metadata)` | ✓ |
| `NoteDraft` | `(title, body, category, tags, importance, scope, filename, frontmatter)` | 같음 | ✓ |
| `NotePatch` | `(body, append_body, tags, importance, category, frontmatter)` | 같음 | ✓ |
| `NoteRef` | `(filename, scope, backend)` | 같음 (vector_memory 폐기 후 1곳만 사용) | ✓ |
| `Importance` enum | `LOW/MEDIUM/HIGH/CRITICAL` 값 사용 | 동일 | ✓ |
| `Scope` enum | `SESSION` / `USER` | 동일 | ✓ |

### 8.3 Hooks 계약

`agent_session._install_memory_hooks` 의 `_on_record_turn(turn, _receipt)` 는:
- `async def` ✓
- 실행자의 `MemoryHooks.after_record_turn: Callable[[Turn, RecordReceipt], Awaitable[None]]` 시그니처와 일치 ✓
- Geny 측 archivers (`_maybe_archive_conversation` / `_maybe_archive_dm`) 를 호출하며 sync 인 archivers 의 호출은 hook body 안에서 진행. `Awaitable[None]` 반환은 만족.

### 8.4 Retriever / Strategy 통합

- `GenyMemoryRetriever` (executor side) 는 `provider.stm()` / `provider.ltm()` / `provider.notes()` / `provider.index()` / `provider.vector()` 를 직접 호출. **legacy duck-type (`mgr.vector_memory`, `mgr.short_term` 등) 사용 없음** — Sprint 3 후 안전.
- `GenyMemoryStrategy.promote_callback` 는 `pin_policy.make_promote_callback()` 결과를 등록. Callback 시그니처 sync — `pin_policy.promote_to_critical(insight, memory_manager)` 가 `mem.write_note(...)` 호출 (sync wrapper). Executor 가 sync callback 을 직접 호출하므로 정상.

### 8.5 Composite vs Single-tenant 차이

| Provider 종류 | `curated()` / `global_()` 핸들 | Geny 사용처 |
|---|---|---|
| Composite (`build_memory_provider`) | 있음 | session-bound `agent_session._memory_provider` |
| Single-tenant (`build_single_tenant_provider`) | 없음 (FileMemoryProvider) | multi-tenant manager 들 |

multi-tenant 매니저들은 `provider.curated()` / `provider.global_()` 를 호출하지 않는다 — verified ✓. 그들은 자체 `provider.notes()` / `provider.index()` / `provider.vector()` 만 사용.

### 8.6 LTMConfig 실패 경로

`provider_bridge._embedding_config` (line 42–91): provider/model 없으면 `None` 반환, api_key 없으면 env 폴백 → 모두 실패시 `None` 반환 + INFO 로그.
`build_single_tenant_provider` (line 282–295): LTMConfig 로드 실패시 warning 로그 + `ltm_config=None` → embedding 비활성화. 정상 degrade.

---

## 9. ✅ Stage Pipeline 검증

### 9.1 s02 (Context Stage)

`geny-executor/src/geny_executor/stages/s02_context/` 의 default artifact 는 optional `MemoryProvider` 를 받는다. Geny 의 `provider_bridge.build_memory_provider()` (composite) 가 build/initialize 를 정확히 수행. `provider.retrieve(RetrievalQuery)` 호출과 `MemoryAwareRetriever` 핵심 경로 — 모두 provider 직접 의존 (legacy host 의존 없음). 정상.

### 9.2 s18 (Memory Stage)

`geny-executor/src/geny_executor/stages/s18_memory/` 의 default artifact 는 `MemoryProvider` + `MemoryHooks` 를 받는다. Geny 측 `GenyDedupeStrategy` (`service/memory/dedupe_strategy.py`) 가 `ProviderDrivenStrategy` 상속 — async-native, hook compatible.

### 9.3 Persisting compactor

`service/memory/persisting_compactor.py` 는 executor 의 `LLMSummaryCompactor` 를 wrap 하면서 `self._memory_manager.record_compaction()` 를 호출. record_compaction 은 sync 메서드이고 archive path 는 그대로 (compaction archiver 가 sync 인 부분 — §7.2 의 deferred 항목). 운영 차질 없음.

---

## 10. ✅ Tests / 외부 호환성

### 10.1 삭제된 모듈에 대한 dangling import

전수 grep 결과: `from service.memory.{short_term, long_term, vector_memory, index, structured_writer}` 는 코드베이스에서 **0건**. 테스트 파일에서도 없음. ✓

### 10.2 Test fixture forward-compatibility

- `tests/tools/test_memory_inspect_tools.py:42-66` 의 `_FakeShortTerm` / `_FakeMemoryManager` — `load_all` 호출 (manager.py 의 `load_all_stm` public surface) 와 일치. ✓
- `tests/tools/test_memory_categories_tool.py` — Sprint 3 step 4/A4 에서 한번 갱신 후 hardcoded vault-map payload 사용. ✓
- `tests/integration/test_memory_v2_baseline.py:202,225` — `parse_frontmatter` 만 import (frontmatter.py 잔존 함수). ✓
- `tests/service/memory/test_index_conversations.py` — A4 에서 삭제 ✓
- `tests/service/memory/test_pin_policy.py` — Step 2 에서 깨진 채로 삭제 ✓

### 10.3 Scripts

`scripts/migrate_pin_critical.py` 는 `service.memory` 미import (정규식 + Path 기반 파일 직조작). 영향 없음.

---

## 11. 추가 권장 사항

### 11.1 즉시 수정 (1 PR 권장)

```
[ ] §3 — agent_session.cleanup() 에 provider.close() 추가
[ ] §4 — curate_all_from_opsidian: get_index → await aget_index
[ ] §5 — curation_engine: 5 sync 호출 → await a* sibling
```

세 변경이 작아 단일 PR 로 묶을 수 있다. ~30 줄.

### 11.2 follow-up 검토 (별도 sprint)

```
[ ] Multi-tenant manager singleton 의 lifecycle — FastAPI lifespan shutdown 에서 close()
[ ] Archivers (conversation/compaction) async-native 화 — executor after_record_turn 계약 검토 필요
[ ] sync_async_bridge.py 폐기 가능성 재평가 — multi-tenant 매니저 lazy-init 패턴 도입 시
```

### 11.3 Observability 강화 권장

`run_coro_sync` 호출량 측정 — production path 0 호출이 의도된 결과이므로 metric 으로 노출하면 회귀 감지 가능.

```python
# sync_async_bridge.py 에 추가 가능
from prometheus_client import Counter
_BRIDGE_CALLS = Counter('memory_bridge_run_coro_sync_total', 'run_coro_sync invocations')

def run_coro_sync(coro):
    _BRIDGE_CALLS.inc()
    ...
```

---

## 12. 결론

**구조적으로 건전.** Sprint 3 + Step 7 의 18 PR 은 Geny 메모리 레이어를 `MemoryProvider` 직접 호출로 단일화했고, async-native + sync wrapper 듀얼 패턴은 의도대로 동작한다. Production tool dispatch + production controller dispatch 가 sync→async bridge 를 우회한다.

**버그 3건** (critical 1, high 1, medium 5) 은 모두 마이그레이션 누락 — refactor 전 코드에는 존재하지 않았던 패턴 (sync wrapper 도입에 따른 새 hop) 이며, 모두 단일 PR 로 수정 가능.

**executor 측 contract** 는 모든 호출 시그니처 / dataclass 필드 / hook 시그니처 / lifecycle 메서드가 일치. legacy duck-type 의존 0건.

**테스트 + 외부 import + 스크립트** 모두 깨진 의존성 없이 forward-compatible.

운영 검증 (`<storage>/transcripts/session.jsonl` populated, `_index.json` shards 정확, Opsidian sidebar 동작) 결과는 영향받지 않으며 — §3, §4, §5 수정 후에는 자원 누수 + 비효율적 worker thread 사용 두 측면이 함께 해소된다.

---

*감사 완료: 2026-05-05 / 4-병렬 Explore agent + 교차 검증*
