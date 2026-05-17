# Release — geny-executor 2.0.0 on PyPI

| 항목 | 값 |
|---|---|
| Package | `geny-executor` |
| Version | **2.0.0** |
| Upload time | 2026-05-17T13:40:12Z |
| Wheel | `geny_executor-2.0.0-py3-none-any.whl` (735,726 bytes) |
| sdist | `geny_executor-2.0.0.tar.gz` (806,971 bytes) |
| URL | https://pypi.org/project/geny-executor/2.0.0/ |
| Status | **published** |

## What v2.0.0 ships

- **6 LLM providers** in `ClientRegistry`: anthropic, openai, google, vllm, claude_code_cli, copilot_cli.
- **`CredentialBundle` + `ProviderCredentials`** — single channel for credentials.
- **Provider location unified** at `manifest.stages[6].config["provider"]`. Legacy `strategies["provider"]` rejected at strict load.
- **Multi-provider sub-agents** — `SubagentTypeDescriptor.provider`, `SubAgentBuildContext` passed to factories, mixed serial + parallel orchestrator with bounded semaphore.
- **Fork-mode skill multi-provider** via `make_credential_bundle_fork_runner`.
- 5 new `ErrorCategory` values (`CLI_NOT_FOUND`, `CLI_AUTH_FAILED`, `CLI_TIMEOUT`, `CLI_PROTOCOL_ERROR`, `CLI_PERMISSION_DENIED`) + `is_fatal` helper.
- 9 new `ClientCapabilities` flags (`supports_structured_output`, `supports_session_continuity`, `supports_mcp_passthrough`, `supports_budget_limit`, `supports_token_usage`, `supports_cost_usage`, `is_subprocess`, `requires_workspace`, `streaming_granularity`).
- `APIRequest.response_format` + `session_hint`; `TokenUsage.cost_usd` + `duration_ms`.
- `bridge.py` (`ProviderBackedClient`) removed.

## Test posture at release

- 3235 tests passing (8 skipped), 0 failed.
- Conformance harness covers 6 providers (mocked).

## How Geny pins this

Phase E1 starts by bumping `Geny`'s dependency on `geny-executor` to `>=2.0.0,<3.0.0` and switching the wiring path from the legacy `api_key=` channel to `CredentialBundle`.
