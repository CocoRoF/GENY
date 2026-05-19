# Phase I — Claude Code (CLI) MCP wrap

## Problem

When an Environment's Stage 6 provider is `claude_code_cli`, the
LLM running inside the `claude` subprocess has no access to Geny's
custom tools (e.g. `send_direct_message_internal`,
`whiteboard_voice_notes`, MCP-bridged tools). The CLI advertises
only its own built-ins (`Bash`, `Read`, `Write`, `Glob`,
`ToolSearch`, …). Sessions where the LLM needs to call a Geny tool
hallucinate against the CLI's built-in palette → tool dispatch
fails → user-visible "Tool execution complete: 32 calls, 29
errors".

The 2.0.4 executor already routes the request's `tools` parameter
through to the Anthropic / OpenAI / Google / vLLM SDK clients
natively — they pass tool schemas via the SDK's `tools=` parameter.
For `claude_code_cli`, `claude_code_argv` ignores
`request.tools` entirely (verified — grep returns zero matches).

## Why MCP, not system-prompt injection

The Claude Code CLI uses native `tool_use` only for tools registered
in its tool list. Tools the LLM is told about via system prompt but
not registered produce text that looks like tool calls — not
structured `tool_use` blocks the executor can parse. MCP is the
mechanism the CLI exposes for registering arbitrary external tools.

## Stage-interface preservation

User constraint: "절대 기존 로직과 Stage의 강력한 Interface를 훼손하지
않으면서 완벽하게 만들어야만 해".

The pipeline's stage interface is *structural*, not *behavioural*:

- Stage 10 dispatches `tool_use` blocks if present; no-ops otherwise.
- Stage 16 loops if there's pending work; no-ops otherwise.

When `claude_code_cli` uses MCP, the CLI handles the entire agentic
loop *internally* (LLM ↔ MCP tool ↔ LLM). The single CLI invocation
returns the final assistant message. Stage 10 receives that
assistant message, sees no `tool_use` blocks (they were executed
inside the CLI), and naturally no-ops. Stage 16 sees no pending
state and naturally finishes. Memory / persona / persistence stages
run identically to the Anthropic API path because the final
`APIResponse` shape is the same.

**The interface is preserved. The behaviour adapts to what the
provider can do natively.** Anthropic API path keeps the
per-iteration tool-dispatch loop; claude_code_cli path collapses
the loop inside one CLI invocation. Both produce identical
canonical outputs.

## Architecture

```
┌──────────────────────┐                          ┌──────────────────┐
│  Geny FastAPI app    │                          │ Claude Code CLI  │
│                      │                          │  (--mcp-config)  │
│ ┌──────────────────┐ │     stdin/stdout         │                  │
│ │ /api/internal/   │◄┼───── HTTP JSON-RPC ──────┤  geny_mcp_bridge │
│ │  mcp/{session}/  │ │                          │  (stdio MCP srv) │
│ │  rpc             │ │                          │                  │
│ └──────────────────┘ │                          │  Spawns:         │
│                      │                          │   python bridge  │
│ ┌──────────────────┐ │                          │                  │
│ │ AgentSession-    │ │                          │                  │
│ │  Manager         │ │   spawn claude w/        │                  │
│ │  - mint MCP      │ │   --mcp-config <json>    │                  │
│ │    token         ├─┼─────────────────────────►│                  │
│ │  - synthesize    │ │   bridge env vars:        │                  │
│ │    mcp_config    │ │     GENY_MCP_URL          │                  │
│ │  - pass to       │ │     GENY_MCP_TOKEN        │                  │
│ │    APIRequest    │ │     GENY_MCP_SESSION_ID   │                  │
│ └──────────────────┘ │                          │                  │
│                      │                          │                  │
│ ┌──────────────────┐ │                          │                  │
│ │ Stage 6 (CLI     │ │                          │                  │
│ │  client)         │◄┼─── stream-json output ───┤                  │
│ │  - tools/use     │ │      (assistant text     │                  │
│ │    handled by    │ │       only; tool_use     │                  │
│ │    CLI via MCP   │ │       happens inside     │                  │
│ │                  │ │       CLI's MCP loop)    │                  │
│ └──────────────────┘ │                          │                  │
└──────────────────────┘                          └──────────────────┘
```

## Components

