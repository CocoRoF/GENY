/**
 * Help content for Stage 11 → Reviewer chain.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Reviewer chain',
  summary:
    "Per-call review of pending tool_use blocks. Runs *between* Stage 10's dispatch decision and actual execution — reviewers can flag, warn, or reject specific calls. Independent of Stage 4's coarse allow/block guard.",
  whatItDoes: `Stage 11 walks the chain top-to-bottom for **every pending tool call** in \`state.pending_tool_calls\`. Each reviewer inspects the call (name + input dict) and emits flags:

- **error** severity → call is rejected (becomes a tool_result with \`is_error: true\`)
- **warn** severity → logged but the call proceeds
- **none** → call passes cleanly

This is finer-grained than Stage 4's \`permission\` guard:

- Stage 4 reads \`state.pending_tool_calls\` and rejects the **whole turn** if any blocked tool is present
- Stage 11 reviews **per call** — a turn with mixed safe + risky calls can selectively flag the risky ones

Different reviewers ship for different concerns (regex pattern matching against tool input, severity-level checks, custom logic). Pipelines pick which to chain and in what order.

**The chain is empty by default.** With no reviewers, Stage 11 is effectively a no-op — every call passes. Add at least one reviewer for the stage to do anything.`,
  options: [],
  configFields: [],
  relatedSections: [
    {
      label: 'Stage 4 — permission guard',
      body: 'Stage 4 is the coarse, synchronous gate (whole-turn allow/block). Stage 11 is the per-call review. Use both for layered defense.',
    },
    {
      label: 'Stage 10 — Tool',
      body: 'Stage 10 dispatches calls; Stage 11 sits between dispatch decision and execution. Without Stage 11 in the chain, Stage 10 dispatches everything Stage 4 didn\'t block.',
    },
    {
      label: 'Stage 14 — Evaluate',
      body: 'Stage 14 may inspect `state.shared["tool_review_flags"]` (set by Stage 11) to decide whether the turn merits an evaluator pass. Stage 11 surfaces "this turn had concerning tool usage" as a signal.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s11_tool_review/artifact/default/',
};

const ko: SectionHelpContent = {
  title: '리뷰어 체인 (Reviewer chain)',
  summary:
    '대기 중인 tool_use 블록의 호출별 review. 10단계의 dispatch 결정과 실제 실행 *사이*에 실행 — reviewer 가 특정 호출을 flag, warn, 또는 거부 가능. 4단계의 coarse allow/block guard 와 독립.',
  whatItDoes: `11단계가 \`state.pending_tool_calls\` 의 **모든 대기 중인 도구 호출**에 대해 체인을 위에서 아래로 walk. 각 reviewer 가 호출 (name + input dict) 을 inspect 하고 플래그 emit:

- **error** severity → 호출 거부 (\`is_error: true\` 의 tool_result 가 됨)
- **warn** severity → 로그되지만 호출 진행
- **none** → 호출 깔끔하게 통과

4단계의 \`permission\` guard 보다 세밀:

- 4단계는 \`state.pending_tool_calls\` 를 읽고 차단된 도구가 있으면 **턴 전체** 거부
- 11단계는 **호출별** review — 안전 + 위험 호출이 섞인 턴이 위험한 것만 선택적 플래그 가능

다른 reviewer 가 다른 관심사용으로 ship (도구 input 에 대한 regex 패턴 매칭, severity 레벨 체크, 커스텀 로직). 파이프라인이 어떤 것을 어떤 순서로 chain 할지 선택.

**체인은 기본적으로 비어있음.** Reviewer 없이 11단계는 사실상 no-op — 모든 호출 통과. 단계가 무엇이든 하려면 최소 한 reviewer 추가.`,
  options: [],
  configFields: [],
  relatedSections: [
    {
      label: '4단계 — permission guard',
      body: '4단계는 coarse, 동기 게이트 (전체 턴 allow/block). 11단계는 호출별 review. 계층 방어를 위해 둘 다 사용.',
    },
    {
      label: '10단계 — Tool',
      body: '10단계가 호출 dispatch; 11단계가 dispatch 결정과 실행 사이에 위치. 체인에 11단계 없이 10단계는 4단계가 차단하지 않은 모든 것 dispatch.',
    },
    {
      label: '14단계 — Evaluate',
      body: '14단계가 `state.shared["tool_review_flags"]` (11단계가 설정) 을 inspect 해 턴이 evaluator pass 받을 만한지 결정 가능. 11단계가 "이 턴은 우려스러운 도구 사용이 있었다" 를 신호로 surface.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s11_tool_review/artifact/default/',
};

export const stage11ChainHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
