/** Tool detail — Config (executor / operator family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `Config reads and writes Geny host settings — \`settings.json\` files plus a curated set of registered runtime knobs (LSP enable, hook gate, executor flags, etc.). Designed for self-administering agents that need to inspect or adjust their own environment without going through manual UI clicks.

Operations:
  - \`get\`: read a setting by dotted path (e.g., \`permissions.executor_mode\`)
  - \`set\`: write a setting; the executor reloads the relevant subsystem (SettingsLoader, hook gate, etc.) so the change takes effect immediately
  - \`list\`: enumerate all known settings within a section (e.g., \`permissions\`, \`hooks\`, \`executor\`)

Scope follows the SettingsLoader hierarchy: \`local\` > \`project\` > \`user\` > \`preset\`. Config defaults to \`user\` scope on writes; pass \`scope: "local"\` to write the temporary uncommitted override file.

This is one of the most powerful tools — a misconfigured Config call can disable hooks, lower permission strictness, or change executor mode globally. Lock it down with permissions in deployments where the agent shouldn't reconfigure itself. Stage 11 tool review can flag every Config write for HITL approval.`,
  bestFor: [
    'Self-tuning agents adjusting their own runtime knobs',
    'Quick "what is the current setting for X?" queries',
    'Migration / setup workflows that need to write a batch of settings',
  ],
  avoidWhen: [
    'You shouldn\'t be reconfiguring at runtime — Config in a locked-down env is a foot-gun',
    'You need to write a manifest file — that\'s a manifest editor concern, not a settings concern',
  ],
  gotchas: [
    'A Config set on a permission rule takes effect IMMEDIATELY for the next tool call. The agent might suddenly find itself blocked.',
    'Setting an unknown path returns success silently in some host implementations — verify with `get` if you need confirmation.',
    'Local scope is uncommitted; project scope is committed. Choosing the wrong scope can leak local-only state into git or vice versa.',
    'Config writes are audited if hooks are enabled (`pre_tool_use` event with tool=Config).',
  ],
  examples: [
    {
      caption: 'Read the current permission mode',
      body: `{
  "operation": "get",
  "path": "permissions.mode"
}`,
      note: 'Returns the resolved value (e.g., "advisory") — the result of the SettingsLoader merge.',
    },
  ],
  relatedTools: ['Monitor', 'Bash'],
  relatedStages: [
    'Stage 4 (Permission guard)',
    'Stage 11 (Tool review)',
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/config_tool.py:ConfigTool',
};

const ko: ToolDetailContent = {
  body: `Config는 Geny 호스트 설정을 읽고 씁니다 — \`settings.json\` 파일들과 등록된 런타임 노브 큐레이션 세트(LSP enable, hook gate, executor 플래그 등). UI 클릭 없이 자신의 환경을 검사하거나 조정해야 하는 셀프 관리 에이전트용으로 설계.

연산:
  - \`get\`: dotted path로 설정 읽기(예: \`permissions.executor_mode\`)
  - \`set\`: 설정 쓰기; 실행기가 관련 서브시스템(SettingsLoader, hook gate 등) 리로드 — 변경 즉시 발효
  - \`list\`: 섹션 내 알려진 모든 설정 enumerate(예: \`permissions\`, \`hooks\`, \`executor\`)

스코프는 SettingsLoader 계층 따름: \`local\` > \`project\` > \`user\` > \`preset\`. Config는 쓰기 시 기본 \`user\` 스코프; \`scope: "local"\` 전달로 임시 커밋 안 된 override 파일 쓰기.

가장 강력한 도구 중 하나 — 잘못 설정된 Config 호출이 훅 비활성화, permission strictness 하향, executor 모드 전역 변경 가능. 에이전트가 스스로 재구성 안 해야 하는 배포는 permissions로 잠그기. 11단계 tool review가 모든 Config 쓰기를 HITL 승인 플래그 가능.`,
  bestFor: [
    '자신의 런타임 노브 조정하는 셀프 튜닝 에이전트',
    '"X의 현재 설정?" 빠른 쿼리',
    '설정 배치 쓰기 필요한 마이그레이션 / 셋업 워크플로',
  ],
  avoidWhen: [
    '런타임에 재구성하면 안 되는 경우 — 잠긴 환경의 Config는 foot-gun',
    '매니페스트 파일 쓰기 필요 — 그건 매니페스트 에디터 관심사, settings 아님',
  ],
  gotchas: [
    'permission 규칙에 Config set은 다음 도구 호출에 즉시 발효. 에이전트가 갑자기 차단될 수 있음.',
    '일부 호스트 구현은 알려지지 않은 path set을 silent하게 성공 반환 — 확인 필요시 `get`으로 검증.',
    'Local 스코프는 커밋 안 됨; project 스코프는 커밋됨. 잘못된 스코프 선택은 로컬 전용 상태를 git에 누출 또는 그 반대.',
    '훅 활성 시 Config 쓰기 audit됨(`pre_tool_use` 이벤트 with tool=Config).',
  ],
  examples: [
    {
      caption: '현재 permission 모드 읽기',
      body: `{
  "operation": "get",
  "path": "permissions.mode"
}`,
      note: '해결된 값 반환(예: "advisory") — SettingsLoader 병합 결과.',
    },
  ],
  relatedTools: ['Monitor', 'Bash'],
  relatedStages: [
    '4단계 (Permission guard)',
    '11단계 (Tool review)',
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/config_tool.py:ConfigTool',
};

export const configToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
