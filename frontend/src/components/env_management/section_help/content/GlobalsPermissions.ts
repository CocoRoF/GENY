/**
 * Help content for Globals → Permissions panel.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Permissions (host-level)',
  summary:
    'Tool allow / deny / ask rules merged from `settings.json` at three scopes (user / project / local). Applied on top of the manifest\'s built-in selection — even a checked tool gets blocked if a deny rule matches.',
  whatItDoes: `Permissions are the host's policy layer. The executor's \`SettingsLoader\` reads three JSON files in scope order (later wins on conflict):

1. \`~/.geny/settings.json\` (user scope) — your own defaults.
2. \`./.geny/settings.json\` (project scope) — repo-shared defaults.
3. \`./.geny/settings.local.json\` (local scope) — uncommitted overrides.

Plus a fourth \`preset\` scope that's loaded from a curated bundle and sits beneath user.

**Rule shape** (\`PermissionEntry\`):

- \`tool\`: tool name (or glob like \`Bash\`, \`mcp.git.*\`).
- \`behaviour\`: one of \`allow\` / \`deny\` / \`ask\`.
- \`match\`: optional argument matcher (e.g., for Bash, \`{command: "rm -rf*"}\`).
- \`reason\`: free-text justification — surfaced in the audit log and the HITL prompt for \`ask\` rules.

**Evaluation**: at every tool dispatch, Stage 4's permission guard walks the merged rule list looking for the first match (specific over generic). The matched rule's behaviour decides:

- \`allow\` → dispatch proceeds.
- \`deny\` → dispatch blocked, agent gets a tool_result with \`is_error: true\` and the reason.
- \`ask\` → Stage 4 routes to Stage 15 HITL; the human approves / rejects, the decision is cached for the rest of the session (per a configurable TTL).

**No matching rule** = default permit. To run "deny by default", add a wildcard \`{tool: "*", behaviour: "deny"}\` at the bottom of user scope and explicit \`allow\` rules above it.

**Scope precedence** (\`local > project > user > preset\`):

- A \`local\` deny on \`Bash\` overrides a \`project\` allow.
- A \`project\` allow on \`Read\` overrides a \`user\` deny.
- A \`preset\` rule is the weakest — anything above it wins.

This is intentional so an operator can lock something down without editing committed files (\`local\` scope), and a project can establish baselines without each user re-configuring (\`project\` scope).

**vs. \`tools.global_allowlist\`/\`global_blocklist\` in the manifest**: the manifest fields are env-scoped allow/deny lists baked into the matnifest. Permissions are host-scoped policies that operate on top of whatever the manifest says. Both can deny — the union of denies wins.`,
  configFields: [
    {
      name: 'tool',
      label: 'tool',
      type: 'string (name or glob)',
      required: true,
      description:
        'Tool name to match. Supports trailing globs (`mcp.git.*`) and the wildcard `*` for "any tool".',
    },
    {
      name: 'behaviour',
      label: 'behaviour',
      type: 'enum (allow / deny / ask)',
      required: true,
      description:
        'allow: dispatch proceeds. deny: tool_result with is_error=true. ask: route through HITL for human approval.',
    },
    {
      name: 'match',
      label: 'match',
      type: 'dict (tool-specific)',
      description:
        'Argument matcher. Shape varies per tool — for Bash, `{command: glob}`; for Write, `{path: glob}`. See per-tool docs.',
    },
    {
      name: 'reason',
      label: 'reason',
      type: 'string',
      description:
        'Free-text justification. Shown in the audit log on every match and surfaced in the HITL prompt for `ask` rules.',
    },
    {
      name: 'scope',
      label: 'scope (file)',
      type: 'enum (user / project / local / preset)',
      description:
        'Implicitly determined by which settings.json file the rule lives in. Library UI lets you choose where to write.',
    },
  ],
  options: [
    {
      id: 'allow',
      label: 'allow',
      description:
        'Whitelist behaviour — the matched call is permitted. Use for explicit positive rules above a deny-by-default wildcard.',
      bestFor: [
        'Whitelisting a specific command pattern (e.g., `Bash{command: "git *"}` allowed)',
        'Override of a broader deny rule via more specific match',
      ],
    },
    {
      id: 'deny',
      label: 'deny',
      description:
        'Blacklist behaviour — the matched call is blocked, returns a tool_result error, never reaches the tool implementation. The agent sees the failure and can adjust.',
      bestFor: [
        'Hard bans (e.g., `Bash{command: "rm -rf *"}` denied)',
        'Compliance lock-downs (anything touching production secrets)',
      ],
    },
    {
      id: 'ask',
      label: 'ask',
      description:
        'Routes through Stage 15 HITL — Stage 4 pauses the loop and waits for human approval. Decisions cache for the rest of the session unless TTL is set.',
      bestFor: [
        'High-risk tools where contextual judgement matters (e.g., posting to public channels)',
        'Onboarding flows where you want a human in the loop until trust is built',
      ],
      avoidWhen: [
        'Headless runs without a HITL operator — the loop will deadlock',
      ],
    },
  ],
  relatedSections: [
    {
      label: 'Stage 4 — Guard',
      body: 'The permission guard inside Stage 4\'s chain is where these rules are evaluated. Position the guard early in the chain so denied calls don\'t consume budget.',
    },
    {
      label: 'Stage 15 — HITL',
      body: '`ask` rules route here for human approval. Configure a non-default requester (CallbackRequester / PipelineResumeRequester) for production deployments.',
    },
    {
      label: 'Hooks',
      body: 'Hooks observe; permissions decide. Pair them — a `pre_tool_use` hook can audit every dispatch even when permissions allow it.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/settings/loader.py:SettingsLoader',
};

const ko: SectionHelpContent = {
  title: '권한 (호스트 레벨)',
  summary:
    '`settings.json`의 도구 allow / deny / ask 규칙을 user / project / local 세 스코프로 병합. 매니페스트의 빌트인 선택 위에 덮어 씌워져, 체크된 도구라도 deny 규칙에 걸리면 차단.',
  whatItDoes: `Permissions는 호스트의 정책 레이어. 실행기의 \`SettingsLoader\`가 스코프 순서로 세 JSON 파일을 읽음 (충돌 시 뒤쪽이 이김):

1. \`~/.geny/settings.json\` (user 스코프) — 개인 기본값.
2. \`./.geny/settings.json\` (project 스코프) — repo 공유 기본값.
3. \`./.geny/settings.local.json\` (local 스코프) — 커밋 안 된 override.

추가로 \`preset\` 스코프가 큐레이션 번들에서 로드, user 아래에 위치.

**규칙 형태** (\`PermissionEntry\`):

- \`tool\`: 도구 이름 (또는 \`Bash\`, \`mcp.git.*\` 같은 glob).
- \`behaviour\`: \`allow\` / \`deny\` / \`ask\` 중 하나.
- \`match\`: 선택적 인자 matcher (예: Bash는 \`{command: "rm -rf*"}\`).
- \`reason\`: 자유 텍스트 정당화 — audit log와 \`ask\` 규칙의 HITL prompt에 노출.

**평가**: 모든 도구 dispatch에서, 4단계 permission guard가 병합된 규칙 리스트를 walk하며 첫 매칭 (구체적인 것이 일반적인 것을 이김) 찾기. 매칭된 규칙의 behaviour가 결정:

- \`allow\` → dispatch 진행.
- \`deny\` → dispatch 차단, 에이전트는 \`is_error: true\`인 tool_result + reason 받음.
- \`ask\` → 4단계가 15단계 HITL로 라우팅; 사람이 승인 / 거부, 결정은 세션 나머지 동안 캐시 (TTL 설정 가능).

**매칭 규칙 없음** = 기본 허용. "기본 거부"로 운영하려면 user 스코프 맨 아래에 \`{tool: "*", behaviour: "deny"}\` 와일드카드 추가, 위에 명시적 \`allow\` 규칙들.

**스코프 우선순위** (\`local > project > user > preset\`):

- \`local\`의 \`Bash\` deny가 \`project\`의 allow를 override.
- \`project\`의 \`Read\` allow가 \`user\`의 deny를 override.
- \`preset\` 규칙이 가장 약함 — 위의 어떤 것도 이김.

의도적인 설계 — operator가 커밋된 파일을 안 건드리고 잠가야 할 때 (\`local\` 스코프), 프로젝트가 사용자별 재설정 없이 baseline 확립할 때 (\`project\` 스코프).

**vs. 매니페스트의 \`tools.global_allowlist\` / \`global_blocklist\`**: 매니페스트 필드는 매니페스트에 박힌 환경 스코프 allow/deny 리스트. Permissions는 매니페스트가 뭐라 하든 그 위에서 동작하는 호스트 스코프 정책. 둘 다 deny 가능 — deny들의 합집합이 이김.`,
  configFields: [
    {
      name: 'tool',
      label: 'tool',
      type: 'string (이름 또는 glob)',
      required: true,
      description:
        '매칭할 도구 이름. 후행 glob (`mcp.git.*`)과 "모든 도구"용 와일드카드 `*` 지원.',
    },
    {
      name: 'behaviour',
      label: 'behaviour',
      type: 'enum (allow / deny / ask)',
      required: true,
      description:
        'allow: dispatch 진행. deny: is_error=true인 tool_result. ask: 사람 승인을 위해 HITL로 라우팅.',
    },
    {
      name: 'match',
      label: 'match',
      type: 'dict (도구별)',
      description:
        '인자 matcher. 도구별 형태 다름 — Bash는 `{command: glob}`; Write는 `{path: glob}`. 도구별 문서 참고.',
    },
    {
      name: 'reason',
      label: 'reason',
      type: 'string',
      description:
        '자유 텍스트 정당화. 모든 매칭에 대해 audit log에 표시되고, `ask` 규칙의 HITL prompt에 노출.',
    },
    {
      name: 'scope',
      label: 'scope (파일)',
      type: 'enum (user / project / local / preset)',
      description:
        '규칙이 들어 있는 settings.json 파일에 의해 암묵적으로 결정. 라이브러리 UI에서 어디에 쓸지 선택 가능.',
    },
  ],
  options: [
    {
      id: 'allow',
      label: 'allow',
      description:
        'Whitelist 동작 — 매칭된 호출 허용. deny-by-default 와일드카드 위에서 명시적 positive 규칙으로 사용.',
      bestFor: [
        '특정 명령 패턴 화이트리스팅 (예: `Bash{command: "git *"}` 허용)',
        '더 구체적인 match로 광범위한 deny 규칙 override',
      ],
    },
    {
      id: 'deny',
      label: 'deny',
      description:
        'Blacklist 동작 — 매칭된 호출 차단, tool_result 에러 반환, 도구 구현에 도달하지 않음. 에이전트는 실패 보고 조정 가능.',
      bestFor: [
        'Hard bans (예: `Bash{command: "rm -rf *"}` 거부)',
        '컴플라이언스 잠금 (운영 비밀 건드리는 모든 것)',
      ],
    },
    {
      id: 'ask',
      label: 'ask',
      description:
        '15단계 HITL로 라우팅 — 4단계가 루프 일시 정지, 사람 승인 대기. 결정은 TTL 미설정 시 세션 나머지 동안 캐시.',
      bestFor: [
        '맥락 판단이 중요한 고위험 도구 (예: 공개 채널 포스팅)',
        '신뢰 형성 전 사람이 in the loop인 온보딩 흐름',
      ],
      avoidWhen: [
        'HITL operator 없는 헤드리스 실행 — 루프 데드락',
      ],
    },
  ],
  relatedSections: [
    {
      label: '4단계 — Guard',
      body: '4단계 체인의 permission guard에서 이 규칙들이 평가됨. guard를 체인 앞쪽에 배치해 거부된 호출이 예산을 소비하지 않도록.',
    },
    {
      label: '15단계 — HITL',
      body: '`ask` 규칙이 사람 승인을 위해 여기로 라우팅. 운영 배포에선 비-default requester (CallbackRequester / PipelineResumeRequester) 설정.',
    },
    {
      label: '훅',
      body: '훅은 관찰; permissions는 결정. 함께 사용 — `pre_tool_use` 훅이 permissions가 허용하는 dispatch도 모두 audit 가능.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/settings/loader.py:SettingsLoader',
};

export const globalsPermissionsHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
