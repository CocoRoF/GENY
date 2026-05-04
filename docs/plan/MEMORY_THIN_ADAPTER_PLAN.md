# 메모리 시스템 Thin Adapter 전환 계획

> 작성: 2026-05-04 · 사이클: Geny 메모리 layer 의 stage 18 이중 트레일 정리.
> 전제 진단: `docs/_archive/analysis/CURRENT_MEMORY_STATE_AUDIT.md` 정정본 + 본 사이클의 보고서 (Opsidian 가시성 PR #671 머지 후 발견된 STM 이중 쓰기, LTM 삼중 trail, `_index.json` 충돌 쓰기).

---

## 0. 결정 사항 — 경로 A + executor 확장

전 사이클에서 발견된 이중 트레일은 두 가지 처리 선택지가 있었다.

- **A. GenyDedupeStrategy 트레일 폐기** — Geny 의 `ShortTermMemory` / `LongTermMemory` / `MemoryIndexManager` 를 thin adapter 로 전환. executor 의 `_drive_provider` 가 STM/LTM/index 의 유일한 쓰기 경로.
- **B. executor `_drive_provider` 비활성화** — `MemoryStage.provider = None` 으로 두고 Geny 인프라를 owner 로 유지.

**경로 A 채택**. 이유: "executor = 일반화된 인터페이스 / Geny = 비즈니스 로직" 철학을 끝까지 관철. executor 를 절반만 인프라로 쓰는 B 는 short_term/long_term/index 약 1900 줄의 인프라 코드를 영구히 Geny 측에 남김.

다만 A 를 그대로 가면 Geny 가 보유하던 가치 있는 메타데이터 (InteractionEvent kind/direction/counterpart_id, importance level, source, session_id, linked_event_id, payload, kinds-aggregate, 등) 가 executor 의 좁은 dataclass 에 못 실린다. 이를 위해 **executor 의 모든 stage I/O dataclass 에 `metadata: Dict[str, Any]` extension 필드를 추가**한다. metadata 는 executor 가 저장/전달만 하고 내용은 절대 해석하지 않는 **순수 passthrough channel**. 비즈니스 로직 (어떤 키를 넣고 어떻게 읽을지) 은 Geny 에서 정의.

핵심 철학 한 줄: **executor 는 모든 stage 에서 임의 dict 를 round-trip 시키는 인터페이스를 제공한다. Geny 는 그 dict 위에 자기 비즈니스를 빌드한다.**

---

## 1. executor 확장 — `metadata` extension 필드

### 1.1 대상 dataclass 전수

`geny-executor/src/geny_executor/memory/provider.py` 직접 grep 결과 기준 (실측):

이미 metadata 보유: `Turn` (line 312), `ExecutionSummary` (344), `CostEvent` (184), `BackendInfo` (151), `MemoryChunk` (line 441 추정), 외 2개.

신규 추가 대상:
| Dataclass | 추가 사유 |
|---|---|
| `NoteRef` (line 119) | scope/category 외 라우팅 hint (`geny.bucket`, `geny.session_origin` 등) |
| `NoteMeta` (216) | read / list 결과에서 metadata 보존 — Geny 가 list 결과에 비즈니스 라벨 첨부할 수 있어야 함 |
| `Note` (231) | full read 시 metadata 라운드트립 |
| `NoteDraft` (261) | `frontmatter` 와 별도. `frontmatter` 는 disk YAML 직렬화 대상, `metadata` 는 ephemeral routing/business hint (DB dual-write 트리거, hook 분기) |
| `NotePatch` (277) | 동일 |
| `NoteGraph` (290) | 그래프 결과에 비즈니스 어노테이션 |
| `RecordReceipt` (361) | 쓰기 결과에 emit_event 페이로드, 후속 비즈니스 hint |
| `Insight` (381) | reflection 산출물의 비즈니스 메타 |
| `ReflectionContext` (406) | reflection 입력에 비즈니스 컨텍스트 (예: 현재 화자, 톤) |
| `RetrievalQuery` (429) | retriever 의 비즈니스 필터 (예: counterpart_id 만 검색) |
| `RetrievalResult` | 검색 결과에 비즈니스 통계 |
| `MemorySnapshot` | 스냅샷 메타 (생성한 사이클 ID, 사용자 식별자 등) |
| `ReindexPlan` | 재인덱싱 사유 / 트리거 비즈니스 컨텍스트 |

추가로 **stage interface 자체** (`Stage.execute(input, state)` 의 `state.metadata`) 도 이미 `Dict[str, Any]` 인 것으로 알고 있으나, 모든 stage I/O 에서 같은 패턴 (`metadata` 라는 이름, dict, 기본값 빈 dict, executor 가 해석 안 함) 을 일관되게 적용한다.

### 1.1.1 `Turn.from_state_message` 의 metadata 누락 — EXEC-1 의 핵심

**현재 상태 (provider.py:325-330):**
```python
@classmethod
def from_state_message(cls, message: Mapping[str, Any]) -> "Turn":
    return cls(
        role=str(message.get("role", "user")),
        content=message.get("content", ""),
    )
```

**문제**: `message["metadata"]` 를 가져오지 않는다. 즉 stage 18 의 `_drive_provider` 가 `Turn.from_state_message(msg)` 로 Turn 만들 때 **InteractionEvent metadata 가 통째로 버려짐**. 이것이 GenyDedupeStrategy 가 살아남은 진짜 이유 — Geny 가 mgr.record_message 직접 호출해서 metadata 가 jsonl 에 남도록 우회 경로를 유지하고 있었다.

**EXEC-1 수정:**
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

**추가**: `ExecutionSummary.from_state` (provider.py:347-357) 도 마찬가지로 `state.messages` 의 각 메시지 metadata 를 Turn.metadata 로 가져와야 함. 현재 `Turn.from_state_message(m)` 에 의존하므로 위 수정으로 자동 해결.

이 수정 하나만으로도 GenyDedupeStrategy 의 `_record_transcript` 우회 경로가 더 이상 필요 없어진다. **EXEC-1 의 가장 가치 있는 변경.**

### 1.2 키 네임스페이스 규약

키 충돌 방지 + 후방 호환성 위해 **점 구분 namespace** 사용. 예:

```python
turn = Turn(
    role="user",
    content="...",
    timestamp=now,
    metadata={
        "geny.interaction.event_id": "abc...",
        "geny.interaction.kind": "user_chat",
        "geny.interaction.direction": "incoming",
        "geny.interaction.counterpart_id": "user_alpha",
        "geny.interaction.counterpart_role": "user",
        "geny.interaction.linked_event_id": None,
        "geny.interaction.payload": {...},
        "geny.importance": "low",
    },
)
```

executor 측 contract:
- Geny prefix (`geny.*`) 은 Geny 가 정의/소유. executor 는 이 키들을 **읽지 않음**, 단지 직렬화/역직렬화 round-trip.
- 향후 다른 host (만약 생긴다면) 도 자기 prefix 사용.
- executor 자체가 쓰는 키가 있다면 `executor.*` prefix.

### 1.3 직렬화 / persistence

각 backend 가 metadata 를 어떻게 저장하는지:

- **FileMemoryProvider**:
  - `Turn.metadata` → `transcripts/session.jsonl` 의 line 안 `metadata: {...}` 키 (이미 동작)
  - `NoteDraft.metadata` → **저장 안 함** (ephemeral routing only). 실제 disk 직렬화는 `NoteDraft.frontmatter` 와 executor 의 `_note_to_frontmatter` 가 책임.
  - `NoteDraft.frontmatter` 의 키들은 `_note_to_frontmatter` 에서 `meta` dict 의 추가 키로 그대로 disk YAML 에 emit (이미 동작).
- **SqlMemoryProvider** (이미 존재):
  - `Turn.metadata` → `metadata_json` 컬럼
  - `NoteDraft.frontmatter` → `frontmatter_json` 컬럼
  - 이 PR 에서는 metadata 추가만, 스키마 변경 없음 (jsonb 컬럼 재사용 또는 신규 metadata_json 컬럼 추가는 SQL provider 결정에 위임)

### 1.4 hooks / callbacks 일반화

`MemoryHooks` 에 generic hook 추가:

```python
class MemoryHooks:
    # 기존
    should_record_execution: Callable[[PipelineState], bool]
    should_reflect: Callable[[PipelineState], bool]
    should_auto_promote: Callable[[Insight], bool]
    # 신규 — generic post-write hook chain
    after_record_turn: Optional[Callable[[Turn, RecordReceipt], Awaitable[None]]] = None
    after_record_execution: Optional[Callable[[ExecutionSummary, RecordReceipt], Awaitable[None]]] = None
    after_note_write: Optional[Callable[[NoteMeta], Awaitable[None]]] = None
```

Geny 가 `ConversationArchiver.archive` / `DmArchiver.append` 같은 비즈니스 로직을 `after_record_turn` 콜백에 등록 → 매 STM append 후 자동 실행. 별도 stage 호출 경로 없이 single entry point.

### 1.5 executor 측 PR 단위 (geny-executor 레포)

| PR | 범위 |
|---|---|
| **EXEC-1** | provider.py 의 모든 dataclass 에 `metadata: Dict[str, Any]` 추가 + namespace 규약 docstring + 단위 테스트 (round-trip) |
| **EXEC-2** | `MemoryHooks` 에 `after_*` 콜백 추가 + file/provider.py / composite/provider.py / sql/provider.py 의 `record_turn` / `record_execution` / `notes.write` 가 hook 트리거 |
| **EXEC-3** | `_refresh_backlinks` 의 wikilink-vs-filename 확장자 mismatch 버그 수정 (PR-3i 보고에서 지적된 것) |
| **EXEC-4** | (선택) SQL provider 에 metadata_json 컬럼 / 인덱스 추가 |

EXEC-1, EXEC-2 가 Geny 측 작업의 전제 조건.

---

## 2. Geny 측 전환 — STM thin adapter

### 2.1 목표 상태

```
Geny ShortTermMemory.add_message(role, content, metadata=...)
  └─ run_coro_sync(provider.stm().append(Turn(
       role=role,
       content=content,
       timestamp=now,
       metadata={
           "geny.interaction.*": ...,  # InteractionEvent 풀어서
           ... (Geny 비즈니스 키)
       },
     )))
  └─ DB dual-write (Geny 비즈니스 — STMHandle 호출 후)
```

`_append_jsonl`, `_maybe_truncate_file`, `MAX_TRANSCRIPT_ENTRIES` 상수, `RLock` 모두 제거. STMHandle 의 `truncate(keep_last=N)` 가 동등 동작 제공.

### 2.2 add_event 처리

executor 의 `Turn` 은 message 만 모델링. `add_event` 가 jsonl 에 쓰던 `{"type":"event", "event":..., "data":...}` 라인은 두 가지 옵션:

- **옵션 A**: `STMHandle.append_event(name: str, data: Dict)` 를 executor 에 추가 (EXEC-2 와 함께). executor 는 이 record 를 type="event" 형태로 jsonl 에 직접 append. 단점: STMHandle 표면이 늘어남.
- **옵션 B**: `Turn(role="event", content=event_name, metadata={"geny.event.data": data, "geny.event.type": "event"})` 형태로 record_turn 우회. STM 에 이벤트 라인이 message 로 저장됨. 단점: STMHandle.recent / search 에 이벤트가 섞여 들어가 Geny 쪽에서 필터 필요.

→ **옵션 A 채택**. `STMHandle.append_event` 인터페이스는 일반화되어 있고 (어떤 host 든 비-message 이벤트 append 가능), Geny 가 자기 add_event 호출을 그대로 실어 보낼 수 있다. EXEC-2 에 포함.

### 2.3 write_summary 처리

`transcripts/summary.md` 는 STMHandle 에 동등 인터페이스 없음. 옵션:

- 그대로 Geny 직접 쓰기 유지 — `transcripts/summary.md` 는 Geny 비즈니스 (요약 생성 LLM 호출 + 디스크 쓰기) 이고, STM jsonl 과는 별도 파일이라 충돌 없음.
- 또는 NotesHandle 에 special category="summaries" 로 저장 — 디스크 레이아웃 변경 위험.

→ **그대로 Geny 측 직접 쓰기 유지**. summary.md 는 STM 의 일부가 아니라 부속 인공물로 명시적으로 분류 (docstring 에 명문화).

### 2.4 DB dual-write 처리

`db_stm_add_message` / `db_stm_add_event` / `db_stm_write_summary` 는 Geny 비즈니스 (운영자 대시보드 / 분석용). thin adapter 전환 후 호출 위치:

```python
def add_message(self, role, content, metadata=None):
    turn = Turn(role=role, content=content, timestamp=now,
                metadata={"geny.interaction....": metadata, ...})
    run_coro_sync(self._provider.stm().append(turn))
    # DB dual-write (executor 호출 후)
    if self._db_available:
        db_stm_add_message(self._db_manager, self._session_id, ...)
```

또는 `MemoryHooks.after_record_turn` 콜백에 등록해서 STM 직접 호출 없애도 됨. 1 단계에서는 add_message 안에 inline 유지 (단순), 2 단계에서 hook 으로 이동 검토.

### 2.5 GenyDedupeStrategy 처리

GenyDedupeStrategy 의 역할:
1. ✅ pending metadata hint 를 state.metadata 에 stamp (AgentSession.\_invoke\_pipeline 에서)
2. ❌ `_record_transcript` 에서 mgr.record_message 호출 (이중 쓰기 원인)
3. ❌ `_record_execution_result` 에서 mgr.remember_dated 호출 (이중 LTM)

전환:
- **1번 유지**: pending metadata 는 그대로 state.metadata 에 stamp (executor 의 `_drive_provider` 가 `Turn.from_state_message(msg)` 로 message dict 의 metadata 를 읽어 Turn.metadata 에 실어 보냄)
- **2번 제거**: `_record_transcript` 메서드를 no-op 으로 만들거나, GenyDedupeStrategy 자체를 `NoMemoryStrategy` 슬롯으로 교체
- **3번 제거**: `_record_execution_result` 도 동일

GenyMemoryStrategy 자체를 폐기하고 stage 18 의 strategy slot 을 `NoMemoryStrategy()` 로 둘 수도 있음. 더 깨끗.

### 2.6 Turn.from_state_message 가 metadata 를 가져가는지 검증

**확인 완료** (provider.py:325-330): 가져오지 않는다. 1.1.1 항목 참조. EXEC-1 에 수정 포함.

### 2.7 단계별 PR (Geny 측)

| PR | 범위 | 의존 |
|---|---|---|
| **GENY-1** | ShortTermMemory thin adapter (`add_message` → STMHandle.append, `add_event` → STMHandle.append_event). DB dual-write 유지. `get_recent` / `search` / `load_all` → STMHandle.recent/search/all_turns. `_append_jsonl` / `_maybe_truncate_file` 삭제 | EXEC-1, EXEC-2 |
| **GENY-2** | GenyDedupeStrategy `_record_transcript` no-op + stage 18 strategy 슬롯 NoMemoryStrategy 로 교체 | GENY-1 머지 후 |
| **GENY-3** | LongTermMemory thin adapter (다음 절) | GENY-2 머지 후 |
| **GENY-4** | ConversationArchiver / DmArchiver 를 `after_record_turn` hook 으로 재배선 | GENY-3 |
| **GENY-5** | MemoryIndexManager thin adapter (provider.index() 위) | GENY-3 |
| **GENY-6** | 죽은 코드 삭제 (frontmatter.py 중복, short_term.py 잔여, long_term.py 잔여, index.py 본체) | 위 모두 |

---

## 3. Geny 측 전환 — LTM thin adapter

### 3.1 목표 상태

```
LongTermMemory.append(text, heading=...)        → provider.ltm().append(text, heading)
LongTermMemory.write_dated(text, date=...)     → provider.ltm().write_dated(text, day=date)
LongTermMemory.write_topic(slug, text)         → provider.ltm().write_topic(slug, text)
LongTermMemory.read_main()                      → provider.ltm().read_main()
LongTermMemory.search(query, limit=N)          → provider.ltm().search(query, limit) → MemoryChunk → MemoryEntry adapter
LongTermMemory.write_execution(entry)          → provider.notes().write(NoteDraft(category="executions", filename="<YYYY-MM-DD>.md", body=entry, metadata={"geny.execution_summary": True}))
LongTermMemory.load_pinned(max_chars=N)        → provider.notes().list(category="critical") → MemoryEntry adapter
```

### 3.2 write_execution 의 모델링

현재: `memory/executions/<YYYY-MM-DD>.md` 에 매 execution 의 결과 append. 디렉토리 단위 dated journal.

옵션:
- **옵션 A**: NotesHandle.write 한 번 (category="executions", filename="<date>.md") → 이미 존재하면 update(append_body) 로 누적. → 매 execution 마다 read+write 2회 I/O. ConversationArchiver 와 같은 패턴.
- **옵션 B**: LTMHandle 에 `write_execution(entry, day)` 추가 — append-only 의미를 protocol 에 박음.
- **옵션 C**: 그대로 Geny 직접 쓰기 — DM archiver 와 마찬가지로 "특수 케이스".

→ **옵션 A 채택**. 1) NotesHandle 의 update(append_body) 가 이미 atomic, 2) `executions/` 도 `memory/` 하위 카테고리로 일관되게 모델링, 3) LTMHandle 표면을 늘리지 않음. DM 처럼 2-level subpath 도 아니므로 NotesHandle 적합.

