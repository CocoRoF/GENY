# PR B1 — feat(llm_client): translators/_cli.py — Claude Code argv + stream-json

## 메타데이터

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/b1-translators-claude-code` (deleted after merge) |
| Base SHA | `6fd3f02` |
| PR # | [#194](https://github.com/CocoRoF/geny-executor/pull/194) |
| Merge SHA | `9fda0ac` |
| Status | **merged** |
| Date | 2026-05-17 |

## 변경 파일

```
A src/geny_executor/llm_client/translators/_cli.py
M src/geny_executor/llm_client/translators/__init__.py
A tests/llm_client/unit/test_translators_cli_claude_code.py
```

## 변경 요약 (헬퍼 6종)

| Helper | 입력 | 출력 |
|---|---|---|
| `claude_code_argv(request, **opts)` | `APIRequest` + 7 옵션 | `list[str]` argv |
| `thinking_to_effort(thinking)` | thinking dict | `"low"|"medium"|"high"|"xhigh"|"max"|None` |
| `build_stream_json_stdin(messages)` | canonical messages | `bytes` (NDJSON envelopes) |
| `stream_json_line_to_canonical_event(line_obj)` | parsed JSON 객체 | canonical event dict or None |
| `parse_json_output_to_response(stdout, model)` | bytes | `APIResponse` |
| `assemble_response_from_stream_json(stream, model)` | async iter bytes | `APIResponse` |

## Argv 매핑

| Canonical | CLI flag |
|---|---|
| `model` | `--model <name>` |
| `system` (str or text-blocks) | `--system-prompt <text>` |
| `thinking.budget_tokens` | `--effort <bucket>` |
| `allow_tools` opt | `--allowedTools "<names>"` |
| `disallow_tools` opt | `--disallowedTools "<names>"` |
| `permission_mode` opt | `--permission-mode <mode>` |
| `max_budget_usd` opt | `--max-budget-usd <amount>` |
| `settings_path` opt | `--settings <path>` |
| `mcp_config` opt (dict or path) | `--mcp-config <json|path>` |
| `response_format` (json_schema) | `--json-schema <schema>` |
| `session_hint.session_id` (resume=false) | `--session-id <id>` |
| `session_hint.session_id` (resume=true) | `--resume <id>` |
| `stream=True` | `--input-format stream-json --output-format stream-json --include-partial-messages` |
| `stream=False` | `--output-format json` |
| `bare_mode=True` (default) | `--bare` |
| `temperature/top_p/top_k/stop_sequences/tool_choice` | DROP (CLI 미지원) |

## Stream-json 라인 매핑

| line type | canonical event |
|---|---|
| `system` | (consume; populate session_id, model) |
| `user` | (skip; echo of input) |
| `assistant` text_delta | `{"type": "text_delta", "text": ...}` |
| `assistant` thinking_delta | `{"type": "thinking_delta", "text": ...}` |
| `assistant` input_json_delta | `{"type": "input_json_delta", "delta": ...}` |
| `assistant` content_block tool_use | `{"type": "tool_use", "id": ..., "name": ..., "input": ...}` |
| `content_block_stop` | `{"type": "content_block_stop"}` (finalises tool input) |
| `message_stop` | `{"type": "message_complete"}` |
| `result` | `{"type": "result", "raw": ...}` (final usage + stop_reason) |
| `error` | `{"type": "error", "raw": ...}` (assembler raises RuntimeError) |
| malformed | `{"type": "cli_malformed", "raw": "..."}` |
| unknown | `{"type": "cli_unknown", "raw": {...}}` |

## 검증

| 항목 | 결과 |
|---|---|
| `pytest tests/llm_client/unit/test_translators_cli_claude_code.py` | ✅ 47 신규 pass |
| `pytest tests/` 전체 | ✅ 3138 passed, 8 skipped, 0 failed |
| 기존 4 provider 동작 변경 없음 | ✅ pure helpers, no client wiring yet |

## Rollback

```bash
cd /home/geny-workspace/geny-executor
git revert 9fda0ac --no-edit
git push origin main
```

## 다음 PR (B2)

- `ClaudeCodeCLIClient` 본체 (`claude_code.py`)
- `tests/_fixtures/fake_claude.py` — fake CLI
- `ClientRegistry`에 `claude_code_cli` 등록
- 단위 테스트 (init / binary resolve / capability flags / fake CLI 통합)
