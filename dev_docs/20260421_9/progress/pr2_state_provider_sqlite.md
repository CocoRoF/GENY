# PR-X3-2 · `feat/state-provider-sqlite` — 진행 기록

**Date.** 2026-04-21
**Status.** Implemented, 270/270 pass (기존 227 + 신규 43). MVP 저장소 레이어 완결.

## 범위

plan/02 §3 의 `CreatureStateProvider` Protocol + 두 구현체 (in-memory, sqlite) + 초기 마이그레이션.
`tick()` 은 `DecayPolicy` 의존성을 가지므로 본 PR 에서 제외 — PR-X3-4 에서 Protocol 확장.

## 적용된 변경

### 1. `backend/service/state/provider/interface.py` (신규)

- `CreatureStateProvider(Protocol)` — `load / apply / set_absolute`.
- `StateConflictError` — OCC 충돌 시 raise.
- `RECENT_EVENTS_MAX = 20` — ring buffer 상한 상수.

### 2. `backend/service/state/provider/mutate.py` (신규)

- `apply_mutations(snapshot, mutations, *, now=None) -> CreatureState`.
- 순수 함수: snapshot 을 deepcopy 한 뒤 mutation 순서대로 replay, 실패 시 원본 무손상.
- 4 op dispatch (`add` / `set` / `append` / `event`). ring buffer trim 은 `recent_events` 에서만.
- **빈 mutations 는 fast path** — 같은 인스턴스 그대로 반환, `last_interaction_at` 안 건드림.

### 3. `backend/service/state/provider/serialize.py` (신규)

- `dumps / loads / from_dict` — JSON roundtrip. `datetime` → ISO-8601, nested dataclass → dict.
- `from_dict` 가 missing `last_tick_at` 에 `ValueError` raise — 외부 blob 이 손상돼 있으면 즉시 실패.

### 4. `backend/service/state/provider/in_memory.py` (신규)

- `InMemoryCreatureStateProvider` — dict 기반, per-character `asyncio.Lock`.
- `load / apply / set_absolute` 모두 내부 상태를 `copy.deepcopy` — caller 가 반환값을 mutate 해도 store 불변.
- Mock 용 / feature flag off 경로 용.

### 5. `backend/service/state/provider/sqlite_creature.py` (신규)

- `SqliteCreatureStateProvider(db_path=":memory:" | Path)` — stdlib `sqlite3` + `asyncio.to_thread`.
- `load` 가 없을 시 default row insert (`row_version = 1`), 있을 시 blob 역직렬화 + `_row_version` 속성을 dataclass 인스턴스에 동적 부착.
- `apply` 는 **caller 가 받은 row_version** (`snapshot._row_version`) 을 expected 로 OCC:
  ```sql
  UPDATE creature_state
     SET ..., row_version = row_version + 1
   WHERE character_id = ? AND row_version = ?
  ```
  `rowcount == 0` → `ROLLBACK` → `StateConflictError`.
- `_row_version` 이 없는 경우 (administrative path, 미-load 상태) 는 fallback 으로 재-read — 그 경로는 stale-snapshot 보호 포기.
- `BEGIN IMMEDIATE` 로 UPDATE 를 감싸 동시 write 충돌 시 즉시 실패.

### 6. `backend/service/state/provider/migrations/0001_initial.sql` (신규)

- `creature_state` 테이블 + `idx_creature_state_owner`.
- `data_json TEXT NOT NULL` — blob 방식 (plan/02 §3.2 근거).
- `row_version INTEGER NOT NULL DEFAULT 1`.

### 7. `backend/service/state/__init__.py` (수정)

- provider 레이어 심볼 재수출 (`InMemoryCreatureStateProvider`, `SqliteCreatureStateProvider`, `StateConflictError`, `CreatureStateProvider`, `apply_mutations`, `RECENT_EVENTS_MAX`).

### 8. 테스트 (신규 43)

`backend/tests/service/state/provider/`:

- **test_mutate.py (17):** empty fast path / add numeric paths / set / append / event / ring buffer trim / add+set ordering / set+add ordering / unknown op / unknown path / partial failure 원본 무손상 / `last_interaction_at` bump.
- **test_serialize.py (6):** JSON string / default roundtrip / modified state roundtrip / datetime UTC 보존 / missing `last_tick_at` 검증 / partial substructures.
- **test_in_memory_provider.py (8):** default 생성 / load copy / apply persist / empty noop / set_absolute / unknown character / 다중 캐릭터 isolation / 동시 apply 직렬화.
- **test_sqlite_provider.py (12):** 마이그레이션 / 기본 row_version=1 / 재-load 격리 / apply row_version bump / **stale snapshot → StateConflictError** (진짜 2 라운드 시나리오) / empty apply skip / set_absolute / unknown character / ring buffer reload / 파일 기반 재접속 / 다중 캐릭터 isolation.

## 테스트 결과

- `backend/tests/service/state/` — **73/73 pass**.
- `backend/tests/service/tick/` — **19/19**.
- `backend/tests/service/lifecycle/` — **27/27**.
- `backend/tests/service/persona/` — **36/36**.
- `backend/tests/service/langgraph/` — **104/104**.
- `backend/tests/service/vtuber/test_thinking_trigger_tick.py` — **11/11**.
- 총 **270/270 pass**.

## 설계 결정

- **왜 stdlib `sqlite3` + `to_thread` 인가.** Geny 는 PG 를 쓰지만 X3 MVP 를 PG 마이그레이션과 엮으면 롤아웃 비용이 커진다. 자체 파일 DB 로 먼저 shape 을 굳히고, 안정화 후 PR-X5+ 에서 PG 로 이식.
- **왜 blob 컬럼인가.** X3/X4 동안 필드가 활발히 변한다. 컬럼 마이그레이션 대신 JSON 하나로 두고 query-hot 필드는 v2 에서 promote.
- **왜 `_row_version` 을 dataclass 에 동적 부착하나.** Protocol 시그니처를 깔끔하게 유지하면서도 caller 가 받은 stale 스냅샷이 진짜 stale 인지 판정 가능. 필드로 넣으면 schema 일부가 되어 직렬화에 섞임.

## 의도적 비움

- **`tick()` Protocol 메소드.** DecayPolicy 가 PR-X3-4 에 있으므로 거기서 Protocol 확장.
- **재시도 로직.** plan/02 §8.2 의 "최대 3회 retry 후 실패 시 load+replay" 는 registry (PR-X3-3) 또는 agent_session 통합 (PR-X3-5) 에서 결정 — provider 는 단일 시도로만.
- **Observability 이벤트.** `state.hydrated / persisted / conflict` 등은 registry/agent_session 의 책임 (plan/02 §9).
- **이력 audit 로그.** plan/02 §3.4 — X6 이후.

## 다음 PR

PR-X3-3 `feat/session-runtime-registry` — `SessionRuntimeRegistry` (hydrate + persist) + `hydrator` 모듈. `state.shared['creature_state']` / `state.shared['creature_state_mut']` 주입 계약.
