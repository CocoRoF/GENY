# PR C1 — feat(llm_client): CopilotCLIClient + translators + registry

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/c1-copilot-client` (deleted) |
| Base SHA | `17b8468` |
| PR # | [#197](https://github.com/CocoRoF/geny-executor/pull/197) |
| Merge SHA | `f99d0d7` |
| Status | **merged** |

## 변경

- `CopilotCLIClient` 본체 — gh copilot 서브프로세스 실행
- `translators/_cli.py`에 `compose_copilot_prompt` / `copilot_argv` / `parse_plain_text_to_response` 추가
- `ClientRegistry`에 `copilot_cli` 등록 → 6 providers
- `tests/_fixtures/fake_gh.py` (7 시나리오)
- `tests/llm_client/unit/test_copilot.py` (22 케이스)

## Capability shape

- `supports_streaming=False`, `streaming_granularity="none"`
- `is_subprocess=True`, `requires_workspace=False`
- 거의 모든 advanced 기능 (thinking/tools/structured_output/session/mcp/budget/cost) `False`
- system prompt는 `## System` 섹션으로 prompt에 prepend

## 검증

- `pytest tests/llm_client/unit/test_copilot.py` — 22 pass
- `pytest tests/` 전체 — 3194 passed, 8 skipped, 0 failed

## Rollback

```bash
git revert f99d0d7 --no-edit && git push origin main
```
