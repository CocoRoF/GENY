# LLM Backend Upgrade — Cycle Postmortem

> **Cycle:** llm-backend-upgrade-plan
> **Window:** 2026-05-17 (single session, multi-PR)
> **Outcome:** ✅ All 20 PRs merged. `geny-executor==2.0.0` live on PyPI. Geny consumes the new contract end-to-end.

## What we shipped

### geny-executor 2.0.0

A complete generalisation of the LLM client layer. `ClientRegistry` now ships six providers:

| Provider | Kind | Notes |
|---|---|---|
| `anthropic` | API | unchanged surface |
| `openai` | API | unchanged surface |
| `google` | API | unchanged surface |
| `vllm` | API | unchanged surface (OpenAI-compat) |
| `claude_code_cli` | CLI subprocess | **new** — drives local `claude` binary via stream-json |
| `copilot_cli` | CLI subprocess | **new** — drives `gh copilot` |

Underneath:

- **`CredentialBundle`** is the single credential channel. The old `Pipeline.from_manifest_async(api_key=...)` shape is kept as a thin compatibility shim that wraps a single key into a bundle.
- **`ClientCapabilities`** widens from 7 to 16 fields (structured_output, session_continuity, mcp_passthrough, budget_limit, token_usage, cost_usage, is_subprocess, requires_workspace, streaming_granularity). Sub-pipelines / stage code negotiate on capabilities, not provider strings (P2).
- **`APIRequest` / `TokenUsage` / `APIResponse`** gain non-breaking fields (response_format, session_hint, cost_usd, duration_ms).
- **Stage 6 provider unified at `config["provider"]`.** Strict load rejects the legacy `strategies["provider"]` location — closes the silent-divergence bug.
- **`bridge.py` (ProviderBackedClient) deleted.** Test fixtures pass through an inline adapter in `APIStage`.
- **Stage 12 sub-agent system overhauled.** `SubagentTypeDescriptor` gains `provider`, `provider_credentials_extras`, `parallel`, `max_concurrent`. `PipelineFactory` becomes parameterized over a `SubAgentBuildContext` carrying the parent's `CredentialBundle`. Orchestrator does mixed serial + parallel fan-out bounded by `asyncio.Semaphore(min(max_concurrent))`.
- **Fork-mode skills** can now route through any provider via `make_credential_bundle_fork_runner`.
- **Conformance harness** plus per-provider modules — 6 backends exercise the same capability-aware test surface.
- **CHANGELOG.md** carries the full 2.0.0 entry + migration notes.

Tests: **3235 passed, 8 skipped, 0 failed.**

### Geny side

- **Settings** gains multi-vendor API key fields (OpenAI / Google) and two new CLI backend configs (Claude Code, Copilot) that surface the full set of constructor knobs.
- **`CredentialBundleBuilder`** + **`SubagentRegistryBuilder`** turn live settings into the objects `Pipeline.from_manifest_async` consumes.
- **`AgentSessionManager`** stops requiring `ANTHROPIC_API_KEY`. It validates the manifest's Stage 6 provider has matching credentials and fails fast with a Korean message pointing the user at the right settings page when it doesn't.
- **Default manifest** Stage 6 lives at `config["provider"]`; Stage 12 orchestrator is `subagent_type` by default.
- **Real sub-agent factory** builds a slim 11-stage sub-pipeline using the descriptor's provider + parent's bundle. Five seed descriptors: worker / researcher / summarizer / critic / vtuber-narrator, each carrying a provider hint.
- **REST API** (`/api/llm-backends/*`): health probe (6 providers in parallel), Claude Code / Copilot CLI recheck endpoints, sub-agent listing.
- **Frontend modelCatalog** widens to 6 providers + capability hint metadata.
- **`LLMBackendsPanel`** in Settings — per-provider health card with re-check buttons that walk the user through Claude Code's two auth modes (API key or `claude auth login` subscription).
- **`scripts/migrate_manifests_provider_location.py`** — one-off migrator for stored manifests.

### End-to-end user flow this unlocks