### 1. Executor 2.0.5

- New `APIRequest.mcp_config: Optional[Dict[str, Any]]` — when set,
  serializes to `--mcp-config <json>`.
- `claude_code_argv` reads `request.mcp_config` (falls back to the
  per-client constructor `mcp_config` for legacy clients).
- When MCP is configured, also emit `--tools ""` to disable CLI
  built-ins (they collide with Geny tool surface; LLM should
  exclusively use MCP-advertised tools).
- Backward compatible: legacy callers that don't set
  `request.mcp_config` and have no `claude_cli.mcp_config_path`
  retain today's behaviour (no MCP servers, CLI built-ins
  available).

### 2. Geny `scripts/geny_mcp_bridge.py`

Minimal stdio MCP server (~80 LOC). Reads MCP JSON-RPC from stdin,
forwards each method to `/api/internal/mcp/{session_id}/rpc` via
HTTP, writes the response to stdout.

Env vars:
- `GENY_MCP_URL` — base URL (default `http://127.0.0.1:8000`).
- `GENY_MCP_TOKEN` — bearer token (minted per session).
- `GENY_MCP_SESSION_ID` — session UUID.

Methods supported:
- `initialize` — return server info + capabilities.
- `notifications/initialized` — ack.
- `tools/list` — proxy to Geny.
- `tools/call` — proxy to Geny.
- Anything else — JSON-RPC method-not-found.

### 3. Geny `/api/internal/mcp/{session_id}/rpc`

FastAPI route handling MCP JSON-RPC. Auth via per-session bearer
token.

- `tools/list`: returns Geny tool schemas for the session, filtered
  by the session's tool preset + permission rules.
- `tools/call`: validates the tool name is allowed for this session,
  validates the input against the schema, executes via the same
  tool registry / `tool_loader` infrastructure s10_tool uses,
  returns MCP-shaped content (text / image / resource).

### 4. Per-session MCP config synthesis

`agent_session_manager.create_agent_session` (when the env's Stage
6 provider is `claude_code_cli`):

1. Generate ephemeral bearer token (256-bit hex).
2. Store token in session record (used to validate incoming bridge
   calls).
3. Build MCP config:
   ```python
   {
     "mcpServers": {
       "geny": {
         "type": "stdio",
         "command": sys.executable,
         "args": [str(GENY_MCP_BRIDGE_PATH)],
         "env": {
           "GENY_MCP_URL": _internal_url(),
           "GENY_MCP_TOKEN": token,
           "GENY_MCP_SESSION_ID": session_id,
         },
       },
     },
   }
   ```
4. Pass via every Stage 6 `APIRequest.mcp_config`.

User-supplied MCP servers from the env manifest still merge in
alongside Geny's bridge — the LLM sees both surfaces.

### 5. Permissions + telemetry (Phase 2 follow-up)

Not in Phase 1 scope:

- The MCP `tools/call` endpoint should apply the session's
  permission rules (allow/deny) and emit `permission_denied` MCP
  errors when blocked.
- Each tool call should be logged to the session audit trail with
  the same shape s10_tool emits today, so the UI's "Tool execution
  complete: N calls" telemetry shows MCP calls too.
- The CLI's result envelope carries `total_cost_usd` — the
  executor should accumulate this into the session's cost ledger.

Phase 1 ships the wire (LLM ↔ MCP ↔ Geny tools) so users can
actually call Geny tools from Claude Code (CLI) sessions. Phase 2
hardens permissions + makes the telemetry surface symmetric with
the Anthropic API path.

## Acceptance criteria

Phase 1:

1. A user creates a VTuber session whose env pins
   `claude_code_cli` as the Stage 6 provider.
2. The VTuber's LLM sees `mcp__geny__send_direct_message_internal`
   in its tool list.
3. Calling that tool dispatches via the Geny tool registry exactly
   like the Anthropic API path would.
4. CLI built-ins (`Bash` / `Read` / `ToolSearch` / etc.) are NOT
   in the LLM's tool list (no hallucination surface).
5. Multi-turn conversations work (executor 2.0.4 flattening
   continues to handle history).
6. Memory, persona, persistence, summarization stages all run
   identically to the Anthropic API path.
7. The Stage 6 client emits the same canonical `APIResponse`
   shape regardless of provider (already established in 2.0.3).
