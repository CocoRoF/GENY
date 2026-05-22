# Environments

Every Geny session resolves an `EnvironmentManifest` — a JSON-serializable description of which stages run, which tools are wired in, which MCP servers to spawn, which hooks fire, and what guards apply. This page covers how to author and edit them.

## What an environment is

An `EnvironmentManifest` ([from geny-executor](https://github.com/CocoRoF/geny-executor/blob/main/docs/manifest.md)) describes a complete pipeline shape. Think of it as a recipe for `Pipeline.from_manifest_async(manifest)`:

```jsonc
{
  "schema_version": "1.0",
  "stages": [
    {"id": "s01_bootstrap", "impl": "default"},
    {"id": "s06_api",       "impl": "default", "config": {"max_retries": 3}},
    /* ... 21 stages total ... */
  ],
  "tools": {
    "native": ["read_file", "write_file", "web_search"],
    "mcp_servers": ["mcp__geny", "playwright"]
  },
  "guards": {
    "iteration_max": 32,
    "token_budget":  200_000
  },
  "hooks": {
    "pre_turn":  [/* ... */],
    "post_turn": [/* ... */]
  }
}
```

Sessions never construct manifests from scratch — they start from a **template** and may be customized per-session.

## Two seed templates

Implemented in [backend/service/environment/templates.py](../backend/service/environment/templates.py):

| Template ID            | Used by                          | Notes                                        |
| ---------------------- | -------------------------------- | -------------------------------------------- |
| `template-worker-env`  | Sub-Worker, solo Worker, dev/research/planner | Heavy tool budget, full MCP, long guards |
| `template-vtuber-env`  | VTuber                           | Light tool budget, persona-aware, no browser |

Both seeds are materialized on disk at app boot via `install_environment_templates()`. Editing a seed in the UI persists in the user's database and is picked up on next session create — same model as `ToolPresetStore`.

The manifests themselves come from `service.executor.default_manifest.build_default_manifest`, so seed envs and ephemeral sessions never diverge.

### VTuber tool whitelist

The VTuber seed is intentionally narrow. The current custom-tool whitelist (from `templates.py`) includes:

- `web_search`, `news_search`, `web_fetch`
- `blog_agent_delegate` and friends (delegation to external blog AI)
- `whiteboard_describe`, `whiteboard_extract_links`, `whiteboard_transcribe`
- `send_direct_message_internal` — the delegation entry point

Notably **excluded**: `browser_*` Playwright tools (a casual question shouldn't spawn a real browser), heavy file I/O, code execution. Those live in the Worker env.

### Worker tool deny list

Conversely, the Worker env keeps the full registry except a small deny list of VTuber-only persona helpers.

## Editing an environment

From the UI:

1. Sidebar → **Environments**
2. Pick a template or session-attached env
3. The editor (TypeScript-side: [frontend/src/components/environment/JsonSchemaForm.tsx](../frontend/src/components/environment/JsonSchemaForm.tsx)) shows three tabs:
   - **Tools** — toggle native + MCP tools, edit per-tool config ([ToolsEditor.tsx](../frontend/src/components/environment/ToolsEditor.tsx))
   - **Strategies** — per-stage config knobs ([StrategyEditors.tsx](../frontend/src/components/environment/StrategyEditors.tsx))
   - **Raw JSON** — escape hatch for power users
4. Save — the manifest is validated against [environment/schemas.py](../backend/service/environment/schemas.py) and persisted

The detail drawer ([EnvironmentDetailDrawer.tsx](../frontend/src/components/EnvironmentDetailDrawer.tsx)) shows the resolved manifest as it would be applied to a session.

## CRUD API

Defined in [backend/service/environment/service.py](../backend/service/environment/service.py) and [backend/api/environment.py](../backend/api/environment.py). Pydantic schemas in [environment/schemas.py](../backend/service/environment/schemas.py).

| Endpoint                        | What it does                                                            |
| ------------------------------- | ----------------------------------------------------------------------- |
| `POST /environments`            | Create (blank, from-preset, or from-session)                            |
| `GET /environments`             | List user's envs                                                        |
| `GET /environments/{id}`        | Read full manifest                                                      |
| `PUT /environments/{id}`        | Replace manifest                                                        |
| `DELETE /environments/{id}`     | Remove                                                                  |
| `POST /environments/bulk_import`| Drop-import up to 200 envs at a time (per-entry size cap 2 MiB)         |

Bulk import caps are guardrails against accidental giant drops, not DoS protection. Tune them in `schemas.py:BULK_IMPORT_MAX_*` if your workflow needs more.

### Create modes

`CreateEnvironmentRequest.mode` ∈ `{blank, from_session, from_preset}`. When omitted, the backend infers:

- `session_id` present → `from_session`
- `preset_name` present → `from_preset`
- otherwise → `blank`

`manifest_override` lets the client commit a fully-formed manifest in one POST (used by the Library NEW tab to skip the create-then-replace round-trip).

## Per-session overrides

Attaching an env to a session is a separate step. The session can then make in-place edits without forking the template:

1. Session create resolves the template
2. The resolved manifest is stored on the session record
3. Edits via the session-env editor mutate the session's copy, not the template

This is why two sessions started from the same template can drift apart over time — each accumulates its own per-session edits.

The session-env surface lives in [frontend/src/components/session-env/](../frontend/src/components/session-env/).

## Env vars and provider config

The manifest does **not** contain provider keys. Those live separately in the Settings UI and are merged in by `service.credentials.install` at session start. So an exported manifest is safe to share — no secrets cross the wire.

The provider choice itself (anthropic vs openai vs vllm…) **is** in the manifest, so swapping providers is a manifest edit.

## Templates beyond the two seeds

`service.tool_preset.templates` ([backend/service/tool_preset/templates.py](../backend/service/tool_preset/templates.py)) defines additional curated presets users can fork. Same materialization pattern — seeded on disk at boot, editable in the UI.

For one-off experiments, prefer:

1. Fork a template into a new env
2. Edit it
3. Discard or promote when done

…rather than mutating the seed directly, which propagates to every new session.

## Stage 15 HITL hooks

Approval gates run between stages via [backend/service/hitl/](../backend/service/hitl/). The manifest declares which gates fire; the frontend renders the modal via [frontend/src/components/modals/](../frontend/src/components/modals/) and translations in the `hitl` i18n namespace.

Typical use: pause before destructive tools, require approval for outgoing webhooks.

## Where to look for what

| You want to…                                | Start here                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| Add a new template                          | [environment/templates.py](../backend/service/environment/templates.py)  |
| Adjust default Worker tools                 | `_WORKER_CUSTOM_TOOL_DENY` in templates.py                               |
| Adjust default VTuber tools                 | `_VTUBER_CUSTOM_TOOL_WHITELIST` in templates.py                          |
| Change tool config schema                   | [tool_loader.py](../backend/service/tool_loader.py)                      |
| Hook into env CRUD events                   | [environment/service.py](../backend/service/environment/service.py)     |
| Browse exported manifests                   | UI → Environments → Export                                               |
