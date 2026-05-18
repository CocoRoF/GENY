# Progress Tracker — LLM Backend Upgrade Cycle

> 본 사이클의 모든 PR을 PR별로 추적한다. 각 PR이 어느 baseline SHA에서 출발해 어느 merge SHA로 합쳐졌는지 기록 → 롤백 가능.

## Baseline (사이클 시작 시점)

| Repo | Branch | SHA | Notes |
|---|---|---|---|
| `geny-executor` | `main` | `474522a` | feat(memory): root _index.json is a bounded folder-tree summary (1.21.0) (#190) |
| `Geny` | `main` | `f81637a` | Merge pull request #772 from CocoRoF/feat/vtuber-screen-observation-skill |

자세한 baseline 정보 + 환경 변수 + 의존성 버전: [baseline.md](./baseline.md)

## Phase tracker

### Geny side (plan/progress 자체 commit)

| # | PR title | Branch | Repo | Status | Base SHA | Merge SHA | Progress file |
|---|---|---|---|---|---|---|---|
| 0 | docs: add LLM backend upgrade plan | `docs/llm-backend-upgrade-plan` | Geny | merged | f81637a | d67d09c | [00_plan_commit.md](./00_plan_commit.md) |

### Phase A — Foundation (executor)

| # | PR title | Branch | Repo | Status | Base SHA | Merge SHA | Progress file |
|---|---|---|---|---|---|---|---|
| A1 | feat(llm_client): extend capabilities, request/response, error categories | `feat/llm-backend/a1-capabilities-types-errors` | executor | merged | 474522a | 70e98c3 | [a1_capabilities_types_errors.md](./a1_capabilities_types_errors.md) |
| A2 | feat(llm_client): add _cli_runtime + credentials primitives | `feat/llm-backend/a2-cli-runtime-credentials` | executor | merged | 70e98c3 | 8261ed3 | [a2_cli_runtime_credentials.md](./a2_cli_runtime_credentials.md) |
| A3 | refactor(pipeline): unify provider location + CredentialBundle + conformance harness | `feat/llm-backend/a3-provider-unification` | executor | merged | 8261ed3 | 6fd3f02 | [a3_provider_unification.md](./a3_provider_unification.md) |

### Phase B — Claude Code CLI (executor)

| # | PR title | Branch | Status | Base SHA | Merge SHA | Progress file |
|---|---|---|---|---|---|---|
| B1 | feat(llm_client): translators/_cli.py for claude_code | `feat/llm-backend/b1-translators-claude-code` | merged | 6fd3f02 | 9fda0ac | [b1_translators_claude_code.md](./b1_translators_claude_code.md) |
| B2 | feat(llm_client): ClaudeCodeCLIClient | `feat/llm-backend/b2-claude-code-client` | merged | 9fda0ac | c54be88 | [b2_claude_code_client.md](./b2_claude_code_client.md) |
| B3 | test(llm_client): claude_code_cli conformance suite | `feat/llm-backend/b3-claude-code-conformance` | merged | c54be88 | 17b8468 | [b3_claude_code_conformance.md](./b3_claude_code_conformance.md) |

### Phase C — Copilot CLI (executor)

| # | PR title | Branch | Status | Base SHA | Merge SHA | Progress file |
|---|---|---|---|---|---|---|
| C1 | feat(llm_client): CopilotCLIClient + translators | `feat/llm-backend/c1-copilot-client` | merged | 17b8468 | f99d0d7 | [c1_copilot_client.md](./c1_copilot_client.md) |
| C2 | test(llm_client): copilot_cli conformance + CHANGELOG | `feat/llm-backend/c2-copilot-conformance` | merged | f99d0d7 | 20ca976 | [c2_copilot_conformance.md](./c2_copilot_conformance.md) |

### Phase D — Sub-agent multi-provider (executor)

| # | PR title | Branch | Status | Base SHA | Merge SHA | Progress file |
|---|---|---|---|---|---|---|
| D1 | refactor(s12_agent): SubagentTypeDescriptor + SubAgentBuildContext + new PipelineFactory | `feat/llm-backend/d1-subagent-descriptor` | merged | 20ca976 | d592273 | [d1_subagent_descriptor.md](./d1_subagent_descriptor.md) |
| D2 | feat(s12_agent): parallel orchestrator with semaphore | `feat/llm-backend/d2-subagent-parallel` | merged | d592273 | 85b226d | [d2_subagent_parallel.md](./d2_subagent_parallel.md) |
| D3 | feat(pipeline): subagent_registry slot + credential propagation | `feat/llm-backend/d3-pipeline-subagent` | merged | 85b226d | 2a41f53 | [d3_pipeline_subagent.md](./d3_pipeline_subagent.md) |
| D4 | refactor(skills/fork): multi-provider via CredentialBundle + CHANGELOG v2.0.0 | `feat/llm-backend/d4-fork-multi-provider` | merged | 2a41f53 | 1aa13d8 | [d4_fork_multi_provider.md](./d4_fork_multi_provider.md) |

### PyPI Release

| # | Action | Status | Notes | Progress file |
|---|---|---|---|---|
| R | Publish `geny-executor==2.0.0` to PyPI | **published** | 2026-05-17T13:40Z | [r_pypi_release.md](./r_pypi_release.md) |

### Phase E — Geny wiring

| # | PR title | Branch | Status | Base SHA | Merge SHA | Progress file |
|---|---|---|---|---|---|---|
| E1 | feat(settings): CLI backend sections + CredentialBundleBuilder + SubagentRegistryBuilder | `feat/llm-backend/e1-settings-credentials` | merged | 10e01d5 | 1fcf105 | [e1_settings_credentials.md](./e1_settings_credentials.md) |
| E2 | refactor(executor): AgentSessionManager + EnvironmentService for credentials/registry | `feat/llm-backend/e2-session-manager` | merged | 1fcf105 | 27dc25b | [e2_session_manager.md](./e2_session_manager.md) |
| E3 | refactor(manifest): rewrite default_manifest for unified provider location | `feat/llm-backend/e3-default-manifest` | merged | 27dc25b | f87e8c2 | [e3_default_manifest.md](./e3_default_manifest.md) |
| E4 | feat(api): health endpoint + Claude Code login + subagents routes | `feat/llm-backend/e4-health-routes` | merged | f87e8c2 | ee464eb | [e4_health_routes.md](./e4_health_routes.md) |
| E5 | ~~feat(scripts): migrate stored manifests~~ — **REVERTED** (cycle is a clean break — no migration ever needed) | `feat/llm-backend/e5-reseed` | rolled_back | ee464eb | merged 6f322ab → reverted | [e5_reseed.md](./e5_reseed.md) |

### Phase F — Frontend + polish (Geny)

| # | PR title | Branch | Status | Base SHA | Merge SHA | Progress file |
|---|---|---|---|---|---|---|
| F1 | feat(frontend): 6-provider catalog + capability badges | `feat/llm-backend/f1-frontend-catalog` | merged | 6f322ab | 160d9f9 | [f1_frontend_catalog.md](./f1_frontend_catalog.md) |
| F2 | feat(frontend): LLM Backends panel + Claude Code login UX | `feat/llm-backend/f2-frontend-editors` | merged | 160d9f9 | 1c8674b | [f2_frontend_editors.md](./f2_frontend_editors.md) |
| F3 | docs: cycle wrap-up + postmortem | `feat/llm-backend/f3-wrap-up` | merged | 1c8674b | dd3172e | [f3_wrap_up.md](./f3_wrap_up.md) |

### Phase G — Real Claude Code / Copilot auth in the Settings modal (follow-up)

User feedback after F2 landed: panel was view-only — needs clickable
cards, per-backend editor modals, and a real CLI-style login flow that
writes the canonical Pro/Max subscription credential. Plan in
[10_phase_g_real_auth.md](../10_phase_g_real_auth.md).

| # | PR title | Branch | Repo | Status | Base SHA | Merge SHA | Progress file |
|---|---|---|---|---|---|---|---|
| G0 | docs: phase G plan (real Claude Code auth modal) | `feat/llm-backend/g0-phase-plan` | Geny | pending | (post-2.0.1) | — | (this row) |
| G1 | Dockerfile claude CLI + docker-compose ~/.claude RW mount | `feat/llm-backend/g1-claude-cli-in-container` | Geny | pending | TBD | — | TBD |
| G2 | Backend auth endpoints (status/login/SSE/test/logout) + Copilot equivalents | `feat/llm-backend/g2-auth-endpoints` | Geny | pending | TBD | — | TBD |
| G3 | Frontend Claude Code modal — clickable card, 4 auth modes, live SSE | `feat/llm-backend/g3-claude-code-modal` | Geny | pending | TBD | — | TBD |
| G4 | Frontend Copilot modal | `feat/llm-backend/g4-copilot-modal` | Geny | pending | TBD | — | TBD |
| G5 | Frontend modals for the other 4 backends | `feat/llm-backend/g5-api-backend-modals` | Geny | pending | TBD | — | TBD |
| G6 | prod deploy + Max-plan billing verification | `feat/llm-backend/g6-prod-verify` | Geny | pending | TBD | — | TBD |

### Phase H — Consolidate LLM backend settings into the LLM Backends panel

User feedback after G6 landed: 전체설정 list still showed CLI backend
configs + API keys, duplicating the LLM Backends panel modals. Plan in
[11_phase_h_consolidate_llm_settings.md](../11_phase_h_consolidate_llm_settings.md).

| # | PR title | Branch | Repo | Status | Base SHA | Merge SHA | Progress file |
|---|---|---|---|---|---|---|---|
| H0 | feat(config): consolidate LLM backend settings into LLM Backends panel | `phase-h-consolidate-llm-settings` | Geny | merged | ac91da7 | 5eacbd3 (PR #793) | (this row) |

## Status legend

- **pending** — branch 미생성, 작업 미시작
- **in_progress** — branch 생성, 작업 중
- **pr_open** — PR 생성됨, review/merge 대기
- **merged** — PR 머지됨, 본 사이클 작업 항목 한 개 완료
- **rolled_back** — 머지 후 문제 발견하여 revert

## Rollback recipe

각 PR이 머지된 SHA가 적혀 있으면 다음으로 단일-PR 롤백 가능:

```bash
git revert <merge_sha> --no-edit
git push origin main
```

전체 사이클 롤백 (catastrophic 시):

```bash
# executor
cd /home/geny-workspace/geny-executor
git checkout main && git reset --hard 474522a   # baseline
git push origin main --force-with-lease         # 사용자 명시 승인 필요

# Geny
cd /home/geny-workspace/Geny
git checkout main && git reset --hard f81637a
git push origin main --force-with-lease         # 사용자 명시 승인 필요
```

> **주의:** force push는 destructive. 본 README에 적은 것은 *recipe*일 뿐, 실제 실행은 반드시 사용자 명시 승인 후.
