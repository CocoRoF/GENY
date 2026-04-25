# 00. Plan 실행 컨벤션 — branch / commit / PR / test / 호환성

본 컨벤션은 본 plan 의 모든 PR 에 적용. cycle / 묶음 별로 별도 규칙 만들지 않음.

---

## 1. Branch 명명

```
<type>/<short-slug>
```

| Type | 의미 | 예 |
|---|---|---|
| `feat`  | 새 capability | `feat/agent-tool` |
| `fix`   | 버그 fix | `fix/task-runner-cancel-race` |
| `refactor` | 동작 동일, 구조 변경 | `refactor/hook-runner-split` |
| `test`  | test only | `test/cron-store-roundtrip` |
| `docs`  | docs only | `docs/api-task-create` |
| `chore` | 의존성 / 빌드 / CI | `chore/bump-croniter` |

slug 는 4 단어 이내, kebab-case.

---

## 2. Commit 메시지

```
<type>(<scope>): <subject>

<body — optional, why-focused, not what>

Co-Authored-By: <author>
```

| Scope (executor) | 의미 |
|---|---|
| `tools`     | tools/ 하위 |
| `stages`    | stages/ 하위 |
| `runtime`   | runtime/ 하위 |
| `slash`     | slash_commands/ 하위 |
| `cron`      | cron/ 하위 |
| `settings`  | settings/ 하위 |
| `hooks`     | hooks/ 하위 |
| `mcp`       | mcp/ 하위 |
| `skills`    | skills/ 하위 |
| `permission`| permission/ 하위 |

| Scope (Geny) | 의미 |
|---|---|
| `controller` | controller/ 하위 (FastAPI) |
| `service`    | service/ 하위 (도메인 로직) |
| `frontend`   | frontend/src 하위 |
| `tools`      | Geny 자체 tool |
| `tests`      | tests only |
| `infra`      | docker / nginx / lifespan |

**Subject 규칙:**
- imperative ("add" not "added")
- 50 chars 이내
- 끝 마침표 X
- 영어 lowercase (한글 OK 단 일관성 유지)

**Body 예:**
```
feat(slash): add SlashCommandRegistry built-in core

Why: claude-code 의 ~100 slash command 패턴을 framework 차원에서
재현하기 위함. Geny 같은 서비스가 register API 만으로 도메인
명령을 추가할 수 있어야 함.

Scope:
- registry / parser / discovery hierarchy
- types: SlashCommand / ParsedSlash
- 12 introspection 명령 (cost / clear / status / ...) 은 별도 PR

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## 3. PR title / description

### Title

```
<type>(<scope>): <subject>          # commit subject 와 동일
```

70 chars 이내. PR ID (`PR-A.1.1`) 는 description 에.

### Description template

```markdown
## PR ID
PR-A.1.1

## Cycle / 묶음
Cycle A / P0.1 Task lifecycle (executor 측)

## Summary
- 1-3 bullet, why-focused

## Layer
EXEC-CORE

## Depends on
- (none)  또는  PR-A.1.1, PR-A.1.2

## Consumed by (다른 repo)
Geny PR-A.5.1 (TasksTab.tsx)  ← cross-repo 추적

## Files added
- `geny_executor/tools/built_in/agent_tool.py` (~120 lines)

## Files modified
- `geny_executor/tools/built_in/__init__.py` — BUILT_IN_TOOL_CLASSES 에 AgentTool 추가

## Tests added
- `tests/tools/built_in/test_agent_tool.py`
  - test_spawns_subagent_with_descriptor
  - test_returns_error_when_orchestrator_inactive
  - test_propagates_subagent_error
  - test_validates_subagent_type

## Acceptance criteria
- [ ] BUILT_IN_TOOL_CLASSES 에 AgentTool 등록
- [ ] manifest 에서 호출 가능
- [ ] 4 unit test 통과
- [ ] mypy / ruff clean
- [ ] CHANGELOG.md 의 1.1.0 unreleased 섹션에 1줄

## Risk / mitigation
| Risk | Mitigation |
|---|---|
| nested execution 무한 재귀 | ctx.depth ≥ 3 시 ToolResult.error |

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## 4. Test 컨벤션

### 위치

