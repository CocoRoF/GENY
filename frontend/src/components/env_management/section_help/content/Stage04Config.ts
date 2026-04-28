/**
 * Help content for Stage 4 → stage-level config card (fail_fast +
 * max_chain_length).
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Guard stage settings',
  summary:
    "Two stage-level knobs: how strictly the chain reports failures (`fail_fast`) and a defensive cap on chain length (`max_chain_length`).",
  whatItDoes: `Stage 4 runs an ordered list of guards (the **Guards chain** below). The two settings here control how that chain *behaves*, not what's in it:

- \`fail_fast\` — when true (default), the chain stops on the first guard that returns \`passed=False\` and the stage raises \`GuardRejectError\`. When false, every guard runs and failures are aggregated; the first failure still wins for the rejection message, but events fire for the rest.
- \`max_chain_length\` — a sanity cap. Manifests with more than this many guards in the chain are rejected at restore-time. Defaults to 32 — well above what any real pipeline needs.

These never apply at LLM time — Stage 4 finishes (or rejects) before Stage 6 (API) runs.`,
  configFields: [
    {
      name: 'config.fail_fast',
      label: 'Fail fast',
      type: 'boolean',
      default: 'true',
      description:
        'When **true**, the chain short-circuits on the first failing guard. When **false**, every guard runs and you can inspect the full failure set via `guard.check` events. The first failure still wins the rejection — the difference is purely whether the rest of the chain executes.',
    },
    {
      name: 'config.max_chain_length',
      label: 'Max chain length',
      type: 'integer',
      default: '32',
      description:
        'Hard cap on the number of guards the chain can hold. Defaults to 32 — no production pipeline reaches this naturally, so it functions as a manifest sanity check rather than a tuning knob.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Guards chain (this stage)',
      body: 'The chain itself — what guards run, in what order, with what config. fail_fast / max_chain_length are about the chain *behaviour*, not its contents.',
    },
    {
      label: 'Stage 1 — Input validator',
      body: 'Per-turn input shape checks live in Stage 1, not here. Stage 4 is for **cross-turn** budget / permission concerns.',
    },
    {
      label: 'Stage 16 — Loop',
      body: 'Iteration / cost / token budgets are also checked at the loop layer (Stage 16). Stage 4 rejects this turn; Stage 16 decides whether to loop again. They overlap deliberately — defense in depth.',
    },
  ],
  codeRef:
    'geny-executor / s04_guard/artifact/default/stage.py:GuardStage.update_config',
};

const ko: SectionHelpContent = {
  title: '가드 단계 설정 (Guard stage settings)',
  summary:
    '두 가지 단계 레벨 knob: 체인이 실패를 얼마나 엄격하게 보고할지 (\`fail_fast\`) 와 체인 길이의 방어적 cap (\`max_chain_length\`).',
  whatItDoes: `4단계는 순서가 있는 guards 리스트 (아래 **가드 체인**) 를 실행합니다. 여기 두 설정은 그 체인이 *어떻게 동작*할지 — 무엇이 들어있는지가 아닌 — 를 제어:

- \`fail_fast\` — true (기본값) 일 때, 체인은 \`passed=False\` 를 반환하는 첫 guard 에서 멈추고 단계가 \`GuardRejectError\` 발생. false 일 때, 모든 guard 가 실행되고 실패가 집계됨; 첫 실패가 여전히 거부 메시지를 이김, 이벤트는 나머지에 대해 발화.
- \`max_chain_length\` — sanity cap. 체인에 이 개수보다 많은 guard 가 있는 매니페스트는 restore 시점에 거부. 기본값 32 — 어떤 실제 파이프라인이 필요한 것보다 훨씬 많음.

이들은 LLM 시점에 적용되지 않음 — 4단계가 6단계 (API) 가 실행되기 전에 끝나거나 (또는 거부).`,
  configFields: [
    {
      name: 'config.fail_fast',
      label: '즉시 중단 (Fail fast)',
      type: 'boolean',
      default: 'true',
      description:
        '**true** 일 때, 체인이 첫 실패 guard 에서 short-circuit. **false** 일 때, 모든 guard 가 실행되고 `guard.check` 이벤트로 전체 실패 집합을 inspect 할 수 있음. 첫 실패가 여전히 거부 이김 — 차이는 순전히 나머지 체인이 실행되는지 여부.',
    },
    {
      name: 'config.max_chain_length',
      label: '최대 체인 길이',
      type: 'integer',
      default: '32',
      description:
        '체인이 보유할 수 있는 guard 수의 hard cap. 기본값 32 — 어떤 프로덕션 파이프라인도 자연스럽게 이에 도달하지 않으므로, 튜닝 knob 보다는 매니페스트 sanity check 로 기능.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: '가드 체인 (이 단계)',
      body: '체인 자체 — 어떤 guard 가, 어떤 순서로, 어떤 config 로 실행되는지. fail_fast / max_chain_length 는 체인의 *동작*에 관한 것, 내용에 관한 것이 아님.',
    },
    {
      label: '1단계 — 입력 검증기',
      body: '턴별 입력 모양 검사는 여기가 아닌 1단계에서. 4단계는 **턴 간** 예산 / 권한 관심사용.',
    },
    {
      label: '16단계 — Loop',
      body: '반복 / 비용 / 토큰 예산은 루프 레이어 (16단계) 에서도 체크. 4단계는 이번 턴을 거부; 16단계는 다시 루프할지 결정. 의도적으로 중첩 — defense in depth.',
    },
  ],
  codeRef:
    'geny-executor / s04_guard/artifact/default/stage.py:GuardStage.update_config',
};

export const stage04ConfigHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
