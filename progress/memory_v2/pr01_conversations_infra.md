# PR 1 — conversations/ 카테고리 인프라

> Phase 1 / Plan §3 Phase 1 PR 1
> Status: ✅ 작성 완료 + standalone smoke test pass
> Depends on: PR 0 (안전망 fixture)
> Blocks: PR 2 (record_message hook), PR 4 (dm_archiver/daily_journal), PR 6 (frontmatter indexing extension)

## 목적

`memory/conversations/` 라는 새 leaf source-of-truth 카테고리의 **writer 인프라** 만 만든다 — 카테고리 등록 + ConversationArchiver 모듈 + unit test. 이 PR 머지 후에도 production 동작은 그대로 (record_message 가 아직 archiver 를 호출하지 않음 — 그건 PR 2). plan.md §1.5 ~ §1.6 의 규약을 코드로 박는 게 본 PR 의 deliverable.

## 산출물

### 1. 카테고리 등록 (Geny + executor 동기)

| 파일 | 변경 |
|---|---|
| [`backend/service/memory/structured_writer.py`](../../backend/service/memory/structured_writer.py) | `VALID_CATEGORIES` 에 `conversations`, `dms`, `compactions` 추가 + 5분류 (LEAF/INDEX/DERIVED/CURATED/ARTIFACT) doc-comment 박음 |
| [`../geny-executor/src/geny_executor/memory/providers/file/layout.py`](../../../geny-executor/src/geny_executor/memory/providers/file/layout.py) | `NOTE_CATEGORIES` 에 동일 카테고리 동기 |

이 두 set 은 mirror 관계 (Geny 가 master, executor 가 따라옴). 이후 PR 들에서 어느 한 쪽만 바꾸면 디스크 호환성이 깨지니 주의.

### 2. ConversationArchiver 모듈 신규

[`backend/service/memory/conversation_archiver.py`](../../backend/service/memory/conversation_archiver.py) (~480 LOC)

API surface:
- `ConversationArchiver(memory_dir, *, session_id="", tz=None)`
- `archiver.archive(role, content, metadata) -> Optional[ArchivedConversation]`
- `ArchivedConversation` dataclass: `(relative_path, absolute_path, importance, event_id)`

내부 빌더 함수 (별도 export — 단위 테스트 가능):
- `compute_importance(kind, content_chars, payload)` — 4단계 휴리스틱 (plan §1.6.4)
- `filename_for(ts, role, event_id, eid_width)` — `(date, name)` 튜플
- `short_event_id(event_id, width)` — 충돌 시 widening 가능
- `sanitize_counterpart(counterpart_id)` — `entity_bootstrap` 과 동일 알고리즘
- `build_title(kind, direction, counterpart_id, content)`
- `build_links_to(kind, counterpart_id, date)` — wikilink 타겟 리스트
- `build_tags(kind, counterpart_role)`
- `build_frontmatter(...)` — 17키 dict
- `build_body(...)` — markdown 본문 (tool_run_summary 는 구조화 블록 + raw payload JSON)

### 3. unit 테스트

[`backend/tests/service/memory/test_conversation_archiver.py`](../../backend/tests/service/memory/test_conversation_archiver.py) (~440 LOC)

4 그룹으로 분할:
- `TestComputeImportance` — 9 케이스 (critical / high × 3 / low × 2 / medium × 2 / 우선순위)
- `TestFilenameHelpers` — 7 케이스 (8자/12자/clamp/empty/owner sanitize/unicode/UUID 통과)
- `TestBuilders` — 7 케이스 (title 4 + links_to 3 + tags 2)
- `TestArchiverDiskIntegration` — 7 케이스 (legacy → None / user_chat 17키 / long body 보존 / tool_run_summary payload / 충돌 widening / index round-trip / self-cp dms skip)

총 30 어설션. 모두 standalone smoke (sandbox httpx 부재 우회) 로 통과 확인 완료.

## 결정 사항