- executor: `tests/<module>/test_<filename>.py`
- Geny: `backend/tests/<module>/test_<filename>.py`
- 새 file 의 1:1 대응 원칙. helper 는 `tests/<module>/_helpers.py`.

### 명명

- `test_<verb>_<condition>_<expected>` 형식 권장.
  - 예: `test_register_returns_false_for_none_pipeline`
- 너무 짧으면 OK: `test_smoke`, `test_round_trip`.

### Skipping

- 외부 의존 (postgres / redis / network) 은 `pytest.importorskip` 또는 `pytest.skip` + 명확한 이유.

### Asyncio

- `pytest.mark.asyncio` 필수 (이미 conftest 에 wired 됐음, executor + Geny 양쪽).

### Coverage 목표

- **EXEC-CORE 새 파일**: 새 PR 기준 line coverage **≥ 90%**.
- **EXEC-INTERFACE ABC**: shape 만 테스트 (impl 마다 별도 테스트).
- **SERVICE controller**: endpoint shape + auth + 1 happy + 1 error path.
- **Frontend**: 본 cycle 에서 vitest infra 없음 → manual smoke 만 (Cycle C audit 에서 infra 추가 검토).

---

## 5. 호환성 규칙

### Executor minor bump

- `1.0.x → 1.1.0`: additive only. 기존 manifest / API 호환 유지.
- 기존 strategy / tool / event 이름 변경 금지.
- 새 ABC 추가 시 default impl 제공 (NotImplementedError raise 해도 됨, 단 기존 동작 보존).

### Geny adopt 시

- pyproject.toml 에 `geny-executor>=1.1.0,<1.2.0` 명시.
- `from geny_executor.tools.built_in import AgentTool` 같은 새 import 만 사용.
- 기존 manifest / strategy 이름 그대로.

### Settings.json migration (P1.3)

- migrator 가 기존 4 YAML 자동 감지 → settings.json 생성 + `.bak` 보존.
- 기존 YAML loader 는 6개월 deprecation window. warning log only, 동작 유지.

### Frontend breaking change

- 본 plan 에 frontend breaking change 없음. 새 tab 추가만.
- Vite build / docker compose 의 `--force-recreate frontend` 만 필요.

---

## 6. CI / 품질 gate

| Gate | Repo | 기준 |
|---|---|---|
| ruff (lint) | 양 repo | 0 warning |
| mypy (type) | executor (full strict) / Geny (gradual, 새 파일 strict) | 0 error |
| pytest | 양 repo | 0 failure, deferred xfail OK |
| coverage | executor | line ≥ 90% (새 파일), 전체 ≥ 80% |
| coverage | Geny | 새 파일 ≥ 80% |
| docs | 양 repo | docstring 누락 시 PR 차단 (public API only) |

CI 가 깨진 채로 머지 금지. `--no-verify` 절대 금지.

---

## 7. Cross-repo 운영

1. **Executor PR 모두 머지 + release 1.1.0** → tag push.
2. **Geny pyproject.toml** 에 `geny-executor==1.1.0` (또는 `>=1.1.0,<1.2.0`) 명시 — 별도 PR (`chore(deps): bump geny-executor 1.0.x → 1.1.0`).
3. **Geny 의 P0 PR 들** 시작.
4. Executor PR description 에 `Consumed by: Geny PR-A.5.x` 명시. Geny PR description 에 `Requires: geny-executor 1.1.0+`.
5. Cycle 종료 시 양 repo 의 release notes 작성 (executor CHANGELOG.md / Geny RELEASE.md).

---

## 8. 운영 환경 배포

본 plan 의 모든 PR 머지 후, 운영 배포는 별도 단계:

```
git pull
docker compose down
docker compose build --no-cache
docker compose up -d
docker compose up -d --force-recreate nginx   # 기존 cycle 1 의 nginx DNS 캐시 이슈
```

새 manifest / settings 는 **operator 가 의도적으로 enable 하기 전엔 동작 무변경** (additive 원칙).

---

## 9. Audit 시점

- 각 cycle 종료 후 1 audit cycle (cycle_C_audit.md).
- Audit 에서 발견된 결함은 새 PR (audit 발견 PR 은 R-prefix 또는 cycle C 에 포함).

---

## 다음 문서

- [`cycle_A_overview.md`](cycle_A_overview.md) — Cycle A 시작점
