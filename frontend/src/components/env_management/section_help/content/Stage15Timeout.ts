/**
 * Help content for Stage 15 → Timeout slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'HITL timeout',
  summary:
    "What to do if the human doesn't respond within `timeout_seconds`. Pairs with the requester slot — the requester decides *how* to ask, the timeout decides *what to assume* if the answer doesn't come.",
  whatItDoes: `Most HITL workflows can't wait forever. The timeout slot defines the fallback decision when the human is unreachable, on lunch break, or just slow:

- **Indefinite** — wait forever. The pipeline blocks (callback) or stays suspended (pipeline_resume) until \`Pipeline.resume()\` is called manually.
- **Auto-approve** — after \`timeout_seconds\`, treat the request as approved and continue. Optimistic.
- **Auto-reject** — after \`timeout_seconds\`, treat as rejected. Pessimistic.

The choice depends on what the HITL request was *for*:

- "should I send this email?" → auto-reject is safer (don't send if not approved)
- "should I continue this task?" → auto-approve may be acceptable (default to continuing)
- "approve this $10K transaction?" → indefinite is correct (don't time-out money)`,
  options: [
    {
      id: 'indefinite',
      label: 'Indefinite (no timeout)',
      description: `Wait forever. No timeout fallback. The pipeline either blocks (with \`callback\` requester) or stays suspended (with \`pipeline_resume\` requester) until a human responds.

Choose this when ANY auto-decision is wrong — financial approvals, content moderation that must have human signoff, etc.`,
      bestFor: [
        'High-stakes approvals where time-out-as-decision is unacceptable',
        'Pipelines using `pipeline_resume` (no worker is blocked, so waiting forever is fine)',
      ],
      avoidWhen: [
        'Pipelines using `callback` — a worker is blocked the whole time. Use a finite timeout to free the worker eventually.',
      ],
      gotchas: [
        'When paired with `callback` requester, `indefinite` means workers can be tied up indefinitely. For long human reviews use `pipeline_resume` instead of `callback + indefinite`.',
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/timeouts.py:IndefiniteTimeout',
    },
    {
      id: 'auto_approve',
      label: 'Auto-approve',
      description: `After \`timeout_seconds\` of waiting, treat the request as **approved** and let the pipeline continue. Optimistic default — useful when the agent\'s judgment is usually fine and human review is just a safety check.

Pair with monitoring: log auto-approvals, review them post-hoc to catch any that shouldn\'t have been.`,
      bestFor: [
        'Low-stakes operations where stalling is worse than proceeding',
        'Pipelines where humans review *after* the fact, not before',
        'Workflows with downstream safety nets that catch mistakes',
      ],
      avoidWhen: [
        'High-stakes operations where the wrong default is expensive (irreversible actions, money, content publication)',
      ],
      config: [
        {
          name: 'timeout_seconds',
          label: 'Timeout (seconds)',
          type: 'number',
          default: '300',
          description:
            'How long to wait before auto-approving. 5 minutes (300s) is a typical starting point — long enough for a human to be paged, short enough not to stall production traffic.',
        },
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/timeouts.py:AutoApproveTimeout',
    },
    {
      id: 'auto_reject',
      label: 'Auto-reject',
      description: `After \`timeout_seconds\`, treat as **rejected**. Pessimistic default — agent stops, BLOCKED signal propagates, pipeline either retries with adjusted parameters (Stage 14 strategy) or terminates.

Use when the cost of doing-nothing-by-default is lower than the cost of doing-the-wrong-thing.`,
      bestFor: [
        'Agent operations that mutate external state (send messages, write files, charge cards)',
        'Compliance contexts where unsigned approvals are treated as denials',
        'Test pipelines where stalling on missing reviewers indicates a bug to investigate',
      ],
      avoidWhen: [
        'Pipelines where rejecting causes user-visible regression (chatbot stops responding because no one approved continuation)',
      ],
      config: [
        {
          name: 'timeout_seconds',
          label: 'Timeout (seconds)',
          type: 'number',
          default: '300',
          description:
            'Same as auto_approve — how long to wait before reaching the timeout decision.',
        },
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/timeouts.py:AutoRejectTimeout',
    },
  ],
  relatedSections: [
    {
      label: 'Requester (previous slot in this stage)',
      body: 'Pair these together: `callback + auto_approve` for "5min wait then proceed", `pipeline_resume + indefinite` for slow human review, etc.',
    },
    {
      label: 'Stage 8 — Adaptive thinking budget',
      body: '`state.metadata["needs_reflection"]` is sometimes set after a HITL timeout, signalling that the next turn should think harder. Stage 8\'s adaptive planner reads that flag.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s15_hitl/artifact/default/timeouts.py',
};

const ko: SectionHelpContent = {
  title: 'HITL 타임아웃',
  summary:
    '사람이 \`timeout_seconds\` 안에 응답하지 않을 때 무엇을 할지. Requester 슬롯과 짝 — requester 가 *어떻게* 묻는지, timeout 이 답이 안 오면 *무엇을 가정할지* 결정.',
  whatItDoes: `대부분의 HITL 워크플로는 영원히 못 기다림. Timeout 슬롯이 사람이 도달 불가, 점심 시간, 또는 단지 느릴 때 fallback 결정 정의:

- **Indefinite** — 영원히 기다림. 파이프라인이 차단 (callback) 또는 suspend 유지 (pipeline_resume) 까지 \`Pipeline.resume()\` 수동 호출.
- **Auto-approve** — \`timeout_seconds\` 후 승인된 것으로 취급하고 계속. 낙관적.
- **Auto-reject** — \`timeout_seconds\` 후 거부된 것으로 취급. 비관적.

선택은 HITL 요청이 무엇을 *위한* 지에 달림:

- "이 이메일 보내야 하나?" → auto-reject 가 더 안전 (승인 안 됐으면 보내지 마)
- "이 작업 계속해야 하나?" → auto-approve 수용 가능할 수 있음 (계속을 기본값)
- "이 $10K 트랜잭션 승인?" → indefinite 가 옳음 (돈을 timeout 하지 마)`,
  options: [
    {
      id: 'indefinite',
      label: '무한정 (Indefinite)',
      description: `영원히 기다림. Timeout fallback 없음. 파이프라인이 차단 (\`callback\` requester) 또는 suspend 유지 (\`pipeline_resume\` requester) — 사람이 응답할 때까지.

ANY 자동 결정이 잘못일 때 선택 — 금융 승인, 사람 signoff 가 필수인 콘텐츠 모더레이션 등.`,
      bestFor: [
        'time-out-as-decision 이 unacceptable 한 high-stakes 승인',
        '`pipeline_resume` 사용 파이프라인 (worker 가 차단 안 됨, 영원히 기다림 fine)',
      ],
      avoidWhen: [
        '`callback` 사용 파이프라인 — worker 가 그 전체 시간 차단. 결국 worker 를 free 하기 위해 finite timeout 사용.',
      ],
      gotchas: [
        '`callback` requester 와 짝 지어졌을 때 `indefinite` 는 worker 가 무제한으로 묶일 수 있음. 긴 사람 review 는 `callback + indefinite` 대신 `pipeline_resume` 사용.',
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/timeouts.py:IndefiniteTimeout',
    },
    {
      id: 'auto_approve',
      label: '자동 승인 (Auto-approve)',
      description: `\`timeout_seconds\` 의 wait 후 요청을 **승인**된 것으로 취급하고 파이프라인 계속하게 둠. 낙관적 기본값 — 에이전트의 판단이 보통 fine 이고 사람 review 가 단지 안전 체크일 때 유용.

모니터링과 짝: 자동 승인 로그, 사후 review 해서 안 됐어야 할 것 catch.`,
      bestFor: [
        'stalling 이 진행보다 나쁜 low-stakes 작업',
        '사람이 *후*에 review 하는 (전이 아닌) 파이프라인',
        '실수를 catch 하는 하류 안전망이 있는 워크플로',
      ],
      avoidWhen: [
        '잘못된 기본값이 비싼 high-stakes 작업 (되돌릴 수 없는 액션, 돈, 콘텐츠 게시)',
      ],
      config: [
        {
          name: 'timeout_seconds',
          label: 'Timeout (초)',
          type: 'number',
          default: '300',
          description:
            '자동 승인 전 wait 시간. 5분 (300s) 이 일반 시작점 — 사람이 페이징될 수 있을 만큼 길고, 프로덕션 트래픽 stall 안 할 만큼 짧음.',
        },
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/timeouts.py:AutoApproveTimeout',
    },
    {
      id: 'auto_reject',
      label: '자동 거부 (Auto-reject)',
      description: `\`timeout_seconds\` 후 **거부**된 것으로 취급. 비관적 기본값 — 에이전트 멈춤, BLOCKED 신호 전파, 파이프라인이 조정된 파라미터로 재시도 (14단계 전략) 또는 종료.

기본 무동작 비용이 잘못된-동작 비용보다 낮을 때 사용.`,
      bestFor: [
        '외부 state 를 변경하는 에이전트 작업 (메시지 보내기, 파일 쓰기, 카드 청구)',
        '서명 안 된 승인이 거부로 취급되는 컴플라이언스 컨텍스트',
        '누락된 reviewer 에서 stalling 이 조사할 버그를 나타내는 테스트 파이프라인',
      ],
      avoidWhen: [
        '거부가 사용자 가시 회귀 일으키는 파이프라인 (계속 승인 없어 챗봇이 응답 멈춤)',
      ],
      config: [
        {
          name: 'timeout_seconds',
          label: 'Timeout (초)',
          type: 'number',
          default: '300',
          description:
            'auto_approve 와 동일 — timeout 결정 도달 전 wait 시간.',
        },
      ],
      codeRef:
        'geny-executor / s15_hitl/artifact/default/timeouts.py:AutoRejectTimeout',
    },
  ],
  relatedSections: [
    {
      label: '요청자 (이 단계의 이전 슬롯)',
      body: '함께 짝: "5분 wait 후 진행" 은 `callback + auto_approve`, 느린 사람 review 는 `pipeline_resume + indefinite`, 등.',
    },
    {
      label: '8단계 — Adaptive thinking 예산',
      body: '`state.metadata["needs_reflection"]` 이 가끔 HITL timeout 후 설정 — 다음 턴이 더 열심히 생각해야 함을 신호. 8단계의 adaptive planner 가 그 플래그 읽음.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s15_hitl/artifact/default/timeouts.py',
};

export const stage15TimeoutHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
