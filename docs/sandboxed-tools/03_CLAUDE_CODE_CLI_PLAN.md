# claude_code_cli ⇄ GAPT tools — the complete fix

## Diagnosis (code-verified)

Why claude_code_cli sessions can't use GAPT/forge/env tools:

1. **MCP bridge is session-blind.** `controller/mcp_bridge_controller.py`
   `_list_session_tools` (line 148) + `_execute_tool` (line 204) resolve tools from
   the **global** `ToolLoader`, and dispatch with a **bare**
   `ToolContext(session_id=...)` (line 226) — **no `.environment`, no `.sandbox`,
   no `.working_dir`**. So:
   - `env` / `forge_tool` / `save_pack` → `context.environment is None` → error.
   - session-scoped tools (forged, per-env packs, env-enabled) → invisible (global
     loader doesn't have them).
2. **OAuth sessions get no sandbox.** `_skip_for_cli_oauth` skips workspace
   provisioning for rotating OAuth → `forge_tool` has no `ctx.sandbox` anyway.
3. **Coupling.** executor `attach_runtime(sandbox=)` BOTH sets `ctx.sandbox` (good)
   AND wraps the CLI in `ContainerCLIRunner` (runs CLI in-container → needs a
   non-rotating token; and the stdio MCP bridge can't even spawn in-container).

## Decision: decouple + make the bridge session-aware (host CLI, sandboxed backend tools)

claude_code_cli runs on the **host** (OAuth-safe), but its `env`/`forge`/`save_pack`/
`gapt_*` tools execute in the **backend** against the session's GAPT workspace via
`ctx.sandbox` (docker exec). Works for ALL auth modes; no in-container bridge.

### A. executor (2.33.0)
- `attach_runtime(sandbox=, containerize_cli: bool = True)` + `_apply_runtime` +
  `__init__` (`self._containerize_cli`). `_build_client_for` wraps the CLI only when
  `_attached_sandbox and self._containerize_cli`. → attach `ctx.sandbox` for tools
  WITHOUT containerizing the CLI.

### B. Geny backend
1. **mcp_bridge_controller (critical):** resolve tools from the live session's
   pipeline registry (env + forged + pack + global) and dispatch with a full
   `ToolContext(session_id, environment=pipeline.environment, sandbox=session sandbox,
   working_dir=/workspace)`. Fallback to the global loader when no live session.
2. **agent_session_manager:** stop skipping the sandbox for claude_code_cli — always
   provision the workspace; pass `containerize_cli=False` for claude_code_cli so the
   CLI stays on host.
3. **AgentSession:** thread `containerize_cli=False` into `attach_runtime` for the
   claude_code_cli provider.
4. **workspace_id injection:** surface the session's GAPT workspace id to the agent
   (prompt/context) so `gapt_*` tools + the agent target the right workspace.

### C. Verify
anthropic already binds + forge works (proven). Verify the bridge now passes
environment+sandbox (env/forge reachable) and the claude_code_cli path provisions a
workspace with `containerize_cli=False`.
