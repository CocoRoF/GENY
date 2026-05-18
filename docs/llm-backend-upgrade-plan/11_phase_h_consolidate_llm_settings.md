# Phase H — Consolidate LLM Backend Settings

> User mandate (2026-05-18): "LLM Backend 설정의 경우는 전체설정에서 따로
> 설정할 수 없게 만들고 LLM Backend 카테고리에서 Special method를 통해서
> 제대로 처리할 수 있도록 만들어야만 해. 아주 다시 제대로 검토하고
> 제대로 만들자."

## Problem

After Phase F2 + Phase G we ended up with **two coexisting paths** that
edit the same data:

1. **General "전체설정" auto-form modal** (BaseConfig → SettingsTab):
   - `cli_backend_claude_code` — 13 fields, "편집: Claude Code (CLI)"
   - `cli_backend_copilot` — 6 fields, "편집: GitHub Copilot (CLI)"
   - `api` — includes `anthropic_api_key` / `openai_api_key` /
     `google_api_key` / `base_url` mixed with model defaults

2. **LLM Backends panel modals** (Phase G):
   - `ClaudeCodeAuthModal` — host_mount / in_modal_login / setup_token / api_key
   - `CopilotAuthModal` — gh auth login SSE flow
   - `ApiBackendModal` — paste-and-save for the 4 API providers

These two flows save through **different methods** for the same fields,
which is the structural problem the user is calling out.

## Goal

A **single canonical editing surface** per LLM backend: the LLM Backends
category's modals. The general "전체설정" list must not surface LLM
backend credentials / CLI knobs at all.

## Design — Approach: hide-from-list + APIConfig split

### 1. `is_user_visible()` opt-out on BaseConfig

Add a classmethod that defaults to `True`. The `list_configs`
controller filters out configs whose `is_user_visible()` returns
`False`. **`get`, `update`, `delete` endpoints stay open** — the LLM
Backends modals still call `configApi.update(...)` to persist values.

This is purely a list-time filter so the auto-generated form modal in
`SettingsTab.tsx` never shows them. No frontend changes required for
the filter itself (controller drops them, frontend just renders
whatever it gets).

### 2. Hide CLI backend configs

Mark both `CLIBackendClaudeCodeConfig` and `CLIBackendCopilotConfig`
as `is_user_visible() = False`. They retain full schema/get/update
support so the modals continue to function.

### 3. Split `APIConfig` → new `LLMCredentialsConfig`, drop `provider`

`APIConfig` currently mixes credential fields (LLM-backend-only),
model-default fields (legitimate general settings), and a stale
global `provider` selector. The provider selection is per-Environment
at the manifest level — Geny does not have a "global current
provider." Split:

| New config | Visibility | Fields |
|---|---|---|
| `LLMCredentialsConfig` (`llm_credentials`) | **hidden** | `anthropic_api_key`, `openai_api_key`, `google_api_key`, `base_url` |
| `APIConfig` (`api`, trimmed) | visible | `anthropic_model`, `vtuber_default_model`, `memory_model`, `use_legacy_reflect`, `max_thinking_tokens`, `skip_permissions`, `app_port` |

The global `provider` field is **removed entirely** — each Environment
picks its provider via Stage 6 / agent factory, and the few callers
that still read `api.provider` (memory_llm) hardcode the Anthropic
client since `memory_model` is always a Claude model in defaults.

`APIConfig.display_name` becomes "LLM Defaults" (KR: "LLM 기본 설정").
The credentials live in a hidden config that only `ApiBackendModal`
and the executor's `CredentialBundleBuilder` ever touch.

### 4. Wire updates through new credentials config

- `ApiBackendModal` → save to `llm_credentials.{anthropic_api_key|openai_api_key|google_api_key|base_url}` (currently saves to `api.*`).
- `credentials.py` → `CredentialBundleBuilder` reads from
  `LLMCredentialsConfig` instead of `APIConfig` for keys + base_url.
