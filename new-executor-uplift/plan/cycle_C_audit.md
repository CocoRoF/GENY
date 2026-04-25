# Cycle C — Audit (Cycle A + B 의 검증 cycle)

**Cycle ID:** new-executor-uplift / 20260428_1
**PR 수:** ~7 (audit 발견 PR + carve-out)
**Prerequisite:** Cycle A + B 완료

본 cycle 은 `executor_uplift/20260425_3` 의 audit 패턴을 양 repo 동시 적용. 새로 ship 된 ~50 PR 의 모든 surface 가 (1) 의도된 행동 + (2) 테스트 + (3) 문서 의 3 항목을 통과하는지 검증. 운영 데이터에서 발견된 결함도 본 cycle 에 fix.

---

## Audit 범위

### 양 repo 의 새 surface (Cycle A + B 합계)

| 영역 | 검증 항목 | 책임 |
|---|---|---|
| **Executor 1.1.0 + 1.2.0** | 30 PR 의 전 file 의 docstring + test coverage | executor side audit |
| **Geny 1.1.x + 1.2.x adopt** | 20 PR 의 controller / service / frontend | Geny side audit |
| **운영 데이터** | 운영 후 발견된 결함 (log error / latency / memory leak) | Cross-cutting |
| **Documentation** | CHANGELOG.md / API doc (executor) + RELEASE.md (Geny) | 양 repo |

---

## Audit 절차 (cycle 마다 동일)

### Step 1 — 양 repo 의 새 file inventory

```bash
# Executor side
cd geny-executor
git log --since="3 weeks ago" --name-only --pretty=format: | sort -u | grep -v "^$" > /tmp/exec_new_files.txt

# Geny side
cd Geny
git log --since="3 weeks ago" --name-only --pretty=format: | sort -u | grep -v "^$" > /tmp/geny_new_files.txt
```

### Step 2 — 각 file 마다 audit checklist

| 항목 | OK 기준 |
|---|---|
| docstring | public 함수 / 클래스 모두 존재 |
| 1:1 test | `tests/<mirror>/test_<basename>.py` 존재 |
| coverage | 새 file 기준 line coverage ≥ 80% |
| public API | re-export 가 `__init__.py` 에 |
| typing | mypy strict pass |
| naming | conventions.md 의 naming 규칙 준수 |

### Step 3 — Audit doc 작성

`Geny/post_cycle_audit/cycle_AB_<date>.md` 에:
- Executor side gap (file → 누락 항목)
- Geny side gap
- 운영 결함 (log 분석 결과)
- 우선순위 분류 (R1 ~ Rn)

### Step 4 — Remediation PR (PR-C.x)

각 gap 마다 1 PR. 본 cycle 의 PR ID 는 `PR-C.1`, `PR-C.2`, ...

---

## 예상 audit gap 카테고리

### A. Test 누락

Cycle A + B 에서 우선 ship 된 file 중 1:1 test 가 없는 케이스. 예:
- `geny_executor/cron/runner.py` 의 일부 helper 함수
- `geny_executor/skills/fork_runner.py` 의 error path
- `Geny/service/notifications/install.py` 의 yaml→env precedence

→ PR-C.1 ~ C.x 로 test 추가.

### B. Docstring 누락

Cycle A + B 의 새 ABC / public class 에 docstring 부족.

→ PR-C.x 로 docstring 보강.

### C. Coverage 미달

새 file 중 line coverage < 80% 인 것.

→ PR-C.x 로 누락 path test 추가.

### D. 운영 결함 (배포 후 발견)

| 가능성 | 검증 방법 | Mitigation |
|---|---|---|
| Cron daemon 의 fire 누락 | log 에 cron_fired event count vs 예상 | runner.refresh 로직 보강 |
| Task output 의 stream lag | latency 측정 (long task 의 tail latency) | polling 주기 단축 또는 LISTEN/NOTIFY |
| Settings.json migration 실패 | log error count | fallback 보강 |
| In-process hook 의 unhandled exception | log warning count | fail-isolation 테스트 보강 |
| Slash command parser 의 edge case | 사용자 report | parser test case 추가 |
| MCP→skill auto loader 가 server timeout | log error | timeout 가드 |

각 결함 → 1 PR.

### E. Documentation gap

CHANGELOG.md 의 entry 누락 / 부정확한 description / migration guide 부재.

→ PR-C.x 로 보강.

---

## Cycle C 의 PR 추정

| 카테고리 | PR 수 (추정) |
|---|---|
| A. Test 누락 | 2~3 |
| B. Docstring 누락 | 1 (bundled 가능) |
| C. Coverage 미달 | 1~2 |
| D. 운영 결함 | 2~3 (운영 데이터에 따라) |
| E. Doc gap | 1 |
| **합계** | **7~10** |

---

## Acceptance criteria (Cycle C 종료)

- [ ] 양 repo 의 새 file 모두 1:1 test 존재
- [ ] 양 repo 의 새 file 모두 line coverage ≥ 80%
- [ ] 양 repo 의 새 public API 모두 docstring 존재
- [ ] 운영 데이터에서 발견된 모든 결함 fix
- [ ] CHANGELOG.md (executor) / RELEASE.md (Geny) 의 entry 누락 없음
- [ ] migration guide (settings.json YAML→json 변환 등) 작성 완료

---

## 다음 cycle (Cycle C 후)

본 plan 폴더의 모든 P0 + P1 를 흡수했음. 다음은 [`../03_priority_buckets.md`](../03_priority_buckets.md) 의 P2 (long-tail) 진입.

P2 의 큰 묶음:
- I.32 — tool 별 전용 web renderer (~10 PR, 큰 sprint)
- S.52 — Plugin system (~6-8 PR)
- R.51 — Coordinator mode (~4 PR)
- E.16 — WebSocket transport for MCP (~1 PR)
- E.24 — SDK-managed MCP (~2 PR)
- O.48 — WebFetch domain allowlist (~1 PR)
- 기타 polish

P2 는 본 plan 의 scope 밖. 별도 분석 + plan cycle 권장 (analysis 부터 다시 — 그동안 운영 데이터 누적 / claude-code-main 의 새 surface 도 새로 추가됐을 가능성).

---

## 본 plan 의 마무리

- `plan/` 폴더 14 파일 (index + conventions + 6 cycle_A + 7 cycle_B + 1 cycle_C)
- 총 PR 추정: 31 (Cycle A) + 19 (Cycle B) + ~7 (Cycle C) = **~57 PR**
- 양 repo 분포: executor ~30 + Geny ~27

본 plan 을 baseline 으로 cycle 시작 시:
1. [`index.md`](index.md) 의 cycle DAG 확인
2. [`00_conventions.md`](00_conventions.md) 한 번 통독
3. [`cycle_A_overview.md`](cycle_A_overview.md) 부터 묶음 순서로 진행
