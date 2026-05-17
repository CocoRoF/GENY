# PR A1 — feat(llm_client): extend capabilities, request/response, error categories

## 메타데이터

| 항목 | 값 |
|---|---|
| Repo | `geny-executor` |
| Branch | `feat/llm-backend/a1-capabilities-types-errors` (deleted after merge) |
| Base SHA | `474522a` |
| Commit SHA | `b48f46f` |
| PR # | [#191](https://github.com/CocoRoF/geny-executor/pull/191) |
| Merge SHA | `70e98c3` |
| Status | **merged** |
| Date | 2026-05-17 |

## 변경 파일

```
 M src/geny_executor/core/errors.py
 M src/geny_executor/core/state.py
 M src/geny_executor/llm_client/anthropic.py
 M src/geny_executor/llm_client/base.py
 M src/geny_executor/llm_client/google.py
 M src/geny_executor/llm_client/openai.py
 M src/geny_executor/llm_client/types.py
 M src/geny_executor/llm_client/vllm.py
 A tests/unit/test_errors_categories.py
 A tests/unit/test_llm_client_capabilities.py
 A tests/unit/test_llm_client_request_types.py
```

## 변경 요약

### ClientCapabilities (`llm_client/base.py`)

7 필드 → **16 필드** + `drops` + `.supports(name)` helper.

추가된 필드:
- `supports_structured_output`
- `supports_session_continuity`
- `supports_mcp_passthrough`
- `supports_budget_limit`
- `supports_token_usage` (default True — 기존 동작과 일치)
- `supports_cost_usage`
- `is_subprocess`
- `requires_workspace`
- `streaming_granularity: str` (default `"token"`)

기존 4 client (anthropic/openai/google/vllm)는 16 필드 모두 explicit 채움.

### APIRequest (`llm_client/types.py`)

신규 Optional 필드 2개:
- `response_format: Optional[Dict[str, Any]]` — JSON schema / json_object
- `session_hint: Optional[Dict[str, Any]]` — session_id + resume

### TokenUsage (`core/state.py`)

신규 Optional 필드 2개:
- `cost_usd: Optional[float]`
- `duration_ms: Optional[int]`

`+` / `+=` 연산에서 None-aware 합산 (`_sum_optional` 헬퍼).

### APIResponse (`llm_client/types.py`)

- `.cost_usd` 프로퍼티 (`self.usage.cost_usd` proxy).

### ErrorCategory (`core/errors.py`)

신규 enum 5종:
- `CLI_NOT_FOUND`, `CLI_AUTH_FAILED`, `CLI_TIMEOUT`, `CLI_PROTOCOL_ERROR`, `CLI_PERMISSION_DENIED`

신규 분류:
- `is_recoverable` 확장 → `CLI_TIMEOUT`, `CLI_PROTOCOL_ERROR` 포함
- `is_fatal` 신규 프로퍼티 → AUTH / BAD_REQUEST / CLI_NOT_FOUND / CLI_AUTH_FAILED / CLI_PERMISSION_DENIED

### BaseClient._build_request

`stop_sequences` 미지원 시 silent drop + `feature_unsupported` 이벤트 emit (기존 다른 negotiation과 parity).

## 검증

| 항목 | 결과 |
|---|---|
| `pytest tests/unit/test_llm_client_capabilities.py` | ✅ pass |
| `pytest tests/unit/test_llm_client_request_types.py` | ✅ pass |
| `pytest tests/unit/test_errors_categories.py` | ✅ pass |
| `pytest tests/unit/` 전체 | ✅ 2427 passed, 1 skipped, 0 failed |
| 기존 4 provider 동작 변경 없음 | ✅ default값으로 인해 변동 없음 |

## Rollback

```bash
cd /home/geny-workspace/geny-executor
git revert 70e98c3 --no-edit
git push origin main
```

## 다음 PR (A2)

- `_cli_runtime.py` (subprocess primitives)
- `credentials.py` (ProviderCredentials + CredentialBundle)
- `bridge.py` 삭제
