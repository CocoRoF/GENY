# PR E4 — feat(api): LLM backend health + Claude Code login status

| 항목 | 값 |
|---|---|
| Repo | `Geny` |
| Branch | `feat/llm-backend/e4-health-routes` (deleted) |
| Base SHA | `f87e8c2` |
| PR # | [#777](https://github.com/CocoRoF/Geny/pull/777) |
| Merge SHA | `ee464eb` |
| Status | **merged** |

## 신규 라우트 (require_auth)

- `GET /api/llm-backends/health` — 6 provider parallel probe.
- `POST /api/llm-backends/cli/claude-code/recheck` — `claude auth login` 후 호출.
- `POST /api/llm-backends/cli/copilot/recheck`.
- `GET /api/llm-backends/subagents` — registered sub-agent types.

## Claude Code 인증 상태 감지

- `auth_method="api_key"` — ANTHROPIC_API_KEY 발견 시.
- `auth_method="subscription"` — `claude auth status` / `auth whoami` / `--auth-status` 중 하나라도 success.
- `auth_method=None`, `auth_ok=False` — 비인증; `install_help`로 양쪽 경로 안내.

## Copilot CLI

- `gh auth status` + `gh extension list | grep github/gh-copilot` 둘 다 성공해야 ready.