- `memory_llm.py:74` → reads `cm.load_config(LLMCredentialsConfig).anthropic_api_key`.
- `agent_session.py:1772` → same.

### 5. `ClaudeCodeAuthModal` api_key/setup_token writes

The modal currently saves the user's API key / setup token to
`cli_backend_claude_code.api_key` (the per-CLI override slot). That
field is **intentional** — the CLI backend treats it as a per-binary
override that wins over the global `anthropic_api_key`. It is still
edited via the LLM Backends modal, not the general list. The CLI
config is just hidden from the auto-form list. No change here.

## Migration note

User said no migration, no back-compat. Existing `api.json` files that
hold credential fields will lose those values after the split (the
trimmed `APIConfig.from_dict` filters unknown fields). Users will
re-enter API keys via the LLM Backends modal on first use, which is
exactly the new canonical path. Prod hasn't been used yet for API
provider work — the only auth state in prod is the Claude Code OAuth
under the named volume, which is untouched.

## File-by-file changes

**Backend**

- `backend/service/config/base.py`
  - Add `@classmethod def is_user_visible(cls) -> bool: return True`
- `backend/controller/config_controller.py`
  - In `list_configs`, drop configs whose class returns `is_user_visible() == False`
- `backend/service/config/sub_config/general/llm_credentials_config.py` (new)
  - `LLMCredentialsConfig` with the 4 credential fields, `is_user_visible() = False`
- `backend/service/config/sub_config/general/api_config.py`
  - Remove `anthropic_api_key`, `openai_api_key`, `google_api_key`, `base_url` fields
  - Update display name + description
- `backend/service/config/sub_config/general/cli_backends_config.py`
  - Both classes override `is_user_visible() = False`
- `backend/service/config/__init__.py`
  - Register `LLMCredentialsConfig`
- `backend/service/executor/credentials.py`
  - Load `LLMCredentialsConfig` for keys + base_url
- `backend/service/memory/memory_llm.py`
  - Read `anthropic_api_key` from `LLMCredentialsConfig`. Hardcode Anthropic client (drop `api_cfg.provider` / `api_cfg.base_url` reads — global provider field is gone)
- `backend/service/executor/agent_session.py:1772`
  - Read api_key from `LLMCredentialsConfig`
- `backend/controller/llm_backends_controller.py:37`
  - Drop unused `APIConfig` import

**Frontend**

- `frontend/src/components/tabs/ApiBackendModal.tsx`
  - `configApi.get('api')` → `configApi.get('llm_credentials')`
  - `configApi.update('api', ...)` → `configApi.update('llm_credentials', ...)`

No changes to `SettingsTab.tsx`, `LLMBackendsPanel.tsx`,
`ClaudeCodeAuthModal.tsx`, `CopilotAuthModal.tsx`.

## Verification checklist

1. `/api/config` no longer returns `cli_backend_claude_code`,
   `cli_backend_copilot`, or `llm_credentials` in the `configs` list.
2. `/api/config/cli_backend_claude_code` (singular GET) still works
   so the Claude Code modal can read the current setup_token value.
3. `/api/config/llm_credentials` GET + PUT work so `ApiBackendModal`
   can paste a key.
4. SettingsTab `전체` view shows only non-LLM-backend configs.
5. LLM Backends panel still functions identically — same modals,
   same SSE auth flow, same health probes.
6. End-to-end: paste OpenAI key in LLM Backends → OpenAI card flips
   to "Ready" → check `~/.geny-agent/configs/llm_credentials.json`
   has the key, `api.json` does not.

## Out of scope

- Per-field hide-from-list metadata. Not needed since APIConfig
  splits cleanly along the credential vs default axis.
- Memory_llm provider switching. Currently hardcoded to Anthropic
  because `memory_model` defaults to Claude Haiku. If a future
  Environment needs non-Anthropic memory, the manifest will carry
  it — not a global setting.