1. **ConversationArchiver 가 StructuredMemoryWriter 와 분리**: 11키 frontmatter 와 17키 frontmatter 를 한 writer 에 욱여넣지 않음. structured_writer 는 사람이 명시적으로 쓰는 노트 (topics/projects/insights 등) 전담, archiver 는 InteractionEvent 자동 기록 전담. 인덱싱은 양쪽 모두 같은 `MemoryIndexManager` 가 처리.
2. **importance 가 자동 산정** (호출자가 안 넘김): plan §1.6.4 의 규칙 — `critical: system_note + errors`, `high: long body OR task_result+files OR errors`, `low: reflection OR <50 chars`, `medium: 그 외`. 우선순위는 long-body 가 low-kind 를 이김 (6000자 reflection 은 high).
3. **충돌 시 eid8 → eid12 → … → eid32 widening**: 같은 초·같은 role 에 두 turn 이 도착하면 두 번째가 자동으로 prefix 를 4 chars 씩 늘려 unique 한 파일명 확보.
4. **wikilink 형식**: `dms/<sanitized_cp>/<date>` (DM-class 만), `entities/<sanitized_cp>` (self/system 제외), `<date>` (daily journal — 항상). 본문 끝 `**Linked:**` 섹션에도 동일 wikilinks 가 boilerplate 로 들어가 Obsidian 데스크톱 사용자가 frontmatter 안 봐도 점프 가능.
5. **ts 해석**: `metadata.ts` (ISO string) 우선, 없으면 archiver 의 `tz`-aware `datetime.now()`. 테스트는 `tz=timezone.utc` 명시 주입으로 GENY_TIMEZONE 환경변수 영향 차단 (production 은 KST 기본).
6. **render_frontmatter 호환**: 기존 `_yaml_line` 헬퍼는 inline list 만 지원 → `links_to: [target1, target2]` 형식으로 직렬화. multi-line block list 는 사용 X.

## 검증 결과

```
importance 9/9 OK
filename_for OK (date + 01-22-12__assistant_dm__25a3ca45.md)
short_event_id OK (default 8 / widen 12 / clamp 32 / empty 8)
sanitize OK (owner: → owner_, unicode → _, UUID 통과)
build_title 4/4 OK
build_links_to 3/3 OK
build_tags 2/2 OK
─── disk integration ───
legacy metadata → None: OK
user_chat write (17 frontmatter keys, content_chars match): OK
long body 6000+ chars: 본문 통째 보존 OK
tool_run_summary payload block (Status/Tools/Files/Duration/Cost/Body/Raw payload + linked_event_id 푸터): OK
충돌 widening: deadbeef → deadbeef1111: OK
self counterpart 의 dms 링크 skip: OK
```

## 알려진 제약

- 이 dev sandbox 가 `httpx` 미설치 — 정식 pytest 실행은 사용자 dev env 에서 필요. 대신 standalone smoke (직접 import 우회) 로 모든 어설션 통과 확인.
- `MemoryIndexManager` 가 conversations/ 의 13키 중 `event_id`/`kind`/`direction` 등을 surface 하지 않음 — 현재 11키 `MemoryFileInfo` 에 들어가는 `category/title/tags/importance/links_to` 만 추출됨. 나머지는 PR 6 가 `_index.json` 스키마 확장 시 surface.
- Phase 0 baseline 의 `test_conversations_one_file_per_turn` 등 xfail 마커는 이 PR 머지 후에도 여전히 fail (record_message 훅이 PR 2 책임).

## 다음 액션 (PR 2 로 넘어갈 때)

1. `service/memory/manager.py` 의 `record_message` 안에 `_maybe_archive_conversation` 호출 추가 — `_maybe_bootstrap_entity` 직전에 배치해서 entity_bootstrap 이 conversation_ref 를 참조할 수 있게.
2. `service/memory/short_term.py` 의 `add_message` 가 metadata.payload 에 `conversation_ref` 박힐 수 있도록 — archiver 결과로 `record_message` 가 metadata 변경.
3. baseline 의 xfail 마커 4개 flip:
   - `test_conversations_one_file_per_turn`
   - `test_conversations_frontmatter_canonical_13_keys`
   - `test_long_turn_full_body_in_conversations`
   - `test_stm_lines_carry_conversation_ref`
4. PR 2 의 진짜 risk 는 record_message 가 hot path 라는 것 — archiver 호출 실패가 STM 쓰기를 막으면 안 됨. archiver 안에 `try/except` + `logger.debug` 로 silent skip 패턴 적용 (entity_bootstrap 의 best-effort 패턴 미러).
