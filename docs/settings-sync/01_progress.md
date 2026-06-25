# Settings-sync progress

See [00_plan.md](00_plan.md).

## Phase 1 — GAPT settings category
- [x] Backend `gapt_settings_controller.py` (proxy cloudflare/diagnose/llm-health)
- [x] Register in main.py
- [x] Frontend GAPT virtual category (gated on gapt status)
- [x] `GaptSettingsPanel` (Cloudflare + readiness)
- [ ] Deploy + verify

## Phase 2 — Provider-key sync hub
- [ ] `FAL_KEY`/`REPLICATE_API_TOKEN` in Geny LLMCredentialsConfig
- [ ] `service/sync/provider_key_sync.py` (Geny→GAPT vault + avatar)
- [ ] avatar client + AvatarConfig (base-url) + sub_config/avatar
- [ ] wire apply_change → sync; "Sync now" action
- [ ] Deploy + verify

## Phase 3 — model unify + reverse read
- [ ] model default reconcile Geny↔GAPT
- [ ] reverse read surfaced (diagnose card)
- [ ] Deploy + verify
