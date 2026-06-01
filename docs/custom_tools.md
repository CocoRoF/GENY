# Custom Tools

> DB-backed, UI-editable tool registry. Introduced in cycle 20260525_1 (PRs #847–#850 backend hardening + B/C/D rollout).

Geny's three layers of tool registration:

1. **`backend/tools/built_in/*_tools.py`** — framework-shipped Python tools (memory, knowledge, geny session ops). Always loaded.
2. **`backend/tools/custom/*_tools.py`** — Python tools you drop into the repo. Always loaded.
3. **DB-backed Custom Tools** — this document. CRUD via UI / API; no Python.

The DB-backed layer is the recommended path for *external API* integrations because:

- No code review / restart cycle. CRUD writes hot-reload into the live `ToolLoader`.
- Built-in schema hygiene (PR #847): host-injected params hidden from LLM, `additionalProperties: false` enforced, structured `ToolError` for failures.
- Three backend kinds cover most real cases without writing Python.

---

## Backend kinds

### 1. HTTP

Call an external HTTP API. Template placeholders are interpolated before the request.

```jsonc
{
  "name": "github_get_issue",
  "description": "Fetch a GitHub issue by repo + number.",
  "backend_kind": "http",
  "input_schema": {
    "type": "object",
    "properties": {
      "repo":   { "type": "string", "description": "owner/repo" },
      "number": { "type": "integer" }
    },
    "required": ["repo", "number"],
    "additionalProperties": false
  },
  "config": {
    "method": "GET",
    "url_template": "https://api.github.com/repos/${arg:repo}/issues/${arg:number}",
    "headers": {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer ${secret:GITHUB_TOKEN}"
    },
    "response_handler": "json",
    "timeout_seconds": 30
  }
}
```

**Placeholders**:
- `${arg:foo}` — value from the LLM's tool call (after schema validation).
- `${secret:KEY}` — host-resolved from environment / settings. Missing → empty string (silent, so we don't leak the key name through the LLM).
- `${session:session_id}` — the trusted caller's session id from `ToolContext`. Other `${session:*}` keys reserved for future use.

**Response handlers**:
- `json` (default) — parse + re-serialise. Compact, deterministic.
- `text` — raw body.
- `sse_stream_collect` — read until `sse_done_marker`, concatenate `data:` lines.

### 2. MCP Proxy

Re-export a tool from an MCP server you've already registered (via **환경관리 → MCP**) with a new name or trimmed schema.

```jsonc
{
  "name": "search_docs_proxy",
  "description": "Documentation search — wraps the docs MCP server's search tool.",
  "backend_kind": "mcp_proxy",
  "input_schema": { "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"], "additionalProperties": false },
  "config": {
    "upstream_mcp_server": "docs",
    "upstream_tool_name": "search",
    "schema_overlay": null
  }
}
```

Useful for hiding upstream complexity or grouping related upstream tools under one local namespace.

### 3. Python (Inline)

The full Python implementation of a `BaseTool` subclass stored directly in the DB row. The form modal's code editor lets the operator write the class body — same shape as a `backend/tools/custom/*_tools.py` file but the source lives in the web, not the repo.

```jsonc
{
  "name": "my_custom_tool",
  "description": "Whatever you want the LLM to see.",
  "backend_kind": "python_inline",
  "config": {
    "source_code": "from tools.base import BaseTool, ToolError\n\nclass MyCustomTool(BaseTool):\n    name = 'my_custom_tool'\n    description = 'Describe what this tool does for the LLM.'\n\n    def run(self, query: str) -> str:\n        return f'You asked: {query}'\n",
    "class_name": "MyCustomTool"
  }
}
```

At load time the adapter `exec()`s the source in a fresh namespace seeded with `BaseTool`, `ToolError`, `asyncio`, `json`, `logging`, `typing`. The host's `service.*` and `geny_executor.*` packages remain importable via normal `import` statements, so an inline tool can reach the same registries / clients / managers an in-repo tool would.

Use this kind when:
- The tool needs more than a single HTTP call (multi-step logic, background dispatch, state).
- The tool needs Python control flow.
- You want to read + edit the actual code in the web UI.

**Security**: the host is single-admin. The inline source runs with full host privilege. Don't open the admin surface to untrusted users with this kind enabled.

Geny ships the `blog_agent_*` family as `python_inline` samples — open one in the form modal to see the real implementation as a starting point for your own tools.

### 4. Builtin Alias (legacy)

Metadata overlay on a Python `BaseTool` subclass already loaded from `backend/tools/custom/`. The Python code runs untouched; only the LLM-facing description / examples are overridden.

```jsonc
{
  "name": "blog_agent_status",
  "description": "Check progress on a delegated blog task.",
  "backend_kind": "builtin_alias",
  "config": {
    "source_module": "blog_agent_tools",
    "source_class": "BlogAgentStatusTool"
  }
}
```

This kind shipped with PR #851 but turned out to be the wrong direction — it doesn't actually move the implementation to the web, just dresses up the in-repo Python. The follow-up flipped the blog samples to `python_inline`. New tools should use `python_inline`; the alias kind is kept for backward-compat on rows that already exist.

---

## API surface

All endpoints require admin auth. Mutations trigger `ToolLoader.reload_custom_tools_db()` so the new roster lands in the active `AgentSessionManager` without restart.

| Verb | Path | Purpose |
|---|---|---|
| `GET` | `/api/custom-tools` | List all (samples + user, enabled + disabled) |
| `GET` | `/api/custom-tools/{tool_id}` | Detail |
| `POST` | `/api/custom-tools` | Create — 409 on name collision |
| `PUT` | `/api/custom-tools/{tool_id}` | Replace — 404 if missing, 409 on rename collision |
| `DELETE` | `/api/custom-tools/{tool_id}` | Delete — works on samples too |
| `PATCH` | `/api/custom-tools/{tool_id}/enabled` | Toggle without rewriting the whole row |
| `POST` | `/api/custom-tools/{tool_id}/duplicate` | Fork (auto-renames with `_copy` suffix, clears `is_sample`) |
| `POST` | `/api/custom-tools/{tool_id}/test` | Dry-run (schema validation) or real-call |

Frontend client lives in [`frontend/src/lib/api.ts`](../frontend/src/lib/api.ts) as `customToolsApi`.

---

## Security

The same hygiene that PR #847 installed on Python tools applies here:

- **Schema hygiene** — `additionalProperties: false` is forced; `session_id` (and any other entry in `tools.base.INJECTED_PARAM_NAMES`) is stripped from `properties` / `required` at every write.
- **Trusted-context injection** — `session_id` comes from `ToolContext`, never from the LLM. Even if a row is hand-edited around the model validator, the adapter strips LLM-supplied values before dispatch.
- **Secret resolution** — `${secret:KEY}` never persists the value; only the reference string is stored. Missing secrets resolve to empty string instead of leaking the key name through the LLM.
- **URL allowlist** (planned) — `GENY_CUSTOM_TOOL_URL_ALLOWLIST` env var, default empty (= unrestricted for hobbyist installs).
- **Error envelopes** — adapters raise `ToolError` or return `{"error": "..."}` JSON; the bridge (MCP) and the executor adapter (Anthropic) promote both to a real `isError: True` response. No more silent successes paraphrased as "맡겼어, 잠깐만".

---

## Bundled samples

Geny ships the five `blog_agent_*` tools as `python_inline` samples. The seeder reads `backend/tools/custom/blog_agent_tools.py` at boot and writes its source into 5 DB rows (one per tool, same source body, different `class_name`) so you can:

1. **Open any sample in the form modal** and read the real Python implementation.
2. **Duplicate → edit** to fork into a User row and customise — the original stays as a reference.
3. **Disable** any of them if you don't use the external blog Agent.

The seeder is idempotent and runs every boot. It also actively upgrades legacy `builtin_alias` rows from PR #851 to the new `python_inline` form, so operators who saw the alias version flip to the editable Python version on the next deploy.

Once the DB-backed samples are verified working in your environment, the in-repo `backend/tools/custom/blog_agent_tools.py` can be removed — the shared service code under `backend/service/blog_agent/` (registry, client, delivery) keeps working because the inline samples reach it via normal `import service.blog_agent.*`.

---

## Internals

| Layer | File |
|---|---|
| Pydantic shapes | [`backend/service/custom_tools/models.py`](../backend/service/custom_tools/models.py) |
| DB CRUD | [`backend/service/custom_tools/store.py`](../backend/service/custom_tools/store.py) |
| Adapters (HTTP / MCP-proxy / alias) | [`backend/service/custom_tools/adapters.py`](../backend/service/custom_tools/adapters.py) |
| Sample seeder | [`backend/service/custom_tools/samples.py`](../backend/service/custom_tools/samples.py) |
| DB model | [`backend/service/database/models/custom_tool.py`](../backend/service/database/models/custom_tool.py) |
| REST API | [`backend/controller/custom_tools_controller.py`](../backend/controller/custom_tools_controller.py) |
| ToolLoader integration | [`backend/service/tool_loader.py`](../backend/service/tool_loader.py) (`load_custom_tools_from_db`, `reload_custom_tools_db`) |
| Boot wiring | [`backend/main.py`](../backend/main.py) (after the filesystem `tool_loader.load_all`) |
| Frontend tab | [`frontend/src/components/tabs/CustomToolsTab.tsx`](../frontend/src/components/tabs/CustomToolsTab.tsx) |
| Frontend modal | [`frontend/src/components/env_management/custom_tools/CustomToolFormModal.tsx`](../frontend/src/components/env_management/custom_tools/CustomToolFormModal.tsx) |
| Frontend API client | [`frontend/src/lib/api.ts`](../frontend/src/lib/api.ts) (`customToolsApi`) |