### 3.3 load_pinned 의 모델링

`memory/critical/` 에서 모든 .md 읽어서 char budget 안에서 합쳐 반환. NotesHandle.list(category="critical") + NotesHandle.read 루프로 충분. Geny 쪽에 `load_pinned` wrapper 만 남기고 안에서 NotesHandle 호출.

### 3.4 search 의 결과 shape adapter

executor `LTMHandle.search` 는 `List[MemoryChunk]` 반환. Geny 의 `LongTermMemory.search` 는 `List[MemorySearchResult]` 반환 (Geny 자체 dataclass). Adapter 함수 1개로 변환 — 비즈니스 로직 0줄.

---

## 4. Geny 측 전환 — Conversation / DM archiver hook 화

### 4.1 현재 상태

`AgentSession._invoke_pipeline` 이 매 새 메시지마다:
1. `state.metadata['_pending_message_metadata'] = {...}` stamp
2. pipeline 실행 (stage 18 가 record_turn 호출)
3. `mgr.archive_conversation(...)`, `mgr.append_dm(...)` 직접 호출 (이거 stage 18 외부에서 일어남)

### 4.2 목표 상태

`MemoryHooks.after_record_turn` 등록 — executor 가 매 record_turn 후 호출:

```python
async def _on_record_turn(turn: Turn, receipt: RecordReceipt) -> None:
    # Geny 비즈니스: bucket-aware conversation rollup
    bucket_meta = turn.metadata.get("geny.interaction.kind")
    if bucket_meta in {"user_chat", "reflection", "dm", ...}:
        await asyncio.to_thread(
            conversation_archiver.archive, role=turn.role, content=turn.content,
            metadata=_unflatten(turn.metadata),
        )
    if bucket_meta in DM_KINDS:
        await asyncio.to_thread(
            dm_archiver.append, role=turn.role, content=turn.content,
            metadata=_unflatten(turn.metadata),
        )
```

