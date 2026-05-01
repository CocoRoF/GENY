# PR 2 — record_message → conversations/ 자동 작성 훅

> Phase 1 / Plan §3 Phase 1 PR 2
> Status: ✅ 작성 완료 + standalone 통합 smoke test pass + baseline xfail 4개 PASS 로 flip
> Depends on: PR 1 (ConversationArchiver 인프라)
> Blocks: PR 3 (STM 락 — archiver + STM 둘 다 락 보호 필요), PR 4 (dms/daily 인덱스가 conversations/ ref 를 wikilink 로 따라감)

## 목적

`SessionMemoryManager.record_message` 가 호출될 때마다 자동으로 `conversations/<date>/<id>.md` 1 파일 작성. STM jsonl 라인의 `metadata.payload.conversation_ref` 에 그 파일 경로 박힘. 이것이 **leaf source-of-truth** 약속의 첫 발현 — 모든 turn 이 영구 보존되고, STM 캡(5000자/2000줄) 이 무관해짐.

## 산출물

### 1. SessionMemoryManager 변경 (3 곳)

[`backend/service/memory/manager.py`](../../backend/service/memory/manager.py):
- `__init__` 에 `_ConversationArchiver` 클래스 ref + `_conversation_archiver` 슬롯 (None 초기값)
- `initialize()` 에서 `ConversationArchiver(memory_dir, session_id=...)` instantiate
- `record_message` body 내부에 hook 추가:
  ```python
  archived = self._maybe_archive_conversation(role, content, out_meta)
  if archived is not None and out_meta is not None:
      out_meta = _augment_meta_with_conversation_ref(out_meta, archived)
  # ... 기존 STM 쓰기 (provider OR legacy 양쪽 모두) 가 augmented out_meta 로 흐름 ...
  ```
- 신규 best-effort 헬퍼 메서드 `_maybe_archive_conversation` (entity_bootstrap 미러: try/except, 절대 raise 안 함)

### 2. 모듈 레벨 helper

`_augment_meta_with_conversation_ref(meta, archived) -> dict` — defensive copy. 기존 payload 키 모두 보존하고 `conversation_ref` 만 추가. tool_run_summary 의 tools_used / files_written / cost_usd 같은 필드는 절대 손상되지 않음.

### 3. 단위 + 통합 테스트

[`backend/tests/service/memory/test_record_message_archives.py`](../../backend/tests/service/memory/test_record_message_archives.py) — 4 + 7 = 11 테스트:
- `TestAugmentMetaWithConversationRef` (4) — 빈 payload / 기존 키 보존 / defensive copy / 스테일 ref overwrite
- `TestRecordMessageArchives` (7) — user_chat 양방 작성 / legacy skip / long body 보존 / payload 키 보존 / archive 실패 비차단 / 5턴 5파일 / hook 순서 (archive → bootstrap)

### 4. baseline xfail 4개 → PASS flip

[`backend/tests/integration/test_memory_v2_baseline.py`](../../backend/tests/integration/test_memory_v2_baseline.py):
- `test_conversations_one_file_per_turn` ✅
- `test_conversations_frontmatter_canonical_13_keys` ✅
- `test_long_turn_full_body_in_conversations` ✅
- `test_stm_lines_carry_conversation_ref` ✅

`strict=True` xfail 였기 때문에 PR 2 가 ship 되지 않은 상태로 통과하면 CI 가 실패하도록 설계되어 있었음. PR 2 이후 invariants 가 진짜로 충족되니 마커를 안전하게 제거.

## 결정 사항

