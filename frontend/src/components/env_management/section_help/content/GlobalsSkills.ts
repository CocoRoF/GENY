/**
 * Help content for Globals → Skills panel.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Skills (host-level)',
  summary:
    'Lightweight workflow definitions stored as `SKILL.md` files with YAML frontmatter. The agent dispatches via the Skill tool — either inline (the body executes in the current turn) or fork-mode (spawns a typed sub-agent). Host-scoped catalog at `~/.geny/skills/` and project-level `skills/`.',
  whatItDoes: `Skills are reusable agent workflows — somewhere between a prompt template and a sub-agent. Each skill is a markdown file with frontmatter:

\`\`\`markdown
---
name: code-review
description: Review a PR for security and style issues
tools: [Read, Grep, Bash]
model_override: claude-opus-4-7
---

You are a senior reviewer. For the PR at <args.pr_url>:
1. Identify security issues
2. Check style consistency
...
\`\`\`

**Frontmatter fields**:

- \`name\`: registry key. Must be unique across the merged catalog.
- \`description\`: one-line summary, used by ToolSearch and the LLM's tool-selection logic.
- \`tools\`: optional whitelist — restricts which tools the skill body may call. \`null\` = inherits the parent's full toolset.
- \`model_override\`: optional model id — runs the skill with a different model than the parent (e.g., a heavier model for a hard sub-task).

**Dispatch modes** (set on the skill frontmatter or by the agent at call time):

- **Inline**: skill body is appended to the current turn's prompt. Cheap, shares context, agent's tools available. Best for "give me a templated thing" workflows.
- **Fork**: skill spawns a fresh \`AgentSession\` with a typed contract. Isolated context, configurable model, output returned to parent. Best for sub-tasks that benefit from clean state or a different model tier.

**Catalog discovery** (at session boot):

1. Scan \`~/.geny/skills/**/SKILL.md\` (user scope).
2. Scan \`./.geny/skills/**/SKILL.md\` (project scope).
3. Scan \`./skills/**/SKILL.md\` if present (legacy / repo-shared).
4. Optionally bridge MCP server prompts via \`mcp_prompts_to_skills(manager)\` — each prompt becomes a Skill record with \`extras = {source: "mcp", server, prompt_name}\`.

Project-scope wins on name collisions. The Library Skills tab edits the active scope.

**How the agent reaches them**:

- The \`Agent\` built-in tool can spawn a sub-agent and pass a skill name as the dispatch instruction.
- The \`Skill\` built-in tool (when registered) directly invokes a skill by name with optional args.
- \`ToolSearch\` surfaces skills as a discoverable capability — the agent finds them by description, not just by knowing the name.

**vs. system prompt**: the system prompt is monolithic (one block for every turn). Skills are modular (one block per dispatch). System prompt sets identity / hard constraints; skills package up named workflows.`,
  configFields: [
    {
      name: 'name',
      label: 'name (frontmatter)',
      type: 'string',
      required: true,
      description:
        'Registry key. Must be unique across the merged catalog. Stable identifier — renaming breaks any agent / hook / cron entry referencing the old name.',
    },
    {
      name: 'description',
      label: 'description (frontmatter)',
      type: 'string',
      required: true,
      description:
        'One-line summary. Surfaced to the LLM via ToolSearch and the skill listing — what the model sees when deciding whether to invoke this skill.',
    },
    {
      name: 'tools',
      label: 'tools (frontmatter)',
      type: 'list[string]',
      description:
        'Optional tool allowlist for the skill body. Null inherits the parent\'s full toolset. Use to lock down a sub-agent that should only Read / Grep, not Write / Bash.',
    },
    {
      name: 'model_override',
      label: 'model_override (frontmatter)',
      type: 'string',
      description:
        'Optional model id. Lets a skill run on a heavier (or cheaper) model than the parent. Only honoured in fork mode — inline skills always share the parent model.',
    },
    {
      name: 'extras',
      label: 'extras (frontmatter)',
      type: 'dict',
      description:
        'Free-form metadata. Used by hooks / tooling for routing — e.g., MCP-projected skills carry `source: "mcp"`, `server`, `prompt_name` here.',
    },
    {
      name: 'body',
      label: 'body (markdown)',
      type: 'string',
      description:
        'The skill\'s actual content. Free-form markdown — typically instructions for the agent. Can reference call args via Jinja-style placeholders (host-defined; not a hard executor contract).',
    },
  ],
  options: [
    {
      id: 'inline',
      label: 'Inline dispatch',
      description:
        'Skill body is appended to the current turn\'s prompt; no new session is spawned. Shares the parent\'s context, tools, and model. Cheapest mode.',
      bestFor: [
        'Templated transformations ("rephrase this in formal English")',
        'Quick lookups that don\'t need isolation',
        'High-frequency skills where session spawn overhead would dominate',
      ],
      avoidWhen: [
        'Sub-tasks that pollute the parent\'s context window',
        'Sub-tasks needing a different model tier',
      ],
    },
    {
      id: 'fork',
      label: 'Fork dispatch',
      description:
        'Skill spawns a fresh AgentSession with a typed contract. Isolated context, configurable model, return value flows back to parent as a string.',
      bestFor: [
        'Long-running sub-tasks (research, multi-step analysis)',
        'Tasks needing a different model tier (upgrade to Opus for hard reasoning, downgrade to Haiku for cheap classification)',
        'Anything that benefits from a clean context window',
      ],
      avoidWhen: [
        'High-frequency calls — session spawn cost adds up',
      ],
    },
  ],
  relatedSections: [
    {
      label: 'Stage 12 — Agent (orchestrator)',
      body: 'Stage 12 is what dispatches sub-agents (and hence skills in fork mode). The SubagentTypeRegistry binds skill names to typed contracts there.',
    },
    {
      label: 'Executor Built-in: agent + meta families',
      body: 'The Agent and ToolSearch built-ins are the primary surface for skill discovery and dispatch. Skills with tool whitelists set further narrow what the sub-agent can do.',
    },
    {
      label: 'MCP',
      body: 'MCP server prompts can be projected into the skill catalog via `mcp_prompts_to_skills(manager)` — the agent treats them as discoverable Skill entries.',
    },
  ],
  codeRef: 'geny-executor / src/geny_executor/skills/loader.py:SkillLoader',
};