1. User installs `claude` CLI on their machine.
2. Opens Settings → "Claude Code (CLI)" config card → toggles `enabled=True`.
3. Either pastes their `ANTHROPIC_API_KEY` *or* runs `claude auth login` in a terminal.
4. Goes to Settings → LLM Backends → hits Re-check. Card turns green.
5. Creates an Environment, sets Stage 6 provider to `claude_code_cli`.
6. Starts a VTuber or Worker session bound to that environment.
7. `AgentSessionManager` builds a `CredentialBundle` containing the `claude_code_cli` entry, hands it to the pipeline, and Stage 6 routes every LLM call through the local `claude` subprocess. Sub-agents inherit the bundle and can each pick a different provider via their descriptor's `provider` field.

## What went well

- **Phased rollout held up.** 20 PRs, each merged at a clean green-tests boundary. The progress tracker (with base + merge SHA) means any one PR can be reverted in isolation.
- **Capability-first design paid off.** Stage code never branches on provider name; CLI vs. API differences are encoded as capability flags. Adding new backends in the future (aider, ollama, …) is a one-class change.
- **PyPI publish before Geny consumes** kept the integration story clean — Geny pins a real version, not a `path =` dep.
- **CredentialBundle as a single channel** turned out to be more important than the new providers themselves. The silent-divergence bug between `config['provider']` and `strategies['provider']` was a footgun nobody had noticed; the bundle made it untenable.

## What we'd do differently

- **Test rewrite scope was bigger than estimated.** Phase A3 absorbed ~50 test updates because the old `APIStage(provider=MockProvider())` fixture pattern was load-bearing across the suite. Next time, budget an extra 30% time when an API surface change has wide test reach.
- **Sub-agent factories were deferred to E3** rather than landing alongside D1. That created a window where descriptor.provider existed but did nothing — fine in practice (placeholder factory raises NotImplementedError) but conceptually messy. A tighter coupling between descriptor field + factory would be clearer.
- **CLI binary version drift** is an ongoing risk. The stream-json schema Claude Code emits could change. The conformance suite uses a frozen fake CLI; a periodic live smoke run against the real binary would catch drift earlier.

## Deferred (intentionally)

- **Per-stage `provider_override` UI in the StageEditor.** The mechanism is in place (Stage 6's `config["provider_override"]`, `Stage.resolve_local_client`); the frontend just exposes the global provider for now. Pickable per-stage overrides land in a follow-up frontend cycle.
- **Dedicated Sub-agent Catalog page.** The seeds work, the API surfaces them (`GET /api/llm-backends/subagents`), but a CRUD UI for adding custom sub-agent descriptors is out of scope. Hosts add them via Python code today.
- **Daemon-mode CLI** (long-running subprocess for cost reduction). Spawn overhead is 200–600ms per call; if a host hits hot loops on the CLI backends, daemon-mode is the next optimisation.

## Open risks (post-cycle)

- **CLI subprocess concurrency on prod.** `max_concurrent=4` parallel CLI sub-agents can stress the host. Default sub-agent `max_concurrent` is 1; documented in the seeds.
- **Credential leakage.** `ProviderCredentials.__repr__` redacts `api_key`, but a stray `logger.info(bundle)` would still leak. We rely on convention, not a sealed type.
- **`claude auth status` subcommand surface is unstable.** The probe tries three forms (`auth status`, `auth whoami`, `--auth-status`) and falls back gracefully, but a vendor rename will require a chase.

## Final tally

| Phase | PRs | Repo |
|---|---|---|
| Plan docs | #773 | Geny |
| A — Foundation | #191 #192 #193 | executor |
| B — Claude Code CLI | #194 #195 #196 | executor |
| C — Copilot CLI | #197 #198 | executor |
| D — Sub-agent multi-provider | #199 #200 #201 #202 | executor |
| R — PyPI release | (publish) | executor |
| E — Geny wiring | #774 #775 #776 #777 #778 | Geny |
| F — Frontend + docs | #779 #780 #781 | Geny |

**20 PRs merged + 1 PyPI release. 3235+ tests green. Cycle closed.**
