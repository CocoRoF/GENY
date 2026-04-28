/**
 * Help content for Stage 15 → Requester slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'HITL requester',
  summary:
    "How a human-in-the-loop request is *delivered* to the human. Stage 15's whole job is to halt the pipeline when a turn needs human input and resume it when the human responds — the requester is the delivery mechanism.",
  whatItDoes: `Stage 15 fires when a turn produces a HITL signal — typically:

- the LLM emitted a \`BLOCKED\` signal (Stage 9 detected it)
- a Stage 11 reviewer flagged a tool call as needing review
- the host explicitly set \`state.metadata["needs_hitl"]\`

The requester decides what to do *with* that need: notify a callback, suspend the pipeline so the host can resume it later, etc. The **timeout** slot decides what to do if the human doesn't respond fast enough.

**Manifest-named, host-attached.** Most requesters expose a callback or hook that the manifest can name but only the host can install. Picking \`callback\` from the manifest without wiring the callback at \`Pipeline.attach_runtime()\` makes Stage 15 a no-op — the request is "sent" to nothing.`,
  options: [
    {
      id: 'null',
      label: 'None',
      description: `No HITL handling. Stage 15 is effectively bypassed — even if a turn signals BLOCKED, no request is made and the pipeline either continues (if Stage 16 lets it) or terminates with the BLOCKED signal.

Default for pipelines that don't have a human in the loop.`,
      bestFor: [
        'Fully autonomous agents — no human, no requests',
        'Sandboxed test pipelines',
      ],
      avoidWhen: [
        'Production pipelines that genuinely need human approval for some actions — `null` swallows those requests silently',
      ],
      gotchas: [
        '`null` does NOT prevent BLOCKED signals from being detected; it just means Stage 15 won\'t do anything about them.',
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/requesters.py:NullRequester',
    },
    {
      id: 'callback',
      label: 'Callback',
      description: `Calls a host-provided callback function with the HITL request payload. The callback is responsible for delivering the request to the human (Slack DM, web UI prompt, email, etc.) and returning a decision.

**Synchronous behaviour** — the callback is awaited before the pipeline continues. If your callback shows a UI and waits for the human to click "approve", the pipeline blocks for that long.`,
      bestFor: [
        'Web app pipelines — callback shows a modal, waits for user click, returns decision',
        'Internal tooling — callback posts to Slack, awaits a reaction',
        'Pipelines where waiting for the human is the desired behaviour',
      ],
      avoidWhen: [
        'You can\'t wait — the callback may take minutes or hours and the pipeline blocks the entire time. Use `pipeline_resume` instead.',
        'You don\'t have a callback to attach — it\'s a no-op without the host wiring.',
      ],
      gotchas: [
        '**Host-side callback required.** Manifest can name `callback` but only `Pipeline.attach_runtime(hitl_callback=...)` installs the actual function.',
        'Long-running blocks can blow Stage 4\'s wall-clock budgets if you\'ve set them. The wait is invisible to wall-clock guards.',
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/requesters.py:CallbackRequester',
    },
    {
      id: 'pipeline_resume',
      label: 'Pipeline resume',
      description: `**Suspends the pipeline**. The current state is snapshotted, a HITL token is generated, and Stage 15 returns the token to the host. The host stores the snapshot, delivers the request out-of-band (email, ticket, etc.), and later calls \`Pipeline.resume(token, decision)\` to continue.

This is the right pattern for slow human reviews — the pipeline doesn't tie up a worker waiting; it goes dormant and resumes when the human gets back.`,
      bestFor: [
        'Long-form approval workflows where humans may take hours or days',
        'Email / ticket-based escalation paths',
        'Resource-constrained backends that can\'t afford to block workers',
      ],
      avoidWhen: [
        'You don\'t have suspension/resume infrastructure — the host must store snapshots and call `resume()` for this pattern to work',
        'The human review is fast (seconds-to-minutes) — `callback` is simpler',
      ],
      gotchas: [
        'Resume requires the **same manifest version** that suspended. Manifest changes between suspend and resume can break state restoration.',
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/requesters.py:PipelineResumeRequester',
    },
  ],
  relatedSections: [
    {
      label: 'Timeout (next slot in this stage)',
      body: 'Timeout decides what happens if the human doesn\'t respond fast enough. Pair `callback` with `auto_approve` for "wait 5min then proceed", or `pipeline_resume` with `indefinite` for "wait forever".',
    },
    {
      label: 'Stage 9 — BLOCKED signal',
      body: 'Stage 15 fires when Stage 9 detects a `BLOCKED` signal in the response. Without that signal source, Stage 15 only fires on host-set `needs_hitl` flags.',
    },
    {
      label: 'Stage 11 — Tool review',
      body: 'Stage 11 reviewers can flag calls as `needs_hitl` severity, which propagates to Stage 15. This is how you build "any high-risk tool call requires human approval" workflows.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s15_hitl/artifact/default/requesters.py',
};

const ko: SectionHelpContent = {
  title: 'HITL 요청자 (Requester)',
  summary:
    'Human-in-the-loop 요청을 사람에게 *어떻게 전달*할지. 15단계의 전체 일은 턴이 사람의 입력을 필요로 할 때 파이프라인을 멈추고 사람이 응답할 때 재개하는 것 — requester 가 전달 메커니즘.',
  whatItDoes: `15단계는 턴이 HITL 신호를 생산할 때 발화 — 일반적으로:

- LLM 이 \`BLOCKED\` 신호 emit (9단계가 감지)
- 11단계 reviewer 가 도구 호출을 review 필요로 플래그
- 호스트가 명시적으로 \`state.metadata["needs_hitl"]\` 설정

Requester 가 그 필요로 무엇을 할지 결정: callback 알림, 호스트가 나중에 재개할 수 있도록 파이프라인 suspend, 등. **Timeout** 슬롯이 사람이 충분히 빨리 응답하지 않을 때 무엇을 할지 결정.

**매니페스트가 명명, 호스트가 attach.** 대부분의 requester 는 매니페스트가 명명할 수 있지만 호스트만 설치할 수 있는 callback 또는 hook 노출. \`Pipeline.attach_runtime()\` 에서 callback 을 wire 하지 않고 매니페스트에서 \`callback\` 선택은 15단계를 no-op 으로 만듦 — 요청이 아무것도 아닌 곳으로 "전송".`,
  options: [
    {
      id: 'null',
      label: '없음',
      description: `HITL 처리 없음. 15단계 사실상 우회 — 턴이 BLOCKED 신호해도 요청이 만들어지지 않고 파이프라인은 (16단계가 허용하면) 계속하거나 BLOCKED 신호로 종료.

루프에 사람이 없는 파이프라인의 기본값.`,
      bestFor: [
        '완전 자율 에이전트 — 사람 없음, 요청 없음',
        '샌드박스 테스트 파이프라인',
      ],
      avoidWhen: [
        '특정 액션에 진짜 사람 승인이 필요한 프로덕션 파이프라인 — `null` 은 그 요청을 silent 하게 swallow',
      ],
      gotchas: [
        '`null` 이 BLOCKED 신호 감지를 막지 않음; 단지 15단계가 그것에 대해 아무것도 안 한다는 뜻.',
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/requesters.py:NullRequester',
    },
    {
      id: 'callback',
      label: '콜백 (Callback)',
      description: `호스트 제공 callback 함수를 HITL 요청 페이로드와 함께 호출. Callback 이 사람에게 요청 전달 (Slack DM, 웹 UI prompt, 이메일 등) 과 결정 반환을 책임.

**동기 동작** — 파이프라인 계속 전 callback 을 await. Callback 이 UI 보여주고 사람이 "approve" 클릭 기다리면 파이프라인이 그동안 차단.`,
      bestFor: [
        '웹 앱 파이프라인 — callback 이 모달 보여주고 사용자 클릭 기다리고 결정 반환',
        '내부 도구 — callback 이 Slack 에 게시, 반응 await',
        '사람을 기다리는 것이 원하는 동작인 파이프라인',
      ],
      avoidWhen: [
        '기다릴 수 없을 때 — callback 이 분 또는 시간 걸릴 수 있고 파이프라인이 그 전체 시간 차단. `pipeline_resume` 사용.',
        'attach 할 callback 이 없을 때 — 호스트 wiring 없이 no-op.',
      ],
      gotchas: [
        '**호스트 측 callback 필요.** 매니페스트가 `callback` 명명 가능하지만 `Pipeline.attach_runtime(hitl_callback=...)` 만 실제 함수 설치.',
        '오래 차단은 설정한 4단계의 wall-clock 예산을 폭파 가능. wait 는 wall-clock guard 에 보이지 않음.',
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/requesters.py:CallbackRequester',
    },
    {
      id: 'pipeline_resume',
      label: '파이프라인 재개 (Pipeline resume)',
      description: `**파이프라인 suspend.** 현재 state 스냅샷, HITL 토큰 생성, 15단계가 호스트에 토큰 반환. 호스트가 스냅샷 저장, out-of-band 로 요청 전달 (이메일, 티켓 등), 나중에 \`Pipeline.resume(token, decision)\` 호출해 계속.

느린 사람 review 의 옳은 패턴 — 파이프라인이 기다리며 worker 묶지 않음; 휴면 가고 사람이 돌아오면 재개.`,
      bestFor: [
        '사람이 시간 또는 일 걸릴 수 있는 long-form 승인 워크플로',
        '이메일 / 티켓 기반 에스컬레이션 경로',
        'worker 차단 못 하는 자원 제약 백엔드',
      ],
      avoidWhen: [
        'suspension/resume 인프라 없을 때 — 호스트가 스냅샷 저장하고 `resume()` 호출해야 이 패턴 작동',
        '사람 review 가 빠를 때 (초~분) — `callback` 이 더 단순',
      ],
      gotchas: [
        'Resume 은 suspend 한 **같은 매니페스트 버전** 필요. Suspend 와 resume 사이 매니페스트 변경이 state 복원 깰 수 있음.',
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/requesters.py:PipelineResumeRequester',
    },
  ],
  relatedSections: [
    {
      label: 'Timeout (이 단계의 다음 슬롯)',
      body: 'Timeout 이 사람이 충분히 빨리 응답 안 할 때 무엇이 일어날지 결정. "5분 기다리고 진행" 은 `callback` + `auto_approve`, "영원히 기다림" 은 `pipeline_resume` + `indefinite`.',
    },
    {
      label: '9단계 — BLOCKED 신호',
      body: '15단계가 9단계가 응답에서 `BLOCKED` 신호 감지할 때 발화. 그 신호 소스 없이 15단계는 호스트가 설정한 `needs_hitl` 플래그에만 발화.',
    },
    {
      label: '11단계 — Tool review',
      body: '11단계 reviewer 가 호출을 `needs_hitl` severity 로 플래그 가능, 15단계로 전파. "고위험 도구 호출은 사람 승인 필요" 워크플로 빌드 방법.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s15_hitl/artifact/default/requesters.py',
};

export const stage15RequesterHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
