# Cycle 20260501_2 — Plan

> Goal recap: cycle 20260501_1 정착시킨 *통합 메모리 flow* (단일 LLM
> client / 단일 STM write site / 1급 metadata) 위에서, 사용자가
> 운영 중 발견한 세 *구체적* 결함을 **scope를 늘리지 않고** 마무리.
>
> 사용자 지시 (그대로): *"이제 남은 것들을 정말 완벽하게 만들어 놔.
> 지금 entities가 memory에 기록되는데 memory_distill에 대해서
> 계속 나오고 있어. … 내가 지시하지 않은 범위를 검토하라는 건 아니야."*

## 입력: 운영 중 관찰된 데이터

사용자가 직접 남긴 두 파일을 본 cycle 의 *유일한 진단 입력* 으로 삼는다.

### `transcripts/<session>.jsonl` (요약)

| # | role | kind | metadata.event_id 등 | 문제 |
|---|---|---|---|---|
| 1 | `assistant_dm` | `task_request` | ✅ 채워짐 | (Geny hook write — Non-goal scope) |
| 2 | `user` | `user_chat` | ✅ | OK |
| 3 | `assistant` | `user_chat`/out | ✅ | OK (s18 첫 assistant) |
| 4 | `assistant` | — | ❌ **None** | **F1**: 같은 turn 의 *두 번째* assistant — pending hint 가 첫 번째에만 적용됨 |
| 5 | `user` | `tool_run_summary`/in | ✅ | OK (cycle 20260501_1 D path 작동) |
| 6 | `assistant` | — | ❌ **None** | **F2**: SUB_WORKER_RESULT 입력으로 stm_role=`assistant_dm` → assistant 기본값 미적용 |

### `entities/<sanitized>.md`

```
_(아직 distillation 이 진행되지 않았어요. memory_distill 을 호출하면
누적된 상호작용을 요약해 둡니다.)_
```

→ **F3**: `maybe_bootstrap_entity` 가 `if file.exists(): return None` 으로
첫 stub 만 쓰고 영원히 갱신하지 않음. 사용자가 `memory_distill` 을
명시적으로 호출하지 않는 한 stats 가 *절대* 채워지지 않는다. 사용자가
"memory_distill에 대해서 계속 나오고 있어" 라고 지적한 *그 stub 문장*
이 바로 이 파일의 잔존 상태.

## 본 cycle 의 *경계*

본 cycle 은 다음 *세 결함만* 다룬다. cycle 20260501_1 progress note 에
나열한 *다음 cycle 후보* (MemoryProvider 4-axis, outgoing DM ToolContext,
auto distill cron) 는 **명시적 Non-goal**.

## 잠금된 4 invariant (cycle 20260501_1)

본 cycle 의 변경은 모두 다음을 *깨지 않는다*:

1. Pipeline 의 모든 LLM 호출이 단일 `state.llm_client`.
2. STM record_message 단일 호출 site = s18 (`GenyDedupeStrategy._record_transcript`).
3. stage 번호는 코드의 진실 (s18 = order 18).
4. InteractionEvent metadata 5 dimension 1급 시민.

F1 / F2 는 invariant 4 의 *완성도* 를 끌어올린다. F3 는 invariant 2 의
*하위 hook* (`entity_bootstrap`) 의 동작을 보강한다.

## Fix ladder

### F1 — GenyDedupeStrategy: 같은 role 중복 메시지의 metadata thread

**파일**: `backend/service/memory/dedupe_strategy.py`

**현행**:

```python
applied = {"user": False, "assistant": False}
for msg in new_messages:
    role = msg.get("role", "")
    ...
    metadata: Dict[str, Any] | None = None
    if role in applied and not applied[role]:
        hint = pending.get(role)
        if isinstance(hint, dict) and hint:
            metadata = hint
        applied[role] = True
    record(role, content[:5000], metadata=metadata)
```

