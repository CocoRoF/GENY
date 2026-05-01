# PR 3 — STM 락 + ConversationArchiver 락

> Phase 1 / Plan §3 Phase 1 PR 3
> Status: ✅ 작성 완료 + 100-thread 동시성 테스트 PASS
> Depends on: PR 2 (record_message 훅 — 락 없으면 archive + STM 둘 다 깨짐)
> Blocks: 없음 (다음 PR 4 가 dms/daily 인덱스를 추가해도 lock 의존 X — 인덱스 라이터는 자체 락 가짐)

## 목적

`record_message` 가 hot path 라 multiple writer (사용자 turn / ActivityTrigger / IdleTrigger / 백그라운드 reflection) 가 동시에 도착할 수 있음. 락 없이는:
- STM jsonl 라인이 두 thread 의 bytes 가 섞여 깨짐 → 다음 read 가 silently drop
- conversations/ 가 같은 초·같은 widening 단계의 collision-detect-then-write 안에서 두 thread 가 동일 파일명을 동시에 "absent" 로 보고 둘 다 write 하다가 한 개 본문이 사라짐

이 PR 가 두 critical section 모두 `threading.RLock` 으로 보호.

## 산출물

### 1. ShortTermMemory 락

[`backend/service/memory/short_term.py`](../../backend/service/memory/short_term.py):
- `__init__` 에 `self._lock = threading.RLock()` 추가
- `_append_jsonl` 의 전체 body 가 `with self._lock:` 안에서 실행 (write + counter bump + 가능한 truncation)
- `_read_jsonl` 도 락 보호 — 동시 write 와 동시 read 의 부분 flush 보호. RLock 이라 `_maybe_truncate_file` 이 outer lock 들고 있는 상태에서도 deadlock 없음
- `_maybe_truncate_file` 의 read-modify-write 가 atomic — 트렁케이트 와중에 새 라인 도착해도 안전

### 2. ConversationArchiver 락

[`backend/service/memory/conversation_archiver.py`](../../backend/service/memory/conversation_archiver.py):
- `__init__` 에 `self._lock = threading.RLock()` 추가
- `_write_to_disk` 의 collision-widening 루프 전체가 `with self._lock:` 안에서 실행 — exists() check 와 write 사이가 atomic

### 3. 동시성 테스트

[`backend/tests/service/memory/test_record_message_concurrency.py`](../../backend/tests/service/memory/test_record_message_concurrency.py) (~150 LOC):

3 케이스:
- `test_no_corrupted_jsonl_lines` — 100 thread 동시 record_message → 모든 jsonl 라인이 깨끗하게 json.loads 통과
- `test_distinct_conversation_files_per_turn` — 100 thread → 100 distinct conversations/ 파일 + 모든 STM 라인의 conversation_ref 가 unique
- `test_distinct_event_ids` — uuid4 충돌 검출 (현실적으로 안 일어나지만 InteractionEvent 가 retroactively non-unique 로 바뀌면 즉시 catch)

`threading.Barrier(N)` 로 N 개 thread 를 동시에 release 시켜 진짜 contention 을 만듦. asyncio task 가 아니라 OS thread 인 이유: lock 이 `threading.RLock` 이고, threading 은 진짜 병렬, asyncio 는 event loop 위 협조적 — threading 이 strictest stress.

## 결정 사항

1. **RLock vs Lock**: RLock 선택 — `_maybe_truncate_file` 이 자기 안에서 `_read_jsonl` 호출. 동일 thread 가 outer-acquire 후 inner-acquire 하는 패턴이 합법적이어야 함.
2. **threading.Lock vs asyncio.Lock**: 둘 중 threading 만 채택. 이유:
   - ShortTermMemory / ConversationArchiver 둘 다 sync 메서드만 존재 (async 메서드 없음)
   - async 호출자도 결국 `await asyncio.to_thread(mgr.record_message, ...)` 또는 sync 직접 호출
   - threading.Lock 이 모든 경우의 ground truth — async 가 acquire 시 event loop 이 잠깐 block (수십 µs 이내, 작은 jsonl append 라 무시 가능)
   - 이중 락 (asyncio.Lock + threading.Lock) 은 두 락이 protect 하는 임계영역이 다르면 cross-paradigm interleaving 이 가능 → 안 함
3. **archive 와 STM 이 SEPARATE 락**: archive 는 ConversationArchiver 의 락, STM 은 ShortTermMemory 의 락. 두 락이 분리됐어도 정확성 보장:
   - T1: archive A → STM A
   - T2: archive B → STM B
   - 두 thread 가 각자 archive 와 STM 호출 시 결과: A 파일·B 파일 둘 다 디스크에 존재, A 라인·B 라인 둘 다 jsonl 에 존재. 글로벌 ordering 필요 X.
4. **`_read_jsonl` 도 lock**: 동시 write 가 진행 중일 때 read 가 partial flush 본 상태로 라인 한 줄이 잘려 보일 수 있음. RLock 으로 read 도 일관 view 보장.
5. **lazy import threading**: `service.memory.short_term` 의 module-level imports 를 가볍게 유지 — `import threading` 을 `__init__` 안에서 lazy load.

## 검증 결과

```
$ python3 (100-thread barrier-released stress)

STM integrity: 100 clean lines OK
conversations/ files: 100 distinct OK
STM refs: 100 unique conversation_refs OK
event_ids: 100 unique OK
=== PR 3 concurrency tests pass ===
```

PR 2 의 baseline (`test_no_corrupt_jsonl_lines`) 도 여전히 통과 — 락 추가는 sequential path 에 영향 없음.

## 알려진 제약

- 락은 *프로세스 내부* 만 보호. 두 별도 프로세스가 같은 storage_path 를 동시 쓰면 보호 X (그건 fcntl/flock 영역인데 plan 의 범위 밖).
- DB dual-write (`db_stm_add_message`) 는 락 안에서 호출되지 않음 — 의도. DB 자체가 transaction 으로 보호되고, 동기 호출 안에서 DB I/O 까지 락 보유는 latency 증가.
- Threading 은 GIL 의해 어차피 직렬화되지만, file IO syscall 은 GIL release 점이라 진짜 interleave 가능 → 락 필수.

## 다음 액션 (PR 4 — dms/ + daily journal index writers)

1. `service/memory/dm_archiver.py` 신규 — kind ∈ {dm, task_request, task_result, tool_run_summary} 일 때 `dms/<sanitized_cp>/<date>.md` index bundle 갱신
2. `service/memory/daily_journal_writer.py` 신규 — 모든 record_message 의 `<YYYY-MM-DD>.md` (root) 갱신
3. 본문은 1-line headline + `[[conversations/.../<id>|→ 본문]]` wikilink 만 (본문 중복 금지)
4. frontmatter `event_ids` / `event_count` 누적
5. `manager.py:record_message` 에 두 hook 호출 추가 (entity_bootstrap 직전)
6. baseline xfail `test_dms_index_present_for_paired_subworker` PASS 로 flip