const ko: SectionHelpContent = {
  title: '스킬 (호스트 레벨)',
  summary:
    'YAML frontmatter가 붙은 `SKILL.md` 파일로 정의되는 가벼운 워크플로. Skill 도구로 디스패치 — 인라인 (현재 턴 안에서 본문 실행) 또는 fork 모드 (typed sub-agent spawn). 호스트 스코프 카탈로그는 `~/.geny/skills/`와 프로젝트 레벨 `skills/`.',
  whatItDoes: `스킬은 재사용 가능한 에이전트 워크플로 — 프롬프트 템플릿과 sub-agent의 중간 어딘가. 각 스킬은 frontmatter가 있는 마크다운 파일:

\`\`\`markdown
---
name: code-review
description: Review a PR for security and style issues
tools: [Read, Grep, Bash]
model_override: claude-opus-4-7
---

당신은 시니어 리뷰어입니다. <args.pr_url>의 PR에 대해:
1. 보안 이슈 식별
2. 스타일 일관성 확인
...
\`\`\`

**Frontmatter 필드**:

- \`name\`: registry 키. 병합된 카탈로그 전체에서 unique.
- \`description\`: 한 줄 요약, ToolSearch와 LLM의 도구 선택 로직이 사용.
- \`tools\`: 선택적 허용목록 — 스킬 본문이 호출 가능한 도구 제한. \`null\` = 부모의 전체 toolset 상속.
- \`model_override\`: 선택적 모델 id — 부모와 다른 모델로 스킬 실행 (예: 어려운 sub-task에 무거운 모델).

**Dispatch 모드** (스킬 frontmatter에 설정 또는 호출 시 에이전트가 결정):

- **Inline**: 스킬 본문이 현재 턴의 프롬프트에 추가. 저렴, 컨텍스트 공유, 에이전트의 도구 사용 가능. "템플릿화된 것 줘" 워크플로에 최적.
- **Fork**: 스킬이 typed contract로 새 \`AgentSession\` spawn. 격리된 컨텍스트, 모델 설정 가능, 출력이 부모로 반환. 깨끗한 상태나 다른 모델 티어가 필요한 sub-task에 최적.

**카탈로그 발견** (세션 부팅 시):

1. \`~/.geny/skills/**/SKILL.md\` 스캔 (user 스코프).
2. \`./.geny/skills/**/SKILL.md\` 스캔 (project 스코프).
3. \`./skills/**/SKILL.md\` 있으면 스캔 (legacy / repo 공유).
4. 선택적으로 \`mcp_prompts_to_skills(manager)\`로 MCP 서버 프롬프트 브리지 — 각 프롬프트가 \`extras = {source: "mcp", server, prompt_name}\`인 Skill 레코드가 됨.

이름 충돌 시 project 스코프가 이김. 라이브러리 Skills 탭이 활성 스코프 편집.

**에이전트가 도달하는 방법**:

- \`Agent\` 빌트인 도구로 sub-agent를 spawn하고 dispatch instruction으로 스킬 이름 전달.
- \`Skill\` 빌트인 도구 (등록되어 있으면)로 이름과 선택적 args로 스킬 직접 호출.
- \`ToolSearch\`가 스킬을 발견 가능한 capability로 노출 — 에이전트가 이름을 알지 않고 description으로 발견.

**vs. 시스템 프롬프트**: 시스템 프롬프트는 모놀리식 (모든 턴에 한 블록). 스킬은 모듈러 (dispatch당 한 블록). 시스템 프롬프트는 정체성 / 하드 제약을 설정; 스킬은 이름 있는 워크플로를 패키징.`,
  configFields: [
    {
      name: 'name',
      label: 'name (frontmatter)',
      type: 'string',
      required: true,
      description:
        'Registry 키. 병합 카탈로그 전체에서 unique. 안정적 식별자 — 이름 변경 시 옛 이름을 참조하는 에이전트 / 훅 / cron 항목 깨짐.',
    },
    {
      name: 'description',
      label: 'description (frontmatter)',
      type: 'string',
      required: true,
      description:
        '한 줄 요약. ToolSearch와 스킬 리스팅으로 LLM에 노출 — 모델이 이 스킬 호출 여부 결정 시 보는 것.',
    },
    {
      name: 'tools',
      label: 'tools (frontmatter)',
      type: 'list[string]',
      description:
        '스킬 본문에 대한 선택적 도구 화이트리스트. Null은 부모의 전체 toolset 상속. Read / Grep만 하고 Write / Bash는 못하는 sub-agent로 잠그는 데 사용.',
    },
    {
      name: 'model_override',
      label: 'model_override (frontmatter)',
      type: 'string',
      description:
        '선택적 모델 id. 스킬을 부모보다 무겁거나 (싸게) 실행. fork 모드에서만 honoured — 인라인 스킬은 항상 부모 모델 공유.',
    },
    {
      name: 'extras',
      label: 'extras (frontmatter)',
      type: 'dict',
      description:
        '자유 형식 메타데이터. 훅 / tooling이 라우팅에 사용 — 예: MCP-projected 스킬은 여기에 `source: "mcp"`, `server`, `prompt_name` 보유.',
    },
    {
      name: 'body',
      label: 'body (markdown)',
      type: 'string',
      description:
        '스킬의 실제 콘텐츠. 자유 형식 마크다운 — 일반적으로 에이전트용 instruction. Jinja 스타일 placeholder로 호출 args 참조 가능 (호스트가 정의; 실행기의 hard contract 아님).',
    },
  ],
  options: [
    {
      id: 'inline',
      label: 'Inline dispatch',
      description:
        '스킬 본문이 현재 턴 프롬프트에 추가; 새 세션 spawn 안 함. 부모의 컨텍스트, 도구, 모델 공유. 가장 저렴.',
      bestFor: [
        '템플릿화된 변환 ("이걸 격식 있는 영어로 다시 표현")',
        '격리 필요 없는 빠른 lookup',
        '세션 spawn 오버헤드가 dominate할 고빈도 스킬',
      ],
      avoidWhen: [
        '부모의 컨텍스트 창을 오염시키는 sub-task',
        '다른 모델 티어가 필요한 sub-task',
      ],
    },
    {
      id: 'fork',
      label: 'Fork dispatch',
      description:
        '스킬이 typed contract로 새 AgentSession spawn. 격리된 컨텍스트, 설정 가능한 모델, 반환값이 string으로 부모에 흐름.',
      bestFor: [
        '장기 실행 sub-task (리서치, 멀티스텝 분석)',
        '다른 모델 티어가 필요한 작업 (어려운 추론에 Opus 업그레이드, 싼 분류에 Haiku 다운그레이드)',
        '깨끗한 컨텍스트 창이 도움되는 모든 것',
      ],
      avoidWhen: [
        '고빈도 호출 — 세션 spawn 비용이 누적',
      ],
    },
  ],
  relatedSections: [
    {
      label: '12단계 — Agent (orchestrator)',
      body: '12단계가 sub-agent를 dispatch (즉, fork 모드 스킬). 거기서 SubagentTypeRegistry가 스킬 이름을 typed contract와 바인딩.',
    },
    {
      label: 'Executor Built-in: agent + meta families',
      body: 'Agent와 ToolSearch 빌트인이 스킬 발견 / dispatch의 주 인터페이스. tool whitelist가 설정된 스킬은 sub-agent가 할 수 있는 것을 더 좁힘.',
    },
    {
      label: 'MCP',
      body: 'MCP 서버 프롬프트가 `mcp_prompts_to_skills(manager)`로 스킬 카탈로그에 투영 가능 — 에이전트가 발견 가능한 Skill 항목으로 다룸.',
    },
  ],
  codeRef: 'geny-executor / src/geny_executor/skills/loader.py:SkillLoader',
};

export const globalsSkillsHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
