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
- [ ] Deploy + verify
  - Note: avatar sync inert until `GENY_AVATAR_BASE_URL` set in compose.

## Phase 3 — model unify + reverse read
- [ ] model default reconcile Geny↔GAPT
- [ ] reverse read surfaced (diagnose card)
- [ ] Deploy + verify
