# Providers

Geny supports five LLM backends. This page covers what each one needs, how to wire it up from the Settings UI, and the trade-offs.

| Provider          | Best for                                | Streaming | Native tools | MCP            | Key requirement                            |
| ----------------- | --------------------------------------- | --------- | ------------ | -------------- | ------------------------------------------ |
| anthropic         | Default for Claude users                | yes       | yes          | via bridge     | `ANTHROPIC_API_KEY`                        |
| openai            | OpenAI / Azure / OpenAI-compatible APIs | yes       | yes          | via bridge     | `OPENAI_API_KEY` (+ optional base URL)     |
| google            | Gemini family                           | yes       | yes          | via bridge     | `GOOGLE_API_KEY`                           |
| vllm              | Self-hosted OSS models                  | yes       | partial      | via bridge     | OpenAI-compatible endpoint URL             |
| claude_code_cli   | Local Claude Code CLI w/ host MCP       | yes       | host-managed  | yes (Phase I) | `claude` CLI installed and logged in       |

Switch providers per session — the VTuber can be Claude API while a Sub-Worker runs claude_code_cli, or vice versa.

## Where to configure

All provider credentials and defaults live in the Settings UI:

- Sidebar → Settings → **Providers** tab
- Each row has: name, model, credential fields, default-on flag
- Saved values are stored encrypted via [backend/service/auth/](../backend/service/auth/) and resolved at session start by [backend/service/credentials/install.py](../backend/service/credentials/install.py)

You can also set provider keys as environment variables when starting the backend. See [environments.md](environments.md) for the env precedence rules.

## anthropic

Direct Claude API integration.

**Required**
- `ANTHROPIC_API_KEY`

**Optional**
- Model override per session (defaults to `claude-sonnet-4-6` for VTuber, `claude-opus-4-7` for Sub-Worker)
- Custom base URL for proxy / regional endpoints

**Notes**
- Best end-to-end streaming and tool use latency
- 1M context window on Opus 4.7 (use `claude-opus-4-7[1m]` model id)

## openai

OpenAI direct, Azure OpenAI, and any OpenAI-compatible endpoint.

**Required**
- `OPENAI_API_KEY`

**Optional**
- `OPENAI_BASE_URL` — defaults to `https://api.openai.com/v1`. Set to your Azure endpoint or local proxy.
- `OPENAI_ORG_ID` for org-scoped accounts

**Notes**
- Tool use uses the JSON-mode function calling path
- Reasoning models (`o1`, `o3`) supported; executor handles their non-streaming reasoning blocks

## google

Gemini API direct.

**Required**
- `GOOGLE_API_KEY` (from Google AI Studio)

**Notes**
- Multi-turn tool use supported
- Use `gemini-2.5-pro` for long-context tasks, `gemini-2.5-flash` for cheap/fast Sub-Worker spawns

## vllm

Self-hosted OpenAI-compatible inference server.

**Required**
- Endpoint URL pointing to a running vLLM (or compatible) server
- Model name as served by the endpoint

**Optional**
- API key if your endpoint enforces one
- Custom timeout for slow self-hosted models

**Caveats**
- Tool calling depends on the served model's training. Some OSS models emit malformed JSON for tool calls — executor's parser tolerates common variants but not all.
- Streaming JSON parsing assumes OpenAI-format SSE chunks.

## claude_code_cli

Drives the locally installed [Claude Code](https://claude.com/claude-code) CLI as a backend. Lets the VTuber or Sub-Worker borrow the CLI's full agent loop — including its built-in `Bash`, `Edit`, `Read`, etc. — while still exposing Geny's tool registry through MCP.

**Required**
- `claude` CLI installed and authenticated (`claude /login` once on the host)
- The host process must have access to the CLI binary on PATH

**How it works**
- Executor spawns `claude` as a subprocess per turn with `--output-format stream-json`
- A per-session MCP HTTP bridge is spun up at startup; the CLI is launched with `--mcp-config` pointing at it
- The bridge exposes Geny's tool registry as `mcp__geny__<tool_name>`
- An observability tap (`cli_stream_logger_ctx` ContextVar) routes CLI-handled tool calls into Geny's `SessionLogger` so the audience-facing UI shows everything

**Permissions**
- Default config: `--settings '{"permissions":{"allow":["mcp__geny"]}}'` — auto-allows Geny tools while still prompting for CLI-internal tools
- For headless prod, you can extend the allowlist; see [backend/service/executor/](../backend/service/executor/) for the spawn config

**Caveats**
- Subprocess overhead — slower first-token latency than direct API
- The CLI's own permission system runs in addition to Geny's; both must allow a tool
- Cannot use `--dangerously-skip-permissions` when the backend runs as root (use the `--settings` JSON form instead)

## Picking a provider per session

Per-session model and provider is part of the manifest. In the UI:

1. Open the session (VTuber or Sub-Worker)
2. Environment → Provider → pick from the dropdown
3. Save — the manifest is updated and the next turn uses the new provider

For programmatic control, see the request body in [backend/api/agent_session.py](../backend/api/agent_session.py).

## Error codes by provider

Each provider raises distinct executor error codes. Common ones:

| Code                       | Provider(s)  | Meaning                                  |
| -------------------------- | ------------ | ---------------------------------------- |
| `exec.api.auth_failed`     | all          | Invalid or missing key                   |
| `exec.api.rate_limited`    | all          | 429 from upstream                        |
| `exec.api.timeout`         | all          | Upstream request timed out               |
| `exec.api.retry_exhausted` | all          | All retries failed                       |
| `exec.cli.spawn_failed`    | claude_code_cli | `claude` binary missing or crashed       |
| `exec.cli.auth_failed`     | claude_code_cli | CLI not logged in                       |
| `exec.cli.mcp_handshake_failed` | claude_code_cli | MCP bridge could not be reached    |

See [error_codes.md](error_codes.md) for the full list.