같은 role 의 *두 번째* 메시지는 `applied[role] = True` 로 인해 영원히
`metadata=None` 으로 기록. session.jsonl 의 line 4 가 정확히 이 path.

**수정**: 같은 role 의 후속 메시지는 *같은 hint 를 template* 으로 삼아
`make_event_metadata` 로 **fresh event_id** 를 가진 새 metadata 를 생성.
kind / direction / counterpart_id / counterpart_role / linked_event_id /
payload 는 hint 그대로 복사.

```python
if role in applied:
    hint = pending.get(role)
    if isinstance(hint, dict) and hint:
        if not applied[role]:
            metadata = hint
            applied[role] = True
        else:
            # Same-role 2nd+ message in this batch — fresh event_id,
            # same kind/direction/counterpart from the template.
            metadata = _fresh_from_template(hint)
```

`_fresh_from_template` 은 `make_event_metadata` 를 통해 새 event_id 를
얻는 작은 helper. import 실패 / 잘못된 hint 는 silent fallback (None).

**테스트** (`tests/service/memory/test_dedupe_strategy.py`):

- `test_pending_metadata_applies_to_first_user_only` 의 의미를 뒤집고
  대신 `test_pending_metadata_threads_through_repeated_role` 을 작성:
  - 두 user 메시지 모두 metadata 가 채워진다.
  - kind / direction / counterpart_id / counterpart_role 는 동일.
  - event_id 는 *서로 다르다* (uuid 새로 발급).

### F2 — VTuber session: assistant 기본값 USER_CHAT/OUT (stm_role 무관)

**파일**: `backend/service/executor/agent_session.py`
(`_invoke_pipeline` + `_astream_pipeline` 둘 다)

**현행**:

```python
if stm_role == "user":
    pending_metadata["assistant"] = make_event_metadata(
        kind=Kind.USER_CHAT,
        direction=Direction.OUT,
        counterpart_id=canonical_user_id(self._owner_username),
        counterpart_role=CounterpartRole.USER,
    )
```

VTuber session 에서 SUB_WORKER_RESULT 입력은 `_classify_input_role` 이
`assistant_dm` (또는 `internal_trigger`) 으로 분류 → 위 분기 미진입 →
assistant 응답이 metadata 없이 기록.

**근거**: VTuber 의 모든 응답은 `_save_subworker_reply_to_chat_room` /
일반 chat broadcast 를 통해 owner 에게 전달된다. trigger 가 무엇이었든
*응답 자체는 USER_CHAT/OUT* 이다. 반면 Worker / Sub-Worker session 의
응답은 task_response 에 가까워 USER_CHAT 기본값이 부적절 — 그래서
*VTuber 한정* 으로만 확장.

**수정**:

```python
should_default_assistant_user_chat = (
    stm_role == "user"
    or self._role == SessionRole.VTUBER
)
if should_default_assistant_user_chat:
    pending_metadata["assistant"] = make_event_metadata(
        kind=Kind.USER_CHAT,
        direction=Direction.OUT,
        counterpart_id=canonical_user_id(self._owner_username),
        counterpart_role=CounterpartRole.USER,
    )
```

`_invoke_pipeline` (line ~2107) 과 `_astream_pipeline` (line ~2655) 양쪽
동일 패치.

**테스트** (`tests/service/executor/test_agent_session_memory.py`):

- VTuber session, stm_role 가 `assistant_dm` (SUB_WORKER_RESULT 입력) 일
  때 `pending_metadata["assistant"]` 가 USER_CHAT/OUT 으로 채워짐을
  pin.
- Worker session, 동일 stm_role 에서는 *비어있음* (기존 의미 보존).
- `_astream_pipeline` 도 동일하게 동작 (parametrize).

### F3 — entity_bootstrap: 기존 파일에 incremental stats refresh

**파일**: `backend/service/memory/entity_bootstrap.py`

**현행**: `if full.exists(): return None` — stub 이 영구 고정.

**수정**: 파일이 *이미 존재* 하면 stats 를 다시 계산해서 body 를 갱신:

