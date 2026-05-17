# LLM Backend Upgrade Plan

> **Cycle:** `llm-backend-upgrade-plan`
> **Status:** Plan locked — ready for implementation
> **Repos in scope:** `geny-executor` (framework), `Geny` (consumer service)
> **Goal:** Build a clean, production-grade, capability-negotiating LLM backend layer that supports any "model-as-runner" — Anthropic / OpenAI / Google APIs, vLLM, **Claude Code CLI**, **GitHub Copilot CLI** — through a single contract that the 21-stage pipeline and the Stage 12 multi-agent system consume uniformly.

## Philosophy

> `geny-executor`는 **일반화된 강력한 Framework**.
> `Geny`는 그 Framework를 **사용하는 서비스**.

이 분리를 깨지 않는 것이 1원칙이다:

- **모든 LLM 추상화는 `geny-executor`에 산다.** `BaseClient`, capability 협상, CLI 프로세스 관리, sub-agent spawn 메커니즘, 자격증명 번들 — 전부 라이브러리.
- **Geny는 선택과 설정만 한다.** manifest 정의, settings 섹션, 자격증명 주입, frontend UI.
- Geny가 executor 내부 분기를 알 필요 없어야 한다. `manifest.stages[N].config["provider"]` 문자열과 `CredentialBundle`만 넘기면 executor가 알아서 모든 stage와 모든 sub-agent를 라우팅.

## Clean break

본 사이클은 **프로덕션 서비스 진입 전 단계**다. 따라서:

- **back-compat shim 없음.** `Pipeline.from_manifest_async(api_key=...)`은 제거하고 `credentials=CredentialBundle` 단일 시그니처.
- **migrator 없음.** 기존 manifest는 새 schema로 *재작성*.
- **legacy 분기 없음.** `strategies["provider"]`는 완전 제거. `ProviderBackedClient` 브리지도 정리.
- **placeholder factory 없음.** Geny의 `_placeholder_factory(NotImplementedError)` 라인은 실제 구현으로 교체.

깨끗한 코드 우선. "옛 호출자가 깨질까봐 두 위치 모두 인정" 같은 타협은 안 한다.

## Documents

| # | File | Purpose |
|---|------|---------|
| 00 | [overview.md](./00_overview.md) | 비전, 범위, 원칙, 성공 기준 |
| 01 | [current_state.md](./01_current_state.md) | 두 레포 + CLI surface + provider 위치 분리 + sub-agent 현황 audit |
| 02 | [target_architecture.md](./02_target_architecture.md) | 도달 상태 — 통일된 provider, sub-agent multi-provider, CredentialBundle |
| 03 | [executor_changes.md](./03_executor_changes.md) | `geny-executor`: BaseClient/Capabilities 확장, CLI clients, sub-agent factory 재설계, provider unification |
| 04 | [geny_changes.md](./04_geny_changes.md) | `Geny`: settings sections, credentials, default manifest 재작성, sub-agent factory 실구현, frontend 카탈로그 |
| 05 | [sub_agent_system.md](./05_sub_agent_system.md) | Stage 12 multi-agent 메커니즘 deep-dive + multi-provider 설계 |
| 06 | [stage_compatibility.md](./06_stage_compatibility.md) | 21-stage × 6-backend × capability 매트릭스 + degradation policy |
| 07 | [rollout_phases.md](./07_rollout_phases.md) | 6 phase / ~20 PR 단계별 작업 정의 |
| 08 | [testing_strategy.md](./08_testing_strategy.md) | unit / conformance / sub-agent / integration 테스트 plan |
| 09 | [open_questions.md](./09_open_questions.md) | 잔여 결정 사항 (대부분 lock됨) |

## Reading order

- **첫 독자:** `00 → 01 → 02 → 05 → 07` 흐름.
- **Executor 작업자:** `02 → 03 → 05` 후 `07`의 Phase A~D.
- **Geny 작업자:** `02 → 04` 후 `07`의 Phase E~F.
- **리뷰어:** `00 → 09 → 07`.

## 핵심 변경 요약 (5줄)

1. `BaseClient.capabilities`에 9개 신규 필드 (structured_output, session_continuity, mcp_passthrough, budget_limit, cost_usage, is_subprocess, requires_workspace, streaming_granularity, supports_token_usage).
2. 신규 클라이언트 2종: `ClaudeCodeCLIClient`, `CopilotCLIClient` — 공용 `_cli_runtime.py`의 async subprocess primitives 사용.
3. `CredentialBundle`이 `api_key: str` 단일 인자를 대체. 자격증명을 provider별로 묶어서 전달.
4. **Provider 저장 위치를 `config["provider"]`로 통일.** `strategies["provider"]` 제거.
5. **Stage 12 sub-agent가 진짜로 동작.** `SubagentTypeDescriptor`에 `provider` 필드 + `PipelineFactory`를 parameterizable하게 변경 + Geny placeholder factory를 실구현으로 교체 + asyncio.gather 기반 병렬 옵션. fork-mode skill도 multi-provider화.

## 핵심 비-목표 (non-goals)

- 새로운 vendor API 추가 (Mistral 등) — 별도 사이클.
- CLI 백엔드 daemon-mode (long-running subprocess) — 후속 사이클.
- 21-stage 자체 구조 리팩토링 — manifest consume 방식만 변경, stage shape은 안 건드림.
- Browser/computer-use 같은 새 모달리티.