`AgentSession._init_memory_provider` 에서 `MemoryHooks(after_record_turn=_on_record_turn)` 를 stage 18 에 부착. AgentSession 이 직접 archive/append 호출하던 것은 모두 hook 안으로 이동.

장점:
- archive/append 트리거 지점 단일화
- "메시지가 STM 에 들어가면 그 다음 비즈니스 책임" 이 자연스럽게 표현됨
- pipeline 변경 (stage 추가/삭제) 에도 archive 가 자동으로 따라감

### 4.3 ConversationArchiver / DmArchiver 자체는 거의 변경 없음

- ConversationArchiver: 이미 NotesHandle 경유 (PR #671 이후). 입력 metadata 풀어내는 helper 만 추가 (turn.metadata namespace 키 → InteractionEventView).
- DmArchiver: 직접 디스크 쓰기 유지 (2-level subpath). hook 에서 호출되는 entry point 만 정렬.

---

## 5. Geny 측 전환 — Index thin adapter

### 5.1 현재 의존성

retriever 가 `mgr.index_manager.render_vault_map()` 호출 (executor retriever.py). Geny 의 MemoryIndexManager 가:
- `index.files` (file → MemoryFileInfo) 직접 접근
- `index.tag_map` 접근
- `index.link_graph` 접근
- `render_vault_map()` 메서드 호출

### 5.2 목표 상태

`MemoryIndexManager` 가 thin wrapper:
- 내부 자료구조 빌드 안 함
- `provider.index().snapshot()` 결과를 lazily 캐시
- `render_vault_map()` 만 Geny 비즈니스로 유지 (snapshot 결과 위에서 마크다운 렌더링)

```python
class MemoryIndexManager:
    def __init__(self, provider):
        self._provider = provider
        self._snapshot: Optional[Dict[str, Any]] = None

    def _ensure_snapshot(self):
        if self._snapshot is None:
            self._snapshot = run_coro_sync(self._provider.index().snapshot())
        return self._snapshot

    @property
    def files(self): return self._ensure_snapshot()["files"]
    @property
    def tag_map(self): return self._ensure_snapshot()["tag_map"]
    @property
    def link_graph(self): return self._ensure_snapshot()["link_graph"]

    def invalidate(self): self._snapshot = None

    def render_vault_map(self) -> str:
        # Geny 비즈니스 — snapshot 위에서 prompt-injectable markdown 빌드
        snap = self._ensure_snapshot()
        ...
```

invalidate 트리거는 `MemoryHooks.after_note_write` 콜백.

### 5.3 _index.json / _vault_map.json 권위

- `_index.json` 디스크 쓰기는 **executor 만**. Geny 의 `_save_to_disk`, 카테고리별 shard, `_atomic_write_json` 모두 제거.
- `_vault_map.json` 은 prompt 주입용 캐시. 옵션:
  - 디스크에 저장 안 함 — 런타임에 매번 render (저렴)
  - Geny 가 `_vault_map.json` 에 직접 쓰기 (비즈니스 캐시) — 정당
  - → 후자 채택. render_vault_map 결과를 Geny 가 자기 캐시 파일로 보관 (executor 와 충돌 없음, 다른 파일).

### 5.4 retriever attribute access 호환성

retriever 는 `getattr(mgr, "index_manager", None)` → `getattr(idx_mgr, "render_vault_map", None)` 로 duck-type. `MemoryIndexManager` 가 `render_vault_map` 메서드를 계속 노출하면 retriever 변경 0.

`files` / `tag_map` / `link_graph` 가 Geny 비즈니스 외부에서 직접 호출되는 곳이 없는지 grep 으로 확인 필요. 있으면 `provider.index().snapshot()` 호출로 in-place 교체.

---

## 6. PR 시퀀스 + 의존성 그래프

```
EXEC-1 (metadata 필드 + namespace) ──┬─→ GENY-1 (STM thin) ──→ GENY-2 (GenyDedupeStrategy 폐기)
                                     │                              │
EXEC-2 (after_* hooks)              ─┴─→ GENY-3 (LTM thin) ─────────┘
                                                                    │
                                                                    ├─→ GENY-4 (Conv/DM hook)
                                                                    │
                                                                    └─→ GENY-5 (Index thin)
                                                                         │
                                                                         └─→ GENY-6 (cleanup)

EXEC-3 (refresh_backlinks 버그) ─── 독립, 언제든
EXEC-4 (SQL metadata 컬럼) ───────── 선택, SQL provider 사용 시
```

### 6.1 PR 별 추정 규모 + 위험도

| PR | 줄수 | 위험 | 검증 |
|---|---|---|---|
| EXEC-1 | +200 / -0 | 낮음 (필드 추가만) | 모든 dataclass round-trip 테스트 |
| EXEC-2 | +150 / -50 | 중 (hook 트리거 누락 위험) | record_turn / record_execution / note.write 후 hook 호출 검증 |
| EXEC-3 | +5 / -3 | 낮음 | backlink propagation 테스트 |
| GENY-1 | +200 / -350 | 중 (STM 동작 회귀 가능) | recent / search / truncate 동등성 테스트 + DB dual-write 검증 |
| GENY-2 | +30 / -100 | 낮음 (단지 strategy 슬롯 비활성) | 매 메시지가 1번만 jsonl 에 들어가는지 확인 |
| GENY-3 | +200 / -500 | 중 | LTM 모든 메서드 동등성 + Obsidian 가시성 회귀 점검 |
| GENY-4 | +100 / -200 | 중 (hook 등록 타이밍) | conversation/dm rollup 정상 생성 |
| GENY-5 | +100 / -650 | 높음 (retriever 영향) | render_vault_map 결과 동등성, 부팅 시 _index.json 충돌 해소 검증 |
| GENY-6 | +0 / -1500 | 낮음 (이미 dead code) | 임포트 누락 점검 |

총 예상: executor +355 / Geny +630 / -3300 ≈ **순 -2300 줄**

---

## 7. 호환성 / 마이그레이션

### 7.1 기존 디스크 데이터

- `transcripts/session.jsonl` — Geny 와 executor 가 같은 포맷 (`{"type":"message", "role":..., "content":..., "ts":..., "metadata":...}`) 으로 이미 호환. 이중 쓰기만 멈추면 자동 마이그.
- `memory/<YYYY-MM-DD>.md` — Geny 와 executor 둘 다 append. GENY-3 에서 Geny 측 쓰기 제거 → 이후로는 executor 만 append. 기존 누적 내용 그대로 보존.
- `memory/_index.json` — executor 포맷으로 통일. 부팅 시 만약 Geny 포맷이면 executor 가 무시하고 rebuild from scratch (이미 현재 동작).
- `memory/critical/<slug>.md`, `memory/topics/<slug>.md` 등 — NotesHandle 권위 유지, 영향 없음.
- `memory/executions/<YYYY-MM-DD>.md` — 신규 NotesHandle 경유 append 로 전환 시 기존 파일 이어서 read+update. ConversationArchiver 와 같은 패턴이라 검증된 동작.

### 7.2 DB dual-write

- `session_memory_entries` 테이블 — 현재 Geny 만 씀 (executor SQL provider 와 다른 테이블). 영향 없음.
- `db_stm_*` 함수 — Geny 비즈니스, 그대로 유지.

### 7.3 후방 호환성

executor 의 `metadata` 필드 추가는 default 빈 dict 라 기존 코드가 metadata 없이 호출해도 동작. namespace 가 없는 키 (Geny 의 InteractionEvent metadata 가 풀어진 dot-notation 안 한 키들) 는 GENY-1 에서 일괄 namespace 화. 일관성 위해 GENY-1 안에 키 정규화 helper 포함.

---

## 8. 검증 계획

### 8.1 단위 테스트 (executor)

- EXEC-1: 모든 dataclass 의 metadata round-trip (dict in → dict out, 키/값 보존)
- EXEC-2: record_turn 후 after_record_turn 호출 (Turn + RecordReceipt 인자 검증), record_execution 후 after_record_execution, notes.write 후 after_note_write
- EXEC-3: source 노트가 `[[target]]` 가질 때 target.links_in == ["source"] (cache + as_meta + graph 모두)

### 8.2 통합 테스트 (Geny)

- GENY-1 후: jsonl 라인 1개 / 메시지 (이중 쓰기 X), STMHandle.recent 가 add_message 입력 그대로 반환, add_event 라인이 jsonl 에 type="event" 로 기록
- GENY-2 후: pipeline 실행 시 stage 18 의 strategy slot 이 mgr.record_message 부르지 않음 (디버그 로그 absent 확인)
- GENY-3 후: LTM 모든 메서드 결과 동등성 테스트 (전후 비교 fixture)
- GENY-4 후: 매 user/assistant turn 후 conversation rollup 정확히 1개 생성/업데이트 (Obsidian 디렉토리 확인)
- GENY-5 후: render_vault_map 출력이 마이그 전후 동일 (snapshot diff)

### 8.3 운영 검증 (사용자)

각 GENY-N 머지 후 docker rebuild → VTuber 세션 1회 → 다음 항목 확인:
1. session.jsonl 의 라인 수 == 메시지 수 (중복 없음)
2. memory/critical/ , memory/topics/ , memory/conversations/ , memory/dms/ 모두 Opsidian 에 보임
3. memory_pin / memory_write / memory_search 도구 모두 정상 동작
4. _index.json 이 executor 포맷 유지 (`"files": {...}` 구조 확인)
5. retriever 의 vault_map 주입 정상 (system prompt 의 `# Vault Map` 섹션 비어있지 않음)

---

## 9. 미해결 질문 (사용자 결정 대상)

1. **GenyMemoryStrategy 자체를 폐기할지** — _record_transcript / _record_execution_result 두 메서드 모두 no-op 이라면 strategy 슬롯을 NoMemoryStrategy 로 교체. GenyDedupeStrategy 와 GenyMemoryStrategy 클래스 자체 삭제 가능. 단 향후 LLM 기반 reflection 단계에서 다시 필요할지 모름 → 우선 폐기, 필요해지면 hook chain 으로 재빌드.
2. **write_summary (`transcripts/summary.md`) 의 위치** — STMHandle 관할이 아닌 부속 인공물로 둘지, 별도 SummaryHandle 인터페이스 만들지. → 우선 부속 인공물 (Geny 직접) 로 가고 충분.
3. **executor SQL provider 의 metadata 컬럼** — 현재 SQL provider 사용 안 함이면 EXEC-4 보류. 추후 SQL 사용 시 신규 PR.
4. **MemoryHooks.after_note_write 의 동기 vs 비동기** — Geny 비즈니스 로직이 무거우면 (예: vault_map 재빌드 + DB dual-write) 동기 hook 이 record_turn 을 블록. → hook 은 fire-and-forget asyncio task 로 wrap.
5. **frontmatter 이중 렌더링** — DB `content` 컬럼이 frontmatter+body 합본을 저장하는 현재 스키마를 body-only 로 바꿀지. → 우선 그대로 유지 (Geny 가 자기 render_frontmatter 로 합본 만들고 DB 에 저장, executor 는 disk 에 자기 렌더). DB 스키마 변경은 별도 사이클.

---

## 10. 다음 액션

1. 이 plan 문서 사용자 승인.
2. 승인 시 executor 레포에서 EXEC-1 부터 시작 (dataclass metadata 필드 추가 + 테스트).
3. EXEC-1 머지 → Geny 레포에서 GENY-1 (STM thin adapter) 시작.
4. 각 PR 머지 후 docker rebuild → VTuber 세션 검증 → 다음 PR.

각 PR 은 직전 사이클의 PR-3a~3i 와 같은 cadence (단일 응답으로 완결, 검증 가능, 회귀 시 단독 revert 가능) 를 유지.