1. `_summarise_counterpart_events(entries, cp_id, cap)` (cap=256, 본
   cycle 에서는 default 와 동일) 로 stats 재계산. 이 helper 는
   `tools.built_in.memory_inspect_tools` 에 이미 존재 — *재export* 만
   추가하면 import 가능 (기존 _sanitize parity test 의 패턴 그대로).
2. `_render_entity_markdown(stats, counterpart_role, narrative=None)` 로
   body 생성. *narrative=None* 이므로 LLM 호출 없음 (cycle 20260501_1 의
   "auto distill 은 Non-goal" 경계 보존).
3. `writer.update_note(rel_path, content=body)` 로 본문 교체.

stats 가 비어 있으면 (events_seen == 0) **stub 으로 회귀하지 않는다** —
hook 호출 자체가 *현재 record_message* 를 통해 이뤄지므로 events_seen
은 최소 1.

**경계**:

- LLM narrative 호출 없음 (auto-distill 은 다음 cycle).
- Vector index touch 없음 (write_note path 만 — `update_note` 가 이미
  index 를 갱신함, parity 보장).
- record_message 가 raise 하지 않게 best-effort 유지 (`try/except`).

**테스트** (`tests/service/memory/test_entity_bootstrap.py`):

- 기존 `test_existing_file_skipped` 를 *뒤집고* 새 contract 로 재작성:
  - 두 번째 호출 시 `update_note` 가 호출되고 body 에 stats heading 이
    들어가 있다.
- `update_note` 가 raise 해도 hook 자체는 None 반환 (best-effort).
- `events_seen == 0` 인 인공적인 케이스에서도 stub 으로 *되돌아가지 않음*.

## PR ladder

| # | PR scope | 파일 |
|---|---|---|
| plan | docs PR — 본 문서 | `dev_docs/20260501_2/plan/cycle_plan.md` |
| F1 | dedupe_strategy + tests | 1 + 1 |
| F2 | agent_session pending_metadata + tests | 1 + 1 |
| F3 | entity_bootstrap refresh + tests | 1 + 1 |
| done | progress note | `dev_docs/20260501_2/progress/01_cycle_complete.md` |

각 PR 자체-검증 (`pytest path::test_...`) → main merge → branch 정리.

## Non-goals (명시적으로 *건드리지 않음*)

1. **Outgoing DM ToolContext 통합** — `_record_dm_on_sender_stm` /
   `send_direct_message_internal` 의 외부 record_message 잔존 path 는
   유지. cycle 20260501_1 의 progress note 에서 이미 *다음 cycle 후보*
   로 표기됨.
2. **MemoryProvider 4-axis 활성화** — `s18_memory.execute` 의 Provider
   path. 큰 작업, 본 cycle 의 세 핀포인트 결함과 무관.
3. **자동 distillation cron** — `narrative=true` 의 임계치 trigger.
4. **Vector index 의 InteractionEvent metadata 인덱싱** / **DB schema
   metadata 컬럼 인덱싱** — 운영 규모 대응 작업.
5. **Legacy STM jsonl 백필** — 옛 라인 metadata 비어 있는 건 그대로
   둠. 본 cycle 이후의 *새* turn 만 완결적.

## 회귀 위험

* F1 의 동일 role 다중 메시지 path 가 의외로 *재요약 / multi-turn replay*
  같은 코너 케이스에서 발생할 수 있음 — 새 event_id 라 dedupe 에 영향
  없음 확인 (test 로 잠금).
* F2 가 reflection 출력에 영향? — reflection 은 `_record_transcript` 를
  거치지 않고 별도 `record_insight` 로 가는 path 라 무관 (cycle 20260501_1
  C 가 보존한 invariant).
* F3 의 update_note 가 vector / DB write 를 동반함 → record_message 의
  hot path 가 무거워질 가능성. cap=256 로 STM 재스캔이 짧고, vector
  upsert 는 best-effort. 운영 모니터로 관찰.
