# PR 4 — dms/ + daily journal index writers

> Phase 2 / Plan §3 Phase 2 PR 4
> Status: ✅ 작성 완료 + 통합 smoke pass + baseline xfail (`test_dms_index_present_for_paired_subworker`) PASS 로 flip
> Depends on: PR 2 (record_message hook), PR 3 (락)
> Blocks: PR 5 (Opsidian Conversation tab — dms 카테고리 트리 노드), PR 16 (entities/ Recent conv 섹션이 dms wikilink 와 cross-reference)

## 산출물

| 파일 | 역할 |
|---|---|
| [`service/memory/dm_archiver.py`](../../backend/service/memory/dm_archiver.py) | 220 LOC — `dms/<sanitized_cp>/<date>.md` 인덱스. kind 필터: `{dm, task_request, task_result, tool_run_summary}`. self/system 카운터파트 skip. |
| [`service/memory/daily_journal_writer.py`](../../backend/service/memory/daily_journal_writer.py) | 200 LOC — `<YYYY-MM-DD>.md` (root) 인덱스. 모든 InteractionEvent. |
| [`service/memory/manager.py`](../../backend/service/memory/manager.py) | record_message 에 두 hook 추가 (archive 직후, entity_bootstrap 직전). 슬롯 + lazy instantiate + 두 best-effort helper. |

## 본문 형태

**dms/<cp>/<date>.md** (기존 cycle 의 inline-list 형식이 아닌 wikilink-only 인덱스):
```yaml
---
title: DM with paired_subworker (worker-uuid-xyz-12345)
category: dms
counterpart: "worker-uuid-xyz-12345"
counterpart_role: paired_subworker
date: 2026-05-01
event_count: 2
event_ids: [<eid1>, <eid2>]
tags: [dms, paired_subworker]
links_to: [conversations/2026-05-01/01-22-12__assistant_dm__abcd1234,
           conversations/2026-05-01/01-22-31__user__deef5678]
---
# 2026-05-01 — DM bundle (worker-uuid-xyz-12345)

## 01:22:12 · task_request → out
> [DM to worker]: test.txt 만들어줘. 충분히 긴 task description.
[[conversations/2026-05-01/01-22-12__assistant_dm__abcd1234|→ 본문]]
_event_id: `abcd1234`_

## 01:22:31 · tool_run_summary ← in
> [SUB_WORKER_RESULT]
[[conversations/2026-05-01/01-22-31__user__deef5678|→ 본문]]
_event_id: `deef5678`_
```

본문 자체는 1-line headline + 1-line excerpt + wikilink + event_id breadcrumb. **본문 중복 없음** (소스는 conversations/ 가 갖고, 여기는 인덱스).

**`<YYYY-MM-DD>.md`** (daily journal): 같은 형식이지만 카운터파트 무관 — 그 날의 모든 turn 시간순.

## 결정 사항

1. **append-shaped read-modify-write**: 매 turn 마다 기존 파일 읽고 → 새 turn 블록 append → 통째 rewrite. 락으로 atomicity 보장 (PR 3 의 RLock 패턴 미러).
2. **idempotence**: `event_ids` 가 set 처럼 동작 — 같은 event_id 가 또 들어오면 추가 안 함 (re-record 시나리오에서 double-counting 방지).
3. **kind 필터 분리**: dm_archiver 가 자체적으로 `_DM_KINDS` 필터 + `_SKIP_COUNTERPARTS` 필터 운영. 그래서 `_maybe_archive_dm` wrapper 는 kind 검사 안 해도 됨 (의무 분리).
4. **conversation_ref 가 hook chain 으로 전달**: archive 결과 → record_message 가 보유 → dm/daily 두 hook 에 전달 → 두 인덱스가 wikilink 에 사용. archive 가 None 이면 conversation_ref 도 None — 인덱스에는 wikilink 없이 entry 만 들어감 (fallback).
5. **daily_journal category=`daily-journal`**: 기존 `daily/` (사람이 쓰는 free-form) 와 구분. memory_search(category="daily-journal") 가 자동 인덱스만 잡고, memory_search(category="daily") 가 사람-작성 노트만 잡음.
6. **wikilink target 에 .md 안 붙임**: Obsidian 의 `[[target]]` 관습 따름. resolver 가 stem 매칭이라 `.md` 있어도 OK 지만 관습은 없는 형태.

## 검증 결과

```
dms files: 1
  dms/worker-uuid-xyz-12345/2026-05-01.md: event_count=2, links_to count=2

daily files: 1
  2026-05-01.md: event_count=4, category=daily-journal
    body has 4 conversations/ wikilinks

dms event_count matches expected 2: OK
daily event_count matches expected 4: OK
=== PR 4 PASS ===
```

baseline `test_dms_index_present_for_paired_subworker` xfail 제거 완료.

## 다음 액션

PR 5 — Opsidian Conversation tab (frontend). React/TS 변경.
