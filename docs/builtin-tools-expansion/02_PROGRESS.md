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

## Next phases (per 01_REPORT.md)
- Phase 2 — curated MCP connector registry (Notion/Slack/GitHub/Composio), config-gated.
- Phase 3 — communication/data (email/Telegram/SMS/SQL/HTTP).
- Phase 4 — VTuber-specific (OBS / live chat / screen).
