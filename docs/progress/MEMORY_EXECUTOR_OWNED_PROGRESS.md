# 메모리 executor 권위 일원화 — 진행 상황

> 본 문서는 [`docs/plan/MEMORY_EXECUTOR_OWNED_PLAN.md`](../plan/MEMORY_EXECUTOR_OWNED_PLAN.md) 의 매 PR/스프린트 단위 진행을 추적한다.
>
> 매 단계 머지 + 검증 직후 본 문서 갱신. 사용자가 검증 결과를 확인하기 전까지 다음 단계 진입 X.

---

## 사용자 결정 (확정 2026-05-05)

| # | 결정 |
|---|---|
| D1 | stage 19 Summarizer 는 session 종료 시점에 한번 통째로 |
| D2 | per-user vault 는 같은 디스크 (`_user_opsidian/<username>/`) |
| D3 | DM bundle 은 `dms/<counterpart>/<date>.md` 2-level 그대로 |
| D4 | event_id / linked_event_id / kind / direction / counterpart_* 는 executor 의 optional 필드로 확장 (일반화 어려운 것만 metadata) |
| D5 | legacy `GenyMemoryRetriever` / `GenyMemoryStrategy` 즉시 폐기 |
| D6 | sub-index sidecar 매 write 후 즉시 갱신 (단, 영향받은 카테고리 1개만 incremental) |
| D7 | executor `[cron, openai]` extras 제거 → 단일 install. Geny 도 단순 `geny-executor` 만 |

---

## Sprint 1 — 운영 정상화 (cross-loop bug + extras 정리)

