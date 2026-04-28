/**
 * Help content for Globals → Hooks panel.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Hooks (host-level)',
  summary:
    'Pre/post-event hooks defined in `.geny/hooks.yaml`. Every matching event fires registered commands as out-of-process subprocesses. Host-scoped — shared across every environment, NOT per-manifest.',
  whatItDoes: `Hooks are the executor's audit / interception surface. When something happens (a tool is about to be called, a session is starting, HITL is waiting), the executor looks up registered hooks for that event, spawns each one as a subprocess, passes the event payload over stdin as JSON, and waits for them to finish (or times out per entry).

**Two-gate activation**: a hook is loaded if its YAML entry has \`enabled: true\` (file-level) AND the host process is started with \`GENY_ALLOW_HOOKS=1\` in its env. Both must be set for any hook to fire — defence in depth so a forgotten YAML doesn't silently launch processes.

**16 event types** (lowercased \`HookEvent\` values):

- Tool lifecycle: \`pre_tool_use\`, \`post_tool_use\`, \`tool_error\`
- Session lifecycle: \`session_start\`, \`session_end\`, \`session_error\`
- Turn lifecycle: \`pre_turn\`, \`post_turn\`
- LLM call: \`pre_api_call\`, \`post_api_call\`, \`api_error\`
- HITL: \`pre_hitl_request\`, \`post_hitl_response\`
- Stage events: \`stage_enter\`, \`stage_exit\`, \`stage_error\`

**Match dict**: each entry has an optional \`match\` filter — currently the only honoured key is \`tool\` (matches against the tool name for tool events). \`match: {tool: "Bash"}\` means "fire only on Bash tool events". Empty match = fire on every event of that type.

**Why host-scoped?** Hooks frequently shell out to long-lived host services (audit log writers, alerting bridges, slack relays). Per-environment hooks would either duplicate that infra or split it awkwardly. Keeping hooks host-scoped means one set of operational tooling regardless of which environment the agent is running.

**File location**: \`~/.geny/hooks.yaml\` (user scope) and \`.geny/hooks.yaml\` (project scope). Project scope wins on conflicts. The Library Hooks tab edits the active file.

**Common patterns**:

- **Audit log mirror**: \`pre_tool_use\` hook posting tool args to an audit DB.
- **Slack relay**: \`pre_hitl_request\` hook pinging the on-call channel.
- **Quota enforcement**: \`pre_api_call\` hook checking a rate-limit cache; non-zero exit blocks the call.
- **Diff capture**: \`pre_tool_use\` hook on \`Write\` / \`Edit\` capturing \`git diff\` for later replay.

A non-zero exit code from a hook blocks the event in pre-* hooks (the agent gets an error) and is logged-but-ignored in post-* hooks.`,
  configFields: [
    {
      name: 'event',
      label: 'event',
      type: 'enum (16 values)',
      required: true,
      description:
        'Which lifecycle event triggers this hook. See the 16 values in `geny_executor.hooks.types.HookEvent`.',
    },
    {
      name: 'command',
      label: 'command',
      type: 'string',
      required: true,
      description:
        'Single executable to invoke. Args go in the separate args field. Receives the event payload as JSON on stdin.',
    },
    {
      name: 'args',
      label: 'args',
      type: 'list[string]',
      description:
        'Command-line arguments. One per element.',
    },
    {
      name: 'match',
      label: 'match',
      type: 'dict[string, string]',
      description:
        'Filter expression. Currently only `tool` is honoured (matches tool name for tool events). Empty match = always fire.',
    },
    {
      name: 'env',
      label: 'env',
      type: 'dict[string, string]',
      description:
        'Per-hook env vars merged on top of the host process env.',
    },
    {
      name: 'working_dir',
      label: 'working_dir',
      type: 'string',
      description:
        'CWD for the hook subprocess. Defaults to the executor process CWD.',
    },
    {
      name: 'timeout_ms',
      label: 'timeout_ms',
      type: 'integer',
      description:
        'Hook subprocess timeout. Past this, the executor SIGTERMs the hook and treats the event as if the hook didn\'t exist.',
    },
    {
      name: 'enabled',
      label: 'enabled (per entry)',
      type: 'boolean',
      default: 'true',
      description:
        'File-level on/off. Combine with env-level GENY_ALLOW_HOOKS=1 — both must be set for the hook to fire.',
    },
    {
      name: 'audit_log_path',
      label: 'audit_log_path (top-level)',
      type: 'string',
      description:
        'Where the executor writes the rolling hook-fire audit log. Top-level field of hooks.yaml, not per-entry.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Permissions',
      body: 'Permissions are policy-level (rule sets evaluated by Stage 4); hooks are observation-level (subprocess fires per event). Use permissions for "should this happen", hooks for "tell me when this happens".',
    },
    {
      label: 'Stage 11 — Tool review',
      body: 'Stage 11 is in-process safety review. Hooks are out-of-process and host-controlled. Stage 11 can route flagged calls to HITL; hooks can send the same call to a SIEM.',
    },
    {
      label: 'Stage 15 — HITL',
      body: 'When HITL fires, both `pre_hitl_request` and `post_hitl_response` hook events are emitted — useful for audit trails and Slack relays.',
    },
  ],
  codeRef: 'geny-executor / src/geny_executor/hooks/loader.py:HookLoader',
};

const ko: SectionHelpContent = {
  title: '훅 (호스트 레벨)',
  summary:
    '`.geny/hooks.yaml`에 정의된 pre/post 이벤트 훅. 매칭되는 모든 이벤트가 등록된 명령을 out-of-process 서브프로세스로 발화. 호스트 스코프 — 모든 환경에서 공유, 매니페스트별 아님.',
  whatItDoes: `훅은 실행기의 audit / interception 인터페이스. 무언가 일어나면 (도구 호출 직전, 세션 시작, HITL 대기 중 등), 실행기가 해당 이벤트의 등록 훅을 조회, 각각을 서브프로세스로 spawn, 이벤트 페이로드를 stdin에 JSON으로 전달, 끝나거나 timeout될 때까지 대기.

**2단계 게이트 활성화**: 훅이 로드되려면 YAML 항목에 \`enabled: true\` (파일 레벨) AND 호스트 프로세스가 env에 \`GENY_ALLOW_HOOKS=1\`을 가지고 시작되어야 함. 둘 다 켜져야 발화 — 잊혀진 YAML이 silent하게 프로세스를 launch하지 못하도록 defence in depth.

**16종 이벤트 타입** (소문자 \`HookEvent\` 값):

- 도구 라이프사이클: \`pre_tool_use\`, \`post_tool_use\`, \`tool_error\`
- 세션 라이프사이클: \`session_start\`, \`session_end\`, \`session_error\`
- 턴 라이프사이클: \`pre_turn\`, \`post_turn\`
- LLM 호출: \`pre_api_call\`, \`post_api_call\`, \`api_error\`
- HITL: \`pre_hitl_request\`, \`post_hitl_response\`
- 단계 이벤트: \`stage_enter\`, \`stage_exit\`, \`stage_error\`

**Match dict**: 각 항목에 선택적 \`match\` 필터 — 현재 honoured되는 키는 \`tool\`만 (도구 이벤트에 대해 도구 이름과 매칭). \`match: {tool: "Bash"}\`는 "Bash 도구 이벤트에만 발화". 빈 match = 해당 타입의 모든 이벤트에 발화.

**왜 호스트 스코프?** 훅은 자주 장기 호스트 서비스 (audit log writer, alerting bridge, slack relay)로 shell out. 환경별 훅은 그런 인프라를 중복하거나 어색하게 분할. 호스트 스코프 유지는 어떤 환경에서 에이전트가 돌든 한 세트의 operational tooling을 의미.

**파일 위치**: \`~/.geny/hooks.yaml\` (user 스코프)와 \`.geny/hooks.yaml\` (project 스코프). 충돌 시 project scope가 이김. 라이브러리 Hooks 탭이 활성 파일을 편집.

**자주 쓰는 패턴**:

- **Audit log mirror**: \`pre_tool_use\` 훅이 도구 args를 audit DB에 포스팅.
- **Slack relay**: \`pre_hitl_request\` 훅이 on-call 채널에 ping.
- **할당량 강제**: \`pre_api_call\` 훅이 rate-limit 캐시 확인; non-zero exit이 호출 차단.
- **Diff 캡처**: \`Write\` / \`Edit\`의 \`pre_tool_use\` 훅이 \`git diff\`를 캡처해 나중에 replay.

훅의 non-zero exit code는 pre-* 훅에선 이벤트를 차단 (에이전트가 에러 받음), post-* 훅에선 logged-but-ignored.`,
  configFields: [
    {
      name: 'event',
      label: 'event',
      type: 'enum (16종)',
      required: true,
      description:
        '훅을 트리거하는 라이프사이클 이벤트. `geny_executor.hooks.types.HookEvent`의 16개 값 참고.',
    },
    {
      name: 'command',
      label: 'command',
      type: 'string',
      required: true,
      description:
        '호출할 단일 실행파일. Args는 별도 args 필드로. 이벤트 페이로드를 stdin에 JSON으로 받음.',
    },
    {
      name: 'args',
      label: 'args',
      type: 'list[string]',
      description:
        'Command-line 인자. 항목당 하나.',
    },
    {
      name: 'match',
      label: 'match',
      type: 'dict[string, string]',
      description:
        '필터 표현식. 현재 `tool`만 honoured (도구 이벤트에서 도구 이름 매칭). 빈 match = 항상 발화.',
    },
    {
      name: 'env',
      label: 'env',
      type: 'dict[string, string]',
      description:
        '훅별 env 변수, 호스트 프로세스 env 위에 병합.',
    },
    {
      name: 'working_dir',
      label: 'working_dir',
      type: 'string',
      description:
        '훅 서브프로세스의 CWD. 기본값은 실행기 프로세스 CWD.',
    },
    {
      name: 'timeout_ms',
      label: 'timeout_ms',
      type: 'integer',
      description:
        '훅 서브프로세스 timeout. 초과 시 실행기가 SIGTERM, 훅이 없었던 것처럼 이벤트 처리.',
    },
    {
      name: 'enabled',
      label: 'enabled (항목별)',
      type: 'boolean',
      default: 'true',
      description:
        '파일 레벨 on/off. env 레벨 GENY_ALLOW_HOOKS=1과 함께 — 훅이 발화하려면 둘 다 필요.',
    },
    {
      name: 'audit_log_path',
      label: 'audit_log_path (최상위)',
      type: 'string',
      description:
        '실행기가 rolling 훅 발화 audit log를 쓰는 곳. hooks.yaml의 최상위 필드, 항목별 아님.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: '권한',
      body: 'Permissions는 정책 레벨 (4단계가 평가하는 규칙 집합); 훅은 관찰 레벨 (이벤트당 서브프로세스 발화). "이게 일어나야 하나"는 permissions로, "이게 일어나면 알려줘"는 훅으로.',
    },
    {
      label: '11단계 — Tool review',
      body: '11단계는 in-process 안전성 검토. 훅은 out-of-process이고 호스트 컨트롤. 11단계는 플래그된 호출을 HITL로 라우팅; 훅은 같은 호출을 SIEM으로 보낼 수 있음.',
    },
    {
      label: '15단계 — HITL',
      body: 'HITL이 발화하면 `pre_hitl_request`와 `post_hitl_response` 훅 이벤트가 모두 emit — audit trail과 Slack relay에 유용.',
    },
  ],
  codeRef: 'geny-executor / src/geny_executor/hooks/loader.py:HookLoader',
};

export const globalsHooksHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
