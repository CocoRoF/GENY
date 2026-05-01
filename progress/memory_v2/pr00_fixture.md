# PR 0 — Memory v2 Safety Net Fixture

> Phase 0 / Plan §3 Phase 0
> Status: ✅ 작성 완료, dev env 에서 실행 검증 필요
> 다음 의존: PR 1 (conversations/ 카테고리 등록 시 baseline xfail 일부가 PASS 로 flip 되어야 함)

## 목적

v2 의 18 PR 가 진행되는 동안, 매 PR 머지 전에 한 줄로 "메모리 시스템의 골격이 살아 있다" 를 확인할 회귀 안전망을 마련.
또한 v2 가 약속하는 invariant 를 미리 `xfail(strict=True)` 로 박아두어 — PR 이 invariant 를 ship 할 때 마커를 `pass` 로 flip 하는 의식이 자동으로 잡히도록 함.

## 산출물

| 파일 | 역할 |
|---|---|
| [`backend/tests/integration/_memory_v2_scenario.py`](../../backend/tests/integration/_memory_v2_scenario.py) | 결정론적 시나리오 드라이버. `MemoryScenarioRunner` + `ScenarioSnapshot` dataclass. LLM·SDK·네트워크 없이 `record_message` 만으로 5+3 턴 시나리오 + 1 long turn (>5000 chars) 재생. |
| [`backend/tests/integration/test_memory_v2_baseline.py`](../../backend/tests/integration/test_memory_v2_baseline.py) | 두 그룹 테스트: (A) **plumbing invariant** — 시나리오가 v1 코드에서 정상 작동, jsonl 라인 수, InteractionEvent 메타 5튜플 등을 pin. (B) **v2 target invariant** — `xfail(strict=True)` 마커로 6개 약속을 박음. |

## 시나리오 형태 (plan §3 Phase 0)

```
VTuber session (16 jsonl lines)
  ├ user_chat × 5  (in/out 2 lines each = 10)
  ├ task_request × 3 (out)
  └ tool_run_summary × 3 (in, with payload, linked_event_id)

Sub-Worker session (6 jsonl lines)
  ├ task_request × 3 (in, mirror direction)
  └ task_result × 3 (out, with payload)

Long turn: 1개의 tool_run_summary 본문이 >6000 chars
```

`LONG_RESPONSE_CHARS = 6000` 로 의도해서, v1 의 `[:5000]` 트렁케이트가 trip 되도록 함. v2 PR 2 가 conversations/ 에 full body 를 보존하면 `test_long_turn_full_body_in_conversations` 가 자동으로 pass 로 flip.

## v2 invariant 마커 (xfail → 자동 flip 로드맵)

| 테스트 | flip 시점 (PR) | 검증 내용 |
|---|---|---|
| `test_conversations_one_file_per_turn` | PR 1+2 | 모든 record_message → conversations/ 1 file |
| `test_conversations_frontmatter_canonical_13_keys` | PR 1+2 | frontmatter 13키 (cf. plan §1.6.2) round-trip |
| `test_long_turn_full_body_in_conversations` | PR 2 | 6000자 turn 의 full body 가 conversations/ 에 보존 |
| `test_dms_index_present_for_paired_subworker` | PR 4 | dms/<cp>/<date>.md 인덱스 자동 생성 |
| `test_stm_lines_carry_conversation_ref` | PR 2 | STM 라인의 metadata.payload.conversation_ref 박힘 |
| `test_vault_map_present` | PR 9 | _vault_map.json 자동 생성 |

`strict=True` 라 PR 이 invariant 를 만족시키지 못한 채 우연히 pass 하면 CI 가 실패함 — 무음 머지 방지.

## 결정 사항

1. **synthetic 드라이버**: agent_session / SDK / 페르소나 다 우회. SessionMemoryManager 두 인스턴스만 직접 띄우고 `record_message` 호출. 이유: 테스트가 sub-second 안에 끝나야 모든 PR 의 CI 가 부담 없이 굴림.
2. **session_id 고정**: `0000000000000000-vtuber-scenario`, `0000000000000000-worker-scenario`. 이유: 스냅샷 diff 가 uuid 변동에 churn 되지 않게.
3. **호환 분기 검증 안 함**: 이 PR 은 "현재 v1 동작이 시나리오를 깨지 않음" 만 보장. v1 의 5000자 트렁케이트, 락 부재 등은 후속 PR 의 문제 — 베이스라인은 그걸 보고 fail 하지 않음.
4. **카테고리 inventory 만 캡처**: 본문 비교까지 가면 frontmatter 의 ts·event_id 같은 변동 필드 때문에 diff 노이즈 폭증. 본문 검증은 각 PR 의 전용 테스트 책임.

## 알려진 제약

- 이 dev sandbox 에 `httpx` 가 없어 `pytest tests/integration/test_memory_v2_baseline.py` 를 직접 돌리지 못했음. 사용자 dev env (의존 설치된) 에서 실행해 baseline 통과 확인 필요.
- 파일 자체는 `python3 -c "import ast; ast.parse(...)"` 로 syntax 검증 완료.

## 다음 액션 (PR 1 으로 넘어갈 때)

1. `service/memory/structured_writer.py` 의 `VALID_CATEGORIES` 에 `conversations` 추가.
2. `geny-executor/.../memory/providers/file/layout.py` 의 `NOTE_CATEGORIES` 에 `conversations` 추가.
3. `service/memory/conversation_archiver.py` 신규 작성 — frontmatter 13키 빌더, 파일명 빌더, importance 휴리스틱.
4. unit test (`backend/tests/service/memory/test_conversation_archiver.py`) — 13키 round-trip 8 케이스, importance 휴리스틱 8 케이스.

이 PR 1 이 끝나도 `record_message` 는 아직 archiver 를 호출하지 않음 (그건 PR 2). 따라서 PR 1 머지 후에도 baseline 의 xfail 마커는 그대로 fail.