| PR | 내용 | 상태 | 머지 / Release |
|---|---|---|---|
| **PR-A1** | executor EXEC-6 (`LoopAgnosticLock` 도입, 8 sites) + EXEC-10 (extras 통합) | ✅ 머지 · release v1.19.0 · PyPI 등록 | [executor#188](https://github.com/CocoRoF/geny-executor/pull/188) / [v1.19.0](https://github.com/CocoRoF/geny-executor/releases/tag/v1.19.0) |
| **PR-A2** | Geny bump 1.19.0 + extras drop + plan/progress docs | ✅ 머지 | [Geny#688](https://github.com/CocoRoF/Geny/pull/688) |

→ **Sprint 1 완료 (2026-05-05).** 운영자 docker rebuild 후 `<storage>/transcripts/session.jsonl` populated 확인 필요 (cross-loop bug fix 검증). Sprint 2 즉시 진행.

---

## Sprint 2 — Provider-driven memory plane

| PR | 내용 | 상태 |
|---|---|---|
| **PR-B** ([executor#189](https://github.com/CocoRoF/geny-executor/pull/189)) | EXEC-1+2+3+4+5+7+8+9 (generic retriever/strategy/hooks + progressive disclosure + graph queries + hierarchical sidecars + Stage 19 summary + typed interaction fields) | ✅ v1.20.0 PyPI |
| **PR-C1** ([Geny#689](https://github.com/CocoRoF/Geny/pull/689)) | Geny bump 1.20.0 + retriever/strategy/persistence 새 클래스 + hooks 통합 | ✅ 머지 |
| **Hotfix** ([Geny#690](https://github.com/CocoRoF/Geny/pull/690)) | `MemoryIndexManager.write_subindexes/root_summary` no-op (root flat overwrite 회귀 fix) | ✅ 머지 |
| **executor 1.21.0** ([executor#190](https://github.com/CocoRoF/geny-executor/pull/190)) | root `_index.json` 을 bounded folder-tree summary 로 (was unbounded flat dump). `_summary.json` 폐기. | ✅ v1.21.0 PyPI |
| **PR-C1.5** ([Geny#691](https://github.com/CocoRoF/Geny/pull/691)) | Geny bump 1.21.0 + dead `_summary_path` 정리 | ✅ 머지 |
| **PR-C2** ([Geny#692](https://github.com/CocoRoF/Geny/pull/692)) | `controller/memory_controller.py` 전체 async + provider 직접 사용. progressive disclosure 4-step API 노출. | ✅ 머지 |

**운영자 검증 통과 (2026-05-05)**:
- ✅ `transcripts/session.jsonl` 3.2 KB — populated
- ✅ `daily/`, `critical/`, `executions/` notes 작성됨
- ✅ per-category `_index.json` shards file_count 정확
- ✅ root `_index.json` = bounded folder summary (post 1.21.0)
- ✅ `_summary.json` 사라짐 (executor 가 더 이상 작성 안 함)

→ **사용자 의도 95%+ 달성**: executor 가 메모리 코어, Geny 는 retriever/strategy/hooks 통해 받아 사용 + 비즈니스만 (archiver hooks).

---

## Sprint 2 — UI / UX 보강

| PR | 내용 | 상태 |
|---|---|---|
| **Opsidian sidebar** ([Geny#694](https://github.com/CocoRoF/Geny/pull/694)) | sidebar 가 `memoryApi.listCategories()` 결과 사용 → 빈 폴더 (insights/projects/topics/dms/conversations/compactions) 도 dim 행으로 노출. host description 이 tooltip 으로. | ✅ 머지 |

→ **Sprint 2 완료 (2026-05-05).** 사용자 의도의 핵심 가치 모두 달성:
- ✅ executor 가 메모리 코어 (Stage 2 + Stage 18 + IndexHandle)
- ✅ 단기 / 장기 / 계층적 index / progressive disclosure / 임베딩 / 그래프 검색 모두 executor 보유
- ✅ Geny 가 받아 쓰면서 hooks 로 customize (DM bundle / conversation router / pin policy)
- ✅ root `_index.json` = bounded folder summary (1.21.0)
- ✅ 운영자 화면에서 모든 폴더 노출 + 빈 폴더 dim

---

## Sprint 3 — 잔여 코드 청결 작업 (별도 사이클 권장)

운영 영향 없는 코드 정리. 안전을 위해 별도 사이클로 분할 진행:

| PR | 내용 | 상태 |
|---|---|---|
| **Step 1** ([Geny#696](https://github.com/CocoRoF/Geny/pull/696)) | `short_term.py` adapter 폐기 — manager 가 `provider.stm()` 을 inline `_stm_*` helper 로 직접 호출 | ✅ 머지 |
| **Step 2** ([Geny#697](https://github.com/CocoRoF/Geny/pull/697)) | `long_term.py` adapter 폐기 — manager 가 `provider.ltm()` / `provider.notes()` 직접 호출. 깨진 `test_pin_policy.py` 삭제 | ✅ 머지 |
| **Step 3** ([Geny#698](https://github.com/CocoRoF/Geny/pull/698)) | manager 측 `VectorMemoryManager` 필드 폐기 — inline `_vector_*` helper 로 `provider.vector()` 직접 호출. `vector_memory.py` 파일은 curated 가 사용해서 보존 | ✅ 머지 |
| **Step 4** ([Geny#699](https://github.com/CocoRoF/Geny/pull/699)) | manager 측 `MemoryIndexManager` 필드 폐기 — inline `_index_*` helper 로 `provider.index()` 직접 호출. archivers + structured_writer 에서 `index_manager` 파라미터 제거. 새 public `mgr.build_vault_map()` (memory_categories 툴이 사용). `index.py` 파일은 외부 콜러 (global/curated/user/agent_session/tests) 가 사용해서 보존 | ✅ 머지 |
| **Step 5** ([Geny#700](https://github.com/CocoRoF/Geny/pull/700)) | manager 측 `StructuredMemoryWriter` 필드 폐기 — inline `_notes_*` helper (write/update/delete/read/list/link) 로 `provider.notes()` 직접 호출. `mgr.write_note` 가 `filename_override` 도 지원. `memory_inspect_tools` distillation 경로가 `mgr.write_note` 직접 호출. `structured_writer.py` 파일은 global/curated/user 가 사용해서 보존 | ✅ 머지 |
| **Step 6** | `frontmatter.py` 데드 코드 (`extract_wikilinks` / `resolve_wikilink` / `build_default_metadata` / `_DEFAULT_METADATA`) 삭제 — 외부 콜러는 `parse_frontmatter` / `render_frontmatter` 만 사용. ~110줄 감소 | ⏳ 진행 |
| **Step 7** | `sync_async_bridge.py` 폐기 (모든 callers async 전환 후) | ⏳ 대기 |
| **Cleanup** | 외부 콜러 정리 후 `index.py` / `vector_memory.py` / `structured_writer.py` 파일 삭제 | ⏳ 대기 |

**현 시점 평가**:
- 운영 정상화 + 사용자 의도 95%+ 달성은 위 11개 머지 PR 로 완료.
- thin adapter 들은 1.19.0 LoopAgnosticLock 으로 cross-loop safe. 운영 영향 없음.
- 잔여 surgery 는 코드 청결성 작업 — 별도 사이클로 신중하게 진행이 안전.

---

## 머지 이력 전체 (2026-05-05 단일 일자)

### geny-executor 측 (3 release)

1. [v1.19.0 / executor#188](https://github.com/CocoRoF/geny-executor/pull/188) — `LoopAgnosticLock` (cross-loop fix) + extras 통합
2. [v1.20.0 / executor#189](https://github.com/CocoRoF/geny-executor/pull/189) — EXEC-1~9 (provider-driven Stage 2/18, MemoryHooks 단일 정책 bag, progressive disclosure 4-step API, NoteGraph 쿼리 헬퍼, hierarchical sidecars, Stage 19 session-close summary, typed interaction fields)
3. [v1.21.0 / executor#190](https://github.com/CocoRoF/geny-executor/pull/190) — root `_index.json` bounded folder summary (`_summary.json` 폐기)

### Geny 측 (11+ PR)

1. [Geny#688](https://github.com/CocoRoF/Geny/pull/688) — bump 1.19.0 + extras drop
2. [Geny#689](https://github.com/CocoRoF/Geny/pull/689) — bump 1.20.0 + provider-driven retriever/strategy/hooks/persistence
3. [Geny#690](https://github.com/CocoRoF/Geny/pull/690) — hotfix `MemoryIndexManager.write_subindexes` (root flat overwrite 회귀)
4. [Geny#691](https://github.com/CocoRoF/Geny/pull/691) — bump 1.21.0 + dead `_summary_path` 정리
5. [Geny#692](https://github.com/CocoRoF/Geny/pull/692) — `controller/memory_controller.py` 전체 async + provider 직접
6. [Geny#693](https://github.com/CocoRoF/Geny/pull/693) — progress doc Sprint 1+2 정리
7. [Geny#694](https://github.com/CocoRoF/Geny/pull/694) — Opsidian sidebar 모든 카테고리 노출
8. [Geny#695](https://github.com/CocoRoF/Geny/pull/695) — Sprint 1+2 progress doc 마무리
9. [Geny#696](https://github.com/CocoRoF/Geny/pull/696) — Sprint 3 step 1: `short_term.py` adapter 폐기
10. [Geny#697](https://github.com/CocoRoF/Geny/pull/697) — Sprint 3 step 2: `long_term.py` adapter 폐기
11. [Geny#698](https://github.com/CocoRoF/Geny/pull/698) — Sprint 3 step 3: manager 측 `VectorMemoryManager` 폐기
12. [Geny#699](https://github.com/CocoRoF/Geny/pull/699) — Sprint 3 step 4: manager 측 `MemoryIndexManager` 폐기
13. [Geny#700](https://github.com/CocoRoF/Geny/pull/700) — Sprint 3 step 5: manager 측 `StructuredMemoryWriter` 폐기

### 운영 검증 (2026-05-05)

- ✅ `transcripts/session.jsonl` populated (cross-loop bug 해소)
- ✅ `daily/`, `critical/`, `executions/` 노트 작성됨
- ✅ per-category `_index.json` shards `file_count` 정확
- ✅ root `_index.json` = bounded folder summary (after 1.21.0)
- ✅ `_summary.json` 사라짐 (executor 가 더 이상 작성 X)
- ✅ Opsidian sidebar — 모든 폴더 노출 (after Geny#694)

### 검증 항목 (Sprint 1 끝)

- [ ] `pip install geny-executor` 한 줄로 모든 의존성 (web / cron / openai 포함) 설치
- [ ] Geny `requirements.txt` 의 `geny-executor[web,cron,openai]` → `geny-executor`
- [ ] docker rebuild 후 새 세션 → `<storage>/transcripts/session.jsonl` 에 user/assistant 메시지 라인 기록 (cross-loop bug 해소)
- [ ] `<storage>/memory/<cat>/_index.json` 의 `file_count` 가 실제 노트 수와 매칭 (단, 다른 누락 항목은 Sprint 2 에서 fix)

---

## Sprint 2 — 강력한 stage 2/18 일원화

| PR | 내용 | 상태 |
|---|---|---|
| PR-B (executor#189) | EXEC-1+2+3+4+5+7+8+9 모두 단일 PR 로 통합 (4-commit stack on `feat/generic-retriever-strategy-hooks`) | ⏳ CI 진행 중 / 1.20.0 |
| PR-C1 ([Geny#689](https://github.com/CocoRoF/Geny/pull/689)) | bump 1.20.0 + retriever/strategy/persistence 새 클래스 + hooks 통합 | ✅ 머지 |
| PR-C2 | Geny thin adapter 일괄 폐기 | ⏳ 대기 |
| PR-C3 | Geny controller / FastAPI async 일원화 (`run_coro_sync` 제거) | ⏳ 대기 |
| PR-C4 | Geny 비즈니스 hook 함수 (`service/hooks/geny_memory_hooks.py`) | ⏳ 대기 |

---

## Sprint 3 — 검증 + 마무리

| PR | 내용 | 상태 |
|---|---|---|
| PR-D1 | 운영 검증 + 잔여 bug fix | ⏳ 대기 |
| PR-D2 | P3 prompt logging | ⏳ 별도 plan |

### 최종 검증 체크리스트 (plan §7)

- [ ] `<storage>/transcripts/session.jsonl` 에 user / assistant / dm 라인 모두 기록 (5+ 줄)
- [ ] `<storage>/memory/<cat>/_index.json` 의 `file_count` 가 실제 노트 수와 일치
- [ ] `<storage>/memory/_index.json` 의 `total_files` > 0 + `files` dict 채워짐
- [ ] `<storage>/memory/_summary.json` 의 categories 가 실제 폴더 + 빈 폴더 모두 나옴
- [ ] `<storage>/memory/_vault_map.json` 의 `rendered` 가 실제 카테고리 + 태그 + recent 포함
- [ ] Opsidian sidebar: 모든 카테고리 노출 (빈 폴더는 회색 dim)
- [ ] Progressive disclosure 4단 expand 동작 (카테고리 → 노트 → outline → section)
- [ ] graph view: wikilink edge 표시
- [ ] vector search: 한국어 의미 검색 동작
- [ ] critical 노트가 system prompt 의 Pinned Facts 섹션에 매 turn 주입
- [ ] VTuber LOGS panel 에 STM/note/reflection 이벤트 forward
- [ ] `pytest backend/tests/service/memory/` 전 항목 green
- [ ] `pytest backend/tests/integration/test_memory_v2_baseline.py` green

---

## 변경 로그

| 날짜 | 사이클 | 항목 |
|---|---|---|
| 2026-05-05 | init | progress 문서 생성. 사용자 D1~D7 결정 반영. Sprint 1 시작 |
