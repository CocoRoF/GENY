# Built-in Tool Expansion — Progress

Plan: [01_REPORT.md](01_REPORT.md).

## Phase 0 — Config gating (progressive disclosure) ✅ DONE + VERIFIED
Commit `87593c18`. Tools declare `REQUIRED_CONFIG` tokens; unsatisfied → hidden from
the agent (never registered, never sent to the model). `tool_config_gate.compute_satisfied_config`
+ config-aware `GenyToolProvider`. Fixed gap: knowledge_*/opsidian_* gated on LTM
`curated_knowledge_enabled`. Verified on prod both directions (off → 🚫 gated + absent;
on → present), reversible flip.

## Phase 1 — Google Workspace (native) ✅ DONE + DEPLOYED
- **geny-executor 2.37.0** (PyPI): Layer-1 gating — `Tool.required_config_keys()` +
  `from_manifest(satisfied_config=)` filter (`ToolResolutionReport.gated_unconfigured`).
  Native `google_tools.py`: 9 tools — `gmail_search/read/send`, `calendar_list_events/
  create_event`, `drive_search/read`, `tasks_list/add` — httpx → Google REST, read
  `ctx.extras['google']`, self-refresh on 401, gated on `feature:google_connected`.
- **Geny backend**: `GoogleConfig` (client_id/secret/refresh_token, hidden) ·
  `service/google/oauth.py` OAuth 2.0 **Device Flow** (no redirect URI/domain — works
  on IP:port) · `controller/google_controller.py` (/api/google/status·client·connect·
  poll·disconnect) · per-session `ctx.extras['google']` injection · satisfied_config
  threaded to BOTH gates (GenyToolProvider + from_manifest via instantiate_pipeline) ·
  pin `geny-executor>=2.37.0`.
- **Frontend**: Settings → **Google** card — paste OAuth client → Connect (device-flow:
  shows code + URL, polls) → status / disconnect. `googleApi` + i18n.
- **Verified on prod**: executor 2.37.0 in container; `/api/google/status` → 200
  (not connected); a worker session has **zero** google_* tools while not connected
  (gated ✓). The actual OAuth round-trip + Google API calls need the user's Google
  Cloud OAuth client creds + device consent (done in the Google card).

### User setup (one-time)
1. Google Cloud Console → create an OAuth client of type **Desktop app / TV & Limited
   Input devices** → copy client_id + client_secret.
2. Geny → Settings → **Google** → paste id+secret → Save → **Connect** → open the shown
   URL, enter the code, approve. Done → Gmail/Calendar/Drive/Tasks tools auto-appear
   for agents.

## Phase 2 — MCP Connector Registry ✅ DONE (deploying)
Config-gated connectors to the MCP ecosystem (no executor change — uses existing
executor MCP support). `service/mcp_connectors/catalog.py`: curated catalog
(custom_http / github / notion / composio [HTTP, work anywhere] · slack / postgres /
brave [stdio npx, need node in the backend image]) + a **dynamic hidden BaseConfig
per connector** (`connector_<id>`) reusing config storage/validity/satisfied tokens.
`configured_mcp_servers()` emits executor `mcp_server` dicts (secrets → headers/env)
ONLY for enabled+complete connectors; `instantiate_pipeline(extra_mcp_servers=)` dedup-
appends them to `manifest.tools.mcp_servers` (gate = omission). API
`/api/connectors` (+ `/{id}` GET/PUT, secrets masked). Frontend: Settings → Connectors.
**The `custom_http` connector = connect ANY remote MCP server from the UI** (the
universal escape hatch). Adding more connectors = one catalog entry.

## Phase 3 — communication / data ✅ DONE (deploying)
- Native tools (Geny BaseTool, gated via Phase 0, no executor release): **email_send**
  (SMTP stdlib, gated `config:email`; EmailConfig auto-form in Settings→Tool) +
  **http_request** (generic authenticated REST GET/POST/PUT/PATCH/DELETE, ungated).
- Catalog accuracy (most official npx reference servers archived in 2025): notion →
  token-based npx `@notionhq/notion-mcp-server` (hosted = OAuth); brave →
  `@brave/brave-search-mcp-server`; added **filesystem** (maintained npx). Now 8
  connectors. Slack/Postgres = best-effort archived npx.

## Phase 4 — VTuber real-time (OBS / Twitch / YouTube / Chzzk / screen)
- **Reachable today via the `custom_http` connector** for any MCP server they expose.
- Native real-time integrations (OBS websocket control, Twitch/YouTube/Chzzk live-chat
  ingestion, screen capture) need the user's platform accounts/creds and a running
  target to test — they are platform-credential follow-ups; the framework + custom_http
  cover the connect path. (Screen-observation trigger system already exists.)
- To add a specific one natively: same pattern as Google (executor/Geny native tool +
  config + gate) or a catalog connector if an MCP server exists.
