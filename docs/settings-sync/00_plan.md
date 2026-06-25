# Cross-service Settings Sync + GAPT category in Geny

Goal: (1) settings configured in Geny propagate accurately to GAPT + geny-avatar;
(2) when GAPT is connected, manage GAPT's important settings (Cloudflare etc.)
from Geny's Settings window under a **GAPT** category.

Scope chosen (2026-06-25): **all phases (1+2+3)**, avatar sync **included**.

## Findings (recon 2026-06-25)

- **Geny settings = 3 independent systems**: A. Global Config (`/api/config`,
  `@register_config` → Postgres `persistent_configs`; categories derived from
  `get_category()`; propagation `apply_change`→`os.environ`/env_sync + channel
  gateway hot-reload). B. Tool Settings (per-env manifest extras). C. Framework
  Settings (`~/.geny/settings.json`). "LLM 백엔드" is a hardcoded **virtual**
  frontend category (LLMBackendsPanel).
- **GAPT settings = 2 planes**: boot env-var Settings (Caddy domains/ports/
  secrets — NOT API-mutable) and runtime provider config (DB+vault: **Cloudflare**
  + LLM backends — full CRUD under `/_gapt/api/...`, single-admin cookie auth).
- **Geny↔GAPT**: `GaptClient` (cookie auth, generic get/post/delete) already
  calls any `/_gapt/api/**`. `GET /api/gapt/status` is the connection gate.
- **avatar**: live `config.json` + `PUT /api/config/keys` (no restart). Needs
  image-gen keys (OPENAI/GEMINI/REPLICATE/FAL). No HTTP coupling to Geny yet.
- **Shared surface = LLM/image-gen provider API keys** (same env names, set
  independently per service). No cross-service propagation exists today.

## Phase 1 — GAPT settings category in Geny

- Backend `gapt_settings_controller.py`: proxy GAPT settings via `GaptClient`
  under `/api/gapt/settings/*` (cloudflare CRUD + verify + tunnel snapshot +
  ensure-wildcard + cert + `/diagnose` + llm-health). 412 when not configured;
  map `GaptApiError` → HTTPException.
- Frontend: "GAPT" virtual category in `SettingsTab` (LLM-Backends pattern),
  shown only when `gaptApi.status().running`. `GaptSettingsPanel` (Cloudflare
  form driven by `/verify`, tunnel-mode badge, cert, readiness from `/diagnose`).

## Phase 2 — Provider-key sync hub (Geny → GAPT + avatar)

- Geny `LLMCredentialsConfig` = source of truth. Add `FAL_KEY`, `REPLICATE_API_TOKEN`.
- New `service/sync/provider_key_sync.py`: on key change (`apply_change`), push to
  GAPT vault (`POST /_gapt/api/llm-backends/api-keys/{provider}`, when connected)
  + avatar (`PUT {avatar}/api/config/keys`). Name map GOOGLE↔GEMINI.
- New avatar client (`service/avatar/client.py`) + `AvatarConfig` (base-url) in a
  new `sub_config/avatar/` (category for the connection). A "Sync now" action.

## Phase 3 — model defaults unify + reverse read

- Geny↔GAPT model default reconciliation (Geny `settings.model.*` ↔ GAPT manifest;
  pricing stays upstream).
- GAPT→Geny read-only: surface Cloudflare/preview-domain/tunnel status in Geny
  (already covered by the Phase 1 GAPT panel's diagnose card).

## Hard exclusions (never sync)

Claude OAuth/setup-token (rotation), infra secrets/DB DSN/admin PW/session keys,
channel bot tokens, TTS/STT/voice.

See [01_progress.md](01_progress.md).
