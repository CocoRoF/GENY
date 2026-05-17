# PR B3 — test(llm_client): claude_code_cli conformance suite + tighten binary resolution

## 메타데이터

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/b3-claude-code-conformance` (deleted after merge) |
| Base SHA | `c54be88` |
| PR # | [#196](https://github.com/CocoRoF/geny-executor/pull/196) |
| Merge SHA | `17b8468` |
| Status | **merged** |
| Date | 2026-05-17 |

## 변경 파일

```
M src/geny_executor/llm_client/claude_code.py
A tests/llm_client/conformance/test_claude_code_cli.py
```

## 변경 요약

- Conformance harness에 `TestClaudeCodeCLIConformance` 추가 — 17 케이스.
- Binary resolution 정책 강화: 명시적 `binary_path` 인자 우선. 없을 때만 `CLAUDE_CODE_BINARY` env / `shutil.which('claude')` fallback.
- `make_client(scenario=..., text=...)` factory에 env_extras 통합.

## 케이스 카탈로그

| 카테고리 | 케이스 |
|---|---|
| Static | provider name, capability shape, drops, subprocess flags |
| Capability flags | session_continuity, mcp_passthrough, thinking, budget_limit |
| End-to-end | basic_text, streaming_yield_deltas, token+cost usage, tool_use round trip, thinking blocks |
| Error mapping | auth, permission, not_found, timeout |

## 검증

| 항목 | 결과 |
|---|---|
| `pytest tests/llm_client/conformance/` | ✅ 42 pass (4 prev + claude_code_cli 17) |
| `pytest tests/` 전체 | ✅ 3172 passed, 8 skipped, 0 failed |

## Phase B 완료

A + B (총 6 PR) 완료. Claude Code CLI가 ClientRegistry에 production-grade로 등록되어 Geny가 곧 소비 가능. 다음은 Phase C — Copilot CLI.

## 다음 PR (C1)

- `translators/_cli.py`에 copilot 헬퍼 + `copilot.py` 본체 + registry 등록