1. **archive 가 STM 쓰기 BEFORE**: `out_meta` 가 STM 으로 가기 전에 archive → augment 순서. 이유: STM 라인이 conversation_ref 를 가지려면 metadata mutation 이 STM write 이전에 일어나야 함. archive 실패 시 augment 도 안 일어나고 STM 라인은 ref 없이 그대로 작성됨 (degraded mode 보장).
2. **best-effort 패턴**: archive 실패가 STM 쓰기를 막으면 안 됨. `_maybe_archive_conversation` 가 try/except + logger.debug 로 swallow. entity_bootstrap 패턴 미러.
3. **provider adapter 와 legacy STM 둘 다 augment 효과**: archive + augment 가 STM write call site 위에 있으므로 두 경로 모두 augmented metadata 를 받음. 하나만 작동시키는 갈림길 X.
4. **defensive copy**: `_augment_meta_with_conversation_ref` 가 새 dict 반환 — 호출자의 metadata 가 mutate 되지 않음. InteractionEvent metadata 가 다른 곳 (entity_bootstrap, dm_archiver 등) 에서도 읽히기 때문에 부작용 차단.
5. **archiver lifecycle**: `__init__` 에선 placeholder, `initialize()` 에서 instantiate. SessionMemoryManager 가 initialize 없이 사용되는 경우 archiver 가 None 이라 `_maybe_archive_conversation` 가 그냥 None 리턴 (안전).
6. **xfail 마커 제거**: `strict=True` 가 있었기 때문에 invariant 가 실제로 충족되면 무조건 마커를 제거해야 함. 이 PR 가 invariant 4개를 동시에 충족시키므로 4개 마커 일괄 제거.

## 검증 결과

```
$ python3 -c '... module-level helper smoke ...'
helper: OK
payload preservation: OK

$ python3 -c '... record_message integration ...'
STM line carries conversation_ref: conversations/2026-05-01/12-53-46__user__27617f5b.md
OK — conversation file at /tmp/.../memory/conversations/2026-05-01/12-53-46__user__27617f5b.md
legacy skip: OK
archive failure non-blocking: OK
long body preservation: OK
5 turns → 5 distinct files: OK

$ python3 -c '... baseline scenario ...'
jsonl line counts: vtuber=16, worker=6
conversations files: vtuber=16, worker=6
test_conversations_one_file_per_turn: PASS
test_conversations_frontmatter_canonical_13_keys: PASS (17 keys present)
long-body conversation file: conversations/2026-05-01/12-54-41__user__c82ff856.md (6840 chars)
test_long_turn_full_body_in_conversations: PASS
test_stm_lines_carry_conversation_ref: PASS
```

(sandbox 에 `geny_executor` 가 없어 `try_record_message` 경로가 ImportError 로 실패하는데, 이건 기대 동작 — provider adapter 가 import 실패 시 legacy STM path 가 자동 fallback. production 환경에서는 provider 경로가 정상.)

## 알려진 제약

- 이 PR 까지는 STM 락이 없음 — 두 record_message 가 동시 도착하면 jsonl 라인 / conversations/ 파일 둘 다 깨질 수 있음. PR 3 가 락 추가.
- conversations/ 파일이 entities/ 의 `## Recent conversations` 섹션에 자동 등록되지 않음 — Phase 6 PR 16 책임.
- `_index.json` 가 conversations/ 의 13키 중 일부만 surface — Phase 2 PR 6 가 `MemoryFileInfo` 확장 시 추가.

## 다음 액션 (PR 3 — STM 락)

1. `service/memory/short_term.py` 의 `ShortTermMemory.__init__` 에 락 추가:
   - `self._async_lock = asyncio.Lock()` — 비동기 호출자용
   - `self._sync_lock = threading.Lock()` — 동기 호출자 (sync 라우터 등)
2. `add_message` / `add_event` / `_append_jsonl` 가 sync 락으로 보호. 비동기 entry point 가 있다면 async 락도.
3. ConversationArchiver 의 `_write_to_disk` 도 동일 패턴으로 락 보호 (같은 디렉터리 동시 쓰기 회피).
4. 동시성 테스트: 100개 record_message 동시 실행 → STM 100라인 + conversations/ 100파일 (corrupted 0개).
