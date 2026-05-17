# PR B2 — feat(llm_client): ClaudeCodeCLIClient + registry + fake binary

## 메타데이터

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/b2-claude-code-client` (deleted after merge) |
| Base SHA | `9fda0ac` |
| PR # | [#195](https://github.com/CocoRoF/geny-executor/pull/195) |
| Merge SHA | `c54be88` |
| Status | **merged** |
| Date | 2026-05-17 |

## 변경 파일

```
A src/geny_executor/llm_client/claude_code.py
M src/geny_executor/llm_client/registry.py
M src/geny_executor/llm_client/__init__.py
M src/geny_executor/core/pipeline.py
A tests/_fixtures/fake_claude.py
A tests/llm_client/unit/test_claude_code.py
```

## 변경 요약

- `ClaudeCodeCLIClient` 본체 — subprocess-backed `BaseClient`. `_send`는 oneshot vs stream 분기 후 translators._cli 헬퍼 사용. `create_message_stream`은 token-by-token 이벤트 emit.
- Registry에 `claude_code_cli` 팩토리 등록 → `ClientRegistry.available()` 5개 반환.
- `_creds_to_client_kwargs` (`core/pipeline.py`): `claude_code_cli` + `copilot_cli` 분기 추가. extras dict의 `workspace_root` → `workspace_dir` 자동 remap.
- `tests/_fixtures/fake_claude.py` — 8 시나리오 fake binary.
- 17개 단위 테스트 (capability / registry / binary resolution / oneshot / streaming / error 매핑 / argv / env / CredentialBundle 매핑).

## Error 카테고리 매핑

| stderr 패턴 | category |
|---|---|
| "not authenticated" / "unauthorized" / "auth fail*" | `CLI_AUTH_FAILED` |
| "permission" + ("denied"/"deny"/"blocked") | `CLI_PERMISSION_DENIED` |
| 그 외 non-zero exit | `CLI_PROTOCOL_ERROR` |
| 타임아웃 | `CLI_TIMEOUT` |
| binary 부재 | `CLI_NOT_FOUND` |

## 검증

| 항목 | 결과 |
|---|---|
| `pytest tests/llm_client/unit/test_claude_code.py` | ✅ 17 pass |
| `pytest tests/` 전체 | ✅ 3155 passed, 8 skipped, 0 failed |
| `ClientRegistry.available()` length 4→5 | ✅ |

## Rollback

```bash
cd /home/geny-workspace/geny-executor
git revert c54be88 --no-edit
git push origin main
```

## 다음 PR (B3)

- `tests/llm_client/conformance/test_claude_code_cli.py` — conformance harness extension
