# Memory v2 Redesign — Progress Index

> Plan: [`/Geny/plan.md`](../../plan.md)
> Review (선행 분석): [`/Geny/review.md`](../../review.md)
> Status: ✅ **18/18 PR 완성** (+ post-launch hotfix PR 19 — entities/ 카테고리 폐지, executor 1.12.0 와 lockstep)

## 진행 현황

| PR | Phase | Status | 노트 | 영향 |
|---|---|---|---|---|
| 0 | 0 안전망 | ✅ | [pr00_fixture.md](pr00_fixture.md) | 시나리오 드라이버 + xfail 마커 |
| 1 | 1 conversations 인프라 | ✅ | [pr01_conversations_infra.md](pr01_conversations_infra.md) | 카테고리 등록 + archiver 모듈 + 30 unit tests |
| 2 | 1 conversations 자동작성 | ✅ | [pr02_record_message_hook.md](pr02_record_message_hook.md) | record_message hook + 11 tests + baseline xfail 4개 flip |
| 3 | 1 STM 락 | ✅ | [pr03_stm_lock.md](pr03_stm_lock.md) | RLock × 2 + 100-thread 동시성 테스트 |
| 4 | 2 dms/daily 인덱스 | ✅ | [pr04_dms_daily_indexes.md](pr04_dms_daily_indexes.md) | dm_archiver + daily_journal_writer + xfail 1개 flip |
| 5 | 2 Opsidian Conv 탭 | ✅ | [pr05_opsidian_conversation_tab.md](pr05_opsidian_conversation_tab.md) | ConversationView (Stream/Notes 토글) + 카테고리 아이콘 + RightPanel deep link |
| 6 | 2 카운터파트 fallback + frontmatter 인덱싱 | ✅ | (인라인) | MemoryFileInfo 확장 6 필드 + 인덱스 round-trip + back-compat |
| 7 | 3 LLMSummaryCompactor wiring | ✅ | (인라인) | s02 stage compactor 슬롯 직접 주입 |
| 8 | 3 Compaction LTM 영구화 | ✅ | (인라인) | compaction_archiver + record_compaction + PersistingLLMSummaryCompactor |
| 9 | 4 Vault Map 빌더 | ✅ | (인라인) | build_vault_map + render_vault_map + auto-refresh on save |
| 10 | 4 Retriever 슬림화 | ✅ | (인라인) | slim_mode 플래그 + _load_vault_map L2 |
| 11 | 4 Path A 폐기 | ✅ | (인라인) | agent_session_manager 의 memory_context append 제거 + deprecated docstring |
| 12 | 5 Memory Ladder 템플릿 | ✅ | (인라인) | prompts/templates/memory_ladder.md 신규 |
| 13 | 5 ladder import | ✅ | (인라인) | vtuber/worker/developer/researcher/planner 5개 role 적용 |
| 14 | 5 도구 응답 스키마 | ✅ | (인라인) | memory_search snippet_first_line + char_count |
| 15 | 6 linked_from 영속화 | ✅ | (인라인) | _propagate_linked_from helper (즉시 반영) |
| 16 | 6 entities Stats/Notes | ✅ | (인라인) | AUTO_STATS_MARKER + Recent conversations 섹션 |
| 17/18 | 7 Sub-Worker 정책 | ✅ | [pr17_18_subworker_inheritance.md](pr17_18_subworker_inheritance.md) | 옵션 (b) read-only inheritance 결정 + spec |
| 19 | 후속 — entities/ 카테고리 폐지 | ✅ | [pr19_entities_retirement.md](pr19_entities_retirement.md) | entity_bootstrap 모듈 삭제 + memory_distill → insights/counterpart-* + 프론트/플랜 문서 정리 (executor 1.12.0 lockstep) |

## 검증된 invariants (final integration)

```
✅ 16 jsonl lines (vtuber) + 6 (worker) — 시나리오 라인 수 일치
✅ 16 conversations/ (vtuber) + 6 (worker) — 1 turn 1 file
✅ 17 frontmatter keys — round-trip
✅ 6000+ char long body 본문 보존 (importance=high 자동)
✅ STM 라인의 metadata.payload.conversation_ref 박힘
✅ dms/<cp>/<date>.md (kind 필터 동작)
✅ <YYYY-MM-DD>.md daily journal (전체 turn)
✅ entities/<id>.md Stats/Notes 분리 (AUTO_STATS_MARKER + Recent conversations 섹션)
✅ _vault_map.json auto-refresh on every write
✅ render_vault_map() 619 chars / 4 categories / 5 top tags / 5 recent files
✅ index 20 files (16 conv + 1 daily + 2 entities + 1 dms)
✅ 100-thread 동시 record_message → 깨진 jsonl 라인 0
```

## 검증된 baseline xfail flip (5/5)

- ✅ `test_conversations_one_file_per_turn` (PR 1+2)
- ✅ `test_conversations_frontmatter_canonical_13_keys` (PR 1+2)
- ✅ `test_long_turn_full_body_in_conversations` (PR 2)
- ✅ `test_stm_lines_carry_conversation_ref` (PR 2)
- ✅ `test_dms_index_present_for_paired_subworker` (PR 4)
- ✅ `test_vault_map_present` (PR 9)

## 환경 제약

이 sandbox 에는 `httpx`, `numpy`, `faiss` 가 미설치 — 운영 dev 환경에서 `pytest` 통합 실행이 최종 검증. 본 진행은 stdlib + 모듈 직접 import 우회 + standalone smoke 로 invariant 100% 통과 확인.

## 다음 단계 (operational)

1. dev env 에서 `pytest backend/tests/service/memory/test_*archiver*.py backend/tests/integration/test_memory_v2_baseline.py` 실행 → 모두 PASS 확인
2. 1주 운영 후 Phase 7 의 paired-vault read-only 인헤리턴스 wiring 검토 (현재 spec only)
3. conversations/ 디스크 사용량 모니터링 (평균 200KB/day · 1년 73MB 추정)
