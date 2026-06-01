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

## Three backend kinds

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

### 3. Builtin Alias

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

Geny ships the `blog_agent_*` family as samples via this kind. Use it to:

- Re-document an existing Python tool for a specific persona.
- Pin a stable LLM-facing name when the Python class is renamed.
- Override `description` / `examples` per environment.

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

Geny ships the five `blog_agent_*` tools as `builtin_alias` samples so you can:

1. See a real working entry in the UI without configuring anything.
2. **Duplicate → edit** to learn the schema/config surface against a tool whose underlying Python you can read.
3. **Disable** any of them if you don't use the external blog Agent.

The seeding is idempotent and runs every boot — adding a sample to `backend/service/custom_tools/samples.py` is the way to ship more.

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
