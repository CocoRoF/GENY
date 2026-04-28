/** Tool detail — Agent (executor / agent family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `Agent spawns a sub-agent — a fresh \`AgentSession\` running its own pipeline with its own context window, model, and tool subset. The parent waits for the sub-agent to finish, gets its final output as a string, and continues.

Sub-agents are typed via \`SubagentTypeRegistry\`. The \`subagent_type\` argument names a registered descriptor that bundles description, allowed tools, optional model_override, and (optionally) a binding to a Skill that defines the sub-agent's actual instructions. The registry lives at \`stages/s12_agent/subagent_type.py\` — every host can register its own types.

Three reasons to spawn a sub-agent rather than handle a task inline:

  1. **Context isolation**: the sub-agent gets a clean context window. Long research / analysis tasks that would otherwise blow up the parent's window run cheaper and with better quality when fanned out.

  2. **Tool narrowing**: the descriptor's allowed_tools list whitelists what the sub-agent can call. A safe-mode reviewer sub-agent might only see Read / Grep, never Bash / Write — even if the parent has them.

  3. **Model scaling**: \`model_override\` lets the sub-agent run on a heavier or cheaper model. Common patterns: heavy reasoning sub-task on Opus while the parent stays on Sonnet, or background classification on Haiku while the parent uses Sonnet for orchestration.

The sub-agent's output is a string. If you need structured data, the descriptor / Skill should instruct the sub-agent to return JSON; the parent parses it.`,
  bestFor: [
    'Long research or analysis where the parent\'s context would otherwise overflow',
    'Sub-tasks needing a different (heavier or cheaper) model tier',
    'Compartmentalised work where the sub-agent should only see a subset of tools',
    'Orchestrator agents that fan out structured sub-tasks (review / draft / classify)',
  ],
  avoidWhen: [
    'High-frequency calls — session spawn cost adds up; consider an inline Skill instead',
    'Simple template substitutions — Skill in inline mode is cheaper',
    'Cases where the parent already has all necessary context — fanning out wastes the prompt cache',
  ],
  gotchas: [
    'Sub-agent output is a single string. For structured data, instruct the sub-agent to return JSON and parse on the parent side.',
    'The sub-agent runs the SAME pipeline (manifest) by default. If you need a different stage layout, register a custom subagent_type.',
    '`allowed_tools` is the sub-agent\'s ceiling, not its floor — if the manifest doesn\'t include a tool, putting it in the descriptor doesn\'t enable it.',
    'Sub-agent failures bubble up as tool errors. Plan for retry / graceful-degradation in the parent\'s prompt.',
  ],
  examples: [
    {
      caption: 'Spawn a code-review sub-agent on a PR diff',
      body: `{
  "subagent_type": "code-review",
  "task": "Review the diff at /tmp/pr-diff.patch for security issues and style violations. Return JSON: {issues: [{severity, file, line, summary}]}."
}`,
      note: 'Sub-agent runs with its own context, returns a JSON string the parent parses.',
    },
  ],
  relatedTools: ['ToolSearch'],
  relatedStages: [
    'Stage 12 (Agent / Orchestrator)',
    'Stage 13 (Task registry)',
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/agent_tool.py:AgentTool',
};

const ko: ToolDetailContent = {
  body: `Agent는 sub-agent를 spawn합니다 — 자체 컨텍스트 창, 모델, 도구 서브셋을 가지고 자체 파이프라인을 실행하는 새 \`AgentSession\`. 부모는 sub-agent가 끝날 때까지 대기, 최종 출력을 문자열로 받고 계속.

Sub-agent는 \`SubagentTypeRegistry\`로 typed됩니다. \`subagent_type\` 인자가 등록된 descriptor 이름이며, descriptor는 description, allowed_tools, 선택적 model_override, 그리고 (선택적으로) sub-agent의 실제 instruction을 정의하는 Skill 바인딩을 묶습니다. registry는 \`stages/s12_agent/subagent_type.py\`에 위치 — 모든 호스트가 자체 타입을 등록 가능.

작업을 인라인으로 처리하지 않고 sub-agent를 spawn하는 세 가지 이유:

  1. **컨텍스트 격리**: sub-agent가 깨끗한 컨텍스트 창을 받음. 부모의 창을 폭발시킬 긴 리서치 / 분석 작업이 fan-out 시 더 저렴하고 품질도 좋게 실행.

  2. **도구 좁히기**: descriptor의 allowed_tools 리스트가 sub-agent가 호출 가능한 것을 화이트리스트. safe-mode reviewer sub-agent는 부모가 Bash / Write를 가져도 Read / Grep만 보게 가능.

  3. **모델 스케일링**: \`model_override\`로 sub-agent가 더 무겁거나 저렴한 모델로 실행. 흔한 패턴: 부모는 Sonnet, 어려운 추론 sub-task는 Opus; 부모는 오케스트레이션에 Sonnet, 백그라운드 분류는 Haiku.

Sub-agent 출력은 문자열. 구조화된 데이터가 필요하면 descriptor / Skill이 sub-agent에게 JSON 반환 지시; 부모가 파싱.`,
  bestFor: [
    '부모의 컨텍스트가 오버플로할 긴 리서치 / 분석',
    '다른(더 무겁거나 저렴한) 모델 티어가 필요한 sub-task',
    'sub-agent가 도구 서브셋만 봐야 하는 격리 작업',
    '구조화된 sub-task(리뷰 / 초안 / 분류)를 fan-out하는 오케스트레이터 에이전트',
  ],
  avoidWhen: [
    '고빈도 호출 — 세션 spawn 비용이 누적; 인라인 Skill 고려',
    '단순 템플릿 치환 — 인라인 모드 Skill이 더 저렴',
    '부모가 이미 필요한 모든 컨텍스트를 가진 경우 — fan-out이 prompt cache 낭비',
  ],
  gotchas: [
    'Sub-agent 출력은 단일 문자열. 구조화 데이터 필요 시 sub-agent에게 JSON 반환 지시 후 부모 측에서 파싱.',
    'Sub-agent는 기본적으로 같은 파이프라인(매니페스트) 실행. 다른 stage layout 필요 시 커스텀 subagent_type 등록.',
    '`allowed_tools`는 sub-agent의 상한, 하한 아님 — 매니페스트가 도구를 포함하지 않으면 descriptor에 넣어도 활성화 안 됨.',
    'Sub-agent 실패는 도구 에러로 bubble up. 부모 프롬프트에서 retry / graceful-degradation 계획.',
  ],
  examples: [
    {
      caption: 'PR diff에 code-review sub-agent spawn',
      body: `{
  "subagent_type": "code-review",
  "task": "/tmp/pr-diff.patch의 diff를 보안 이슈와 스타일 위반에 대해 리뷰. JSON 반환: {issues: [{severity, file, line, summary}]}."
}`,
      note: 'Sub-agent가 자체 컨텍스트로 실행, 부모가 파싱할 JSON 문자열 반환.',
    },
  ],
  relatedTools: ['ToolSearch'],
  relatedStages: [
    '12단계 (Agent / 오케스트레이터)',
    '13단계 (Task registry)',
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/agent_tool.py:AgentTool',
};

export const agentToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
