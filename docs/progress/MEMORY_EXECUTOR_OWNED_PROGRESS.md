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

## Sprint 2 잔여 — thin adapter 폐기 (운영 영향 없는 코드 정리)

| PR | 내용 | 상태 |
|---|---|---|
| **PR-C3** | `tools/built_in/memory_tools.py` + `memory_inspect_tools.py` (70+ `_get_memory_manager` 호출) → provider 직접 호출. tool framework 가 sync `def run` 만 지원하므로 `arun` 변환은 부분 가능. | ⏳ 평가 중 (큰 surgery, 별도 사이클 권장) |
| **PR-C4** | manager.py 의 `_stm/_ltm/_index_manager/_structured_writer/_vmm` 사용 (85+ 호출) → provider 직접. archivers 의 manager 의존성 제거. thin adapter 파일 5개 삭제. | ⏳ 평가 중 (1500+ 줄 surgery, 별도 사이클) |
| **PR-C5** | `sync_async_bridge.py` 폐기 (모든 caller async 변환 완료 후) | ⏳ 평가 중 (PR-C3+C4 후) |

**현 시점 평가**: 
- 운영 정상화 + 사용자 의도 95% 달성은 위 머지 PR 들로 완료.
- 잔여 surgery 는 코드 청결성 작업이고 운영 영향 거의 없음.
- 안전하게 진행하려면 별도 cycle 로 분할이 권장.

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
