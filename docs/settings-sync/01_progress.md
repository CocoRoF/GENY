# Settings-sync progress

See [00_plan.md](00_plan.md).

## Phase 1 — GAPT settings category  ✅ DEPLOYED + VERIFIED
- [x] Backend `gapt_settings_controller.py` (proxy cloudflare/diagnose/llm-health)
- [x] Register in main.py
- [x] Frontend GAPT virtual category (gated on gapt status)
- [x] `GaptSettingsPanel` (Cloudflare + readiness)
- [x] Deploy + verify — prod GAPT connected; cloudflare/diagnose proxy returns 200

## Phase 2 — Provider-key sync hub
- [x] `service/sync/provider_key_sync.py` (synced_env → GAPT vault + avatar; sync_all)
- [x] `service/avatar/client.py` (GENY_AVATAR_BASE_URL, PUT /api/config/keys)
- [x] LLMCredentialsConfig anthropic/openai/google → synced_env
- [x] `MediaCredentialsConfig` (fal_key/replicate_api_token, visible, synced_env)
- [x] `sync_controller.py` (/api/sync/targets, /api/sync/provider-keys) + register
- [x] Frontend "키 동기화" button in LLM Backends panel
- [x] Deploy + verify — `/api/sync/provider-keys` pushed anthropic+openai to GAPT
      vault (`gapt: pushed`); avatar gracefully skipped (GENY_AVATAR_BASE_URL unset);
      empty keys skipped; media_credentials visible in General; no boot errors.
  - Note: avatar sync inert until `GENY_AVATAR_BASE_URL` set in compose.

## Phase 3 — model unify + reverse read
- [x] reverse read surfaced — GAPT panel's `/diagnose` card shows Cloudflare/
      tunnel-mode/preview-domain/readiness (GAPT→Geny, read-only). Done in Phase 1.
- [SKIP] model-defaults unify Geny↔GAPT — REASSESSED as low-value: Geny sessions
      and GAPT sandboxes are separate execution contexts; GAPT's default model is an
      env-only Setting (`GAPT_DEFAULT_MANIFEST_ID`) with no clean write API. Forcing
      a shared model is dubious. Revisit only on a concrete need (e.g. "GAPT sandbox
      agents must use the model I pick in Geny") — then push via GAPT's manifest API.
